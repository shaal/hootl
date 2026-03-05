import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { autoInit } from "../init.js";
import { ConfigSchema } from "../config.js";

describe("autoInit", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-auto-init-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .hootl/ structure when directory does not exist", async () => {
    assert.equal(existsSync(join(tmpDir, ".hootl")), false);

    await autoInit();

    // Directories exist
    const tasksDir = await stat(join(tmpDir, ".hootl", "tasks"));
    assert.ok(tasksDir.isDirectory());

    const logsDir = await stat(join(tmpDir, ".hootl", "logs"));
    assert.ok(logsDir.isDirectory());

    // config.json exists and is valid
    const configContent = await readFile(
      join(tmpDir, ".hootl", "config.json"),
      "utf-8",
    );
    const parsed = ConfigSchema.parse(JSON.parse(configContent));
    assert.equal(parsed.taskBackend, "local");
    assert.equal(parsed.budgets.perSession, 0.5);

    // .gitignore exists with expected content
    const gitignore = await readFile(
      join(tmpDir, ".hootl", ".gitignore"),
      "utf-8",
    );
    assert.ok(gitignore.includes("tasks/"));
    assert.ok(gitignore.includes("logs/"));
    assert.ok(gitignore.includes("status.md"));
  });

  it("is a no-op when .hootl/ already exists", async () => {
    // First call creates everything
    await autoInit();

    const configPath = join(tmpDir, ".hootl", "config.json");
    const originalContent = await readFile(configPath, "utf-8");
    const originalMtime = (await stat(configPath)).mtimeMs;

    // Small delay to ensure mtime would differ if file were rewritten
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second call should be a no-op
    await autoInit();

    const afterContent = await readFile(configPath, "utf-8");
    const afterMtime = (await stat(configPath)).mtimeMs;

    assert.equal(afterContent, originalContent);
    assert.equal(afterMtime, originalMtime);
  });

  it("created config.json parses with ConfigSchema defaults", async () => {
    await autoInit();

    const configContent = await readFile(
      join(tmpDir, ".hootl", "config.json"),
      "utf-8",
    );
    const config = ConfigSchema.parse(JSON.parse(configContent));

    assert.equal(config.confidence.target, 95);
    assert.equal(config.confidence.requireTests, true);
    assert.equal(config.git.useWorktrees, false);
    assert.equal(config.git.branchPrefix, "hootl/");
    assert.equal(config.budgets.maxAttemptsPerTask, 10);
    assert.equal(config.notifications.summaryFile, true);
  });

  it("non-interactive (default) writes empty hooks array", async () => {
    await autoInit();

    const configContent = await readFile(
      join(tmpDir, ".hootl", "config.json"),
      "utf-8",
    );
    const config = ConfigSchema.parse(JSON.parse(configContent));
    assert.deepEqual(config.hooks, []);
  });

  it("non-interactive still creates hooks-example.json", async () => {
    await autoInit();

    const examplePath = join(tmpDir, ".hootl", "hooks-example.json");
    assert.ok(existsSync(examplePath));

    const content = JSON.parse(await readFile(examplePath, "utf-8"));
    assert.ok(Array.isArray(content.available_triggers));
    assert.ok(Array.isArray(content.examples));
  });

  it("interactive with accepted hook writes simplify hook to config", async () => {
    await autoInit({
      interactive: true,
      confirm: async () => true,
    });

    const configContent = await readFile(
      join(tmpDir, ".hootl", "config.json"),
      "utf-8",
    );
    const config = ConfigSchema.parse(JSON.parse(configContent));

    assert.equal(config.hooks.length, 1);
    const hook = config.hooks[0]!;
    assert.equal(hook.trigger, "on_confidence_met");
    assert.equal(hook.skill, "simplify");
    assert.equal(hook.blocking, true);
  });

  it("interactive with declined hook writes empty hooks array", async () => {
    await autoInit({
      interactive: true,
      confirm: async () => false,
    });

    const configContent = await readFile(
      join(tmpDir, ".hootl", "config.json"),
      "utf-8",
    );
    const config = ConfigSchema.parse(JSON.parse(configContent));
    assert.deepEqual(config.hooks, []);
  });

  it("interactive confirm receives the expected question text", async () => {
    let receivedQuestion = "";
    await autoInit({
      interactive: true,
      confirm: async (q) => {
        receivedQuestion = q;
        return false;
      },
    });

    assert.ok(receivedQuestion.includes("simplify"));
    assert.ok(receivedQuestion.includes("hook"));
  });

  it("hooks-example.json contains all four trigger points", async () => {
    await autoInit();

    const content = JSON.parse(
      await readFile(join(tmpDir, ".hootl", "hooks-example.json"), "utf-8"),
    );

    const triggers = content.available_triggers as string[];
    assert.ok(triggers.some((t: string) => t.includes("on_confidence_met")));
    assert.ok(triggers.some((t: string) => t.includes("on_review_complete")));
    assert.ok(triggers.some((t: string) => t.includes("on_blocked")));
    assert.ok(triggers.some((t: string) => t.includes("on_execute_start")));
  });

  it("hooks-example.json documents all hook fields", async () => {
    await autoInit();

    const content = JSON.parse(
      await readFile(join(tmpDir, ".hootl", "hooks-example.json"), "utf-8"),
    );

    const fields = content.hook_fields;
    assert.ok(fields.trigger);
    assert.ok(fields.skill);
    assert.ok(fields.prompt);
    assert.ok(fields.blocking);
    assert.ok(fields.conditions);
    assert.ok(fields.conditions.minConfidence);
  });

  it("hooks-example.json contains multiple example configurations", async () => {
    await autoInit();

    const content = JSON.parse(
      await readFile(join(tmpDir, ".hootl", "hooks-example.json"), "utf-8"),
    );

    assert.ok(content.examples.length >= 3);
    // Verify examples cover different triggers
    const exampleTriggers = content.examples.map(
      (e: { trigger: string }) => e.trigger,
    );
    assert.ok(exampleTriggers.includes("on_confidence_met"));
    assert.ok(exampleTriggers.includes("on_review_complete"));
    assert.ok(exampleTriggers.includes("on_execute_start"));
  });
});
