/**
 * Tests for raw output logging (saveRawOutput).
 *
 * Unit tests verify the helper creates correct paths, writes exact content,
 * and handles errors gracefully. Integration test runs a full completion loop
 * with a fake claude binary and verifies all expected log files exist with
 * correct content in the task's logs/ directory.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { saveRawOutput } from "../raw-output.js";
import { runCompletionLoop } from "../loop.js";
import { ConfigSchema } from "../config.js";
import { LocalTaskBackend } from "../tasks/local.js";
import { _setSessionId, getSessionId } from "../logger.js";
import { randomUUID } from "node:crypto";

describe("saveRawOutput unit tests", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-raw-output-unit-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the logs/ subdirectory and writes the file", async () => {
    const taskDir = join(tmpDir, "task-unit-1");
    await mkdir(taskDir, { recursive: true });

    await saveRawOutput(taskDir, "plan", 1, "This is the raw plan output");

    const logsDir = join(taskDir, "logs");
    // Verify logs/ dir was created
    await access(logsDir); // throws if missing
    // Verify file content
    const content = await readFile(join(logsDir, "plan-1.txt"), "utf-8");
    assert.equal(content, "This is the raw plan output");
  });

  it("uses correct filename pattern for various phases", async () => {
    const taskDir = join(tmpDir, "task-unit-2");
    await mkdir(taskDir, { recursive: true });

    await saveRawOutput(taskDir, "execute", 2, "execute output");
    await saveRawOutput(taskDir, "review", 3, "review output");
    await saveRawOutput(taskDir, "preflight", 0, "preflight output");
    await saveRawOutput(taskDir, "re-verify", 1, "re-verify output");
    await saveRawOutput(taskDir, "hook-on_confidence_met", 0, "hook output");

    assert.equal(
      await readFile(join(taskDir, "logs", "execute-2.txt"), "utf-8"),
      "execute output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "review-3.txt"), "utf-8"),
      "review output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "preflight-0.txt"), "utf-8"),
      "preflight output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "re-verify-1.txt"), "utf-8"),
      "re-verify output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "hook-on_confidence_met-0.txt"), "utf-8"),
      "hook output",
    );
  });

  it("writes output verbatim without modification", async () => {
    const taskDir = join(tmpDir, "task-unit-3");
    await mkdir(taskDir, { recursive: true });

    // Include special characters, newlines, JSON, unicode
    const rawOutput = '{"confidence": 96}\n\nLine 2\n\t\tTabbed\n🚀 emoji\n\0null byte';
    await saveRawOutput(taskDir, "review", 1, rawOutput);

    const content = await readFile(join(taskDir, "logs", "review-1.txt"), "utf-8");
    assert.equal(content, rawOutput);
  });

  it("does not throw when the write fails (graceful degradation)", async () => {
    // Point to a path that can't be created (nested under a file, not a directory)
    const blockingFile = join(tmpDir, "not-a-dir");
    await writeFile(blockingFile, "I am a file");
    const badTaskDir = join(blockingFile, "nested", "task");

    // Should not throw — silently catches the error
    await saveRawOutput(badTaskDir, "plan", 1, "should not crash");
  });

  it("overwrites existing file on same phase+attempt", async () => {
    const taskDir = join(tmpDir, "task-unit-4");
    await mkdir(taskDir, { recursive: true });

    await saveRawOutput(taskDir, "plan", 1, "first attempt output");
    await saveRawOutput(taskDir, "plan", 1, "overwritten output");

    const content = await readFile(join(taskDir, "logs", "plan-1.txt"), "utf-8");
    assert.equal(content, "overwritten output");
  });

  it("handles concurrent calls with recursive mkdir safely", async () => {
    const taskDir = join(tmpDir, "task-unit-5");
    await mkdir(taskDir, { recursive: true });

    // Run multiple saves concurrently — mkdir({ recursive: true }) is idempotent
    await Promise.all([
      saveRawOutput(taskDir, "plan", 1, "plan output"),
      saveRawOutput(taskDir, "execute", 1, "execute output"),
      saveRawOutput(taskDir, "review", 1, "review output"),
    ]);

    assert.equal(
      await readFile(join(taskDir, "logs", "plan-1.txt"), "utf-8"),
      "plan output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "execute-1.txt"), "utf-8"),
      "execute output",
    );
    assert.equal(
      await readFile(join(taskDir, "logs", "review-1.txt"), "utf-8"),
      "review output",
    );
  });
});

describe("raw output logging integration (runCompletionLoop)", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;
  let originalSessionId: string;

  // Known fake claude outputs — these are the raw `result` strings before JSON envelope wrapping
  const PLAN_OUTPUT = "## Plan\\n\\n1. Implement the feature\\n2. Add tests";
  const EXECUTE_OUTPUT = "## Progress\\n\\nImplemented the feature. All tests pass.";
  const REVIEW_OUTPUT_OBJ = {
    confidence: 96,
    summary: "All good",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
  };
  const HOOK_OUTPUT_OBJ = { pass: true, issues: [], remediationActions: [] };

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";
    originalSessionId = getSessionId();

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-raw-output-integ-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake `claude` executable — tracks call count via an external state file.
    // Returns controlled responses for each phase:
    //   Call 1: plan response
    //   Call 2: execute response (also creates feature.txt for branch diff)
    //   Call 3: commit message generation (triggered by feature.txt change)
    //   Call 4: review response with confidence 96% (above default 95% target)
    //   Call 5+: hook response (pass: true, no fixes)
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

let result;
if (count === 1) {
  result = "${PLAN_OUTPUT}";
} else if (count === 2) {
  // Create a file change so the branch has a diff (triggers hooks instead of skipping)
  fs.writeFileSync(path.join(process.cwd(), "feature.txt"), "implemented");
  result = "${EXECUTE_OUTPUT}";
} else if (count === 3) {
  // generateCommitMessage() calls invokeClaude after execute creates feature.txt
  result = "Add feature implementation";
} else if (count === 4) {
  result = JSON.stringify(${JSON.stringify(REVIEW_OUTPUT_OBJ)});
} else {
  result = JSON.stringify(${JSON.stringify(HOOK_OUTPUT_OBJ)});
}

process.stdout.write(JSON.stringify({
  result,
  total_cost_usd: 0.01,
  context_window_percent: 10,
}));
`;
    await writeFile(join(fakeBinDir, "claude"), fakeClaude, { mode: 0o755 });

    // Real git repo
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
    await writeFile(join(tmpDir, ".gitignore"), ".hootl/\nfake-bin/\n");
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "init"], { cwd: tmpDir });

    process.chdir(tmpDir);
    process.env["PATH"] = `${fakeBinDir}:${originalPath}`;
  });

  after(async () => {
    process.chdir(originalCwd);
    process.env["PATH"] = originalPath;
    delete process.env["HOOTL_FAKE_CLAUDE_STATE"];
    _setSessionId(originalSessionId);
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("saves raw output files for plan, execute, review, and hook phases", async () => {
    const testSessionId = `test-raw-output-${randomUUID()}`;
    _setSessionId(testSessionId);

    const task = await backend.createTask({
      title: "Raw output logging test",
      description: "Verify raw Claude output is saved to logs/ directory",
    });

    // Pre-create understanding.md to skip preflight (avoids an extra claude call)
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    // State file for the fake claude — lives outside the git repo
    const stateFile = join(stateDir, "count-raw-output");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // Advisory hook so it runs but doesn't block
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    const logsDir = join(taskDir, "logs");

    // --- Verify logs/ directory exists ---
    await access(logsDir); // throws if missing

    // --- Verify plan-1.txt exists and contains the plan output ---
    const planContent = await readFile(join(logsDir, "plan-1.txt"), "utf-8");
    assert.ok(planContent.length > 0, "plan-1.txt should have content");
    // The raw output is what invokeClaude extracts from the JSON envelope's `result` field
    assert.ok(
      planContent.includes("Plan") || planContent.includes("Implement"),
      "plan-1.txt should contain plan output text",
    );

    // --- Verify execute-1.txt exists and contains the execute output ---
    const executeContent = await readFile(join(logsDir, "execute-1.txt"), "utf-8");
    assert.ok(executeContent.length > 0, "execute-1.txt should have content");
    assert.ok(
      executeContent.includes("Progress") || executeContent.includes("Implemented"),
      "execute-1.txt should contain execute output text",
    );

    // --- Verify review-1.txt exists and contains the review output ---
    const reviewContent = await readFile(join(logsDir, "review-1.txt"), "utf-8");
    assert.ok(reviewContent.length > 0, "review-1.txt should have content");
    assert.ok(
      reviewContent.includes("confidence") || reviewContent.includes("96"),
      "review-1.txt should contain review output with confidence",
    );

    // --- Verify hook output was saved ---
    // Filename includes loop attempt: hook-on_confidence_met-<attempt>-<hookIndex>.txt
    // First attempt in the loop is attempt=1 (currentTask.attempts + 1), hookIndex=0
    const hookContent = await readFile(join(logsDir, "hook-on_confidence_met-1-0.txt"), "utf-8");
    assert.ok(hookContent.length > 0, "hook-on_confidence_met-1-0.txt should have content");
    assert.ok(
      hookContent.includes("pass") || hookContent.includes("true"),
      "hook output should contain pass result",
    );

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      const updated = await backend.getTask(task.id);
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
