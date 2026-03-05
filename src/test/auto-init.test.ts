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
});
