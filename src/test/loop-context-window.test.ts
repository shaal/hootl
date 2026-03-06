/**
 * Integration test: review phase runs even when execute reports high context window usage.
 *
 * Before the fix, applyContextWindowExceeded after the execute phase would `continue` past
 * the review, creating a plan→execute loop with no confidence evaluation. The task could
 * only exit via budget exhaustion.
 *
 * Uses a fake `claude` executable (prepended to PATH) that returns controlled JSON with
 * high contextWindowPercent on the execute phase. Tests the full invokeClaude → loop stack
 * without module mocking.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { runCompletionLoop } from "../loop.js";
import { ConfigSchema } from "../config.js";
import { LocalTaskBackend } from "../tasks/local.js";

describe("review runs after high context window execute", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;

  before(async () => {
    // Capture process state first — before any fallible operations — so after() can
    // always restore them even if setup fails partway through.
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-ctx-window-test-"));
    // State dir for fake claude call tracking — OUTSIDE the git repo to avoid
    // polluting the working tree (which would trigger commitTaskChanges →
    // generateCommitMessage → extra invokeClaude calls that break our count).
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake `claude` executable — tracks call count via an external state file.
    // Returns high contextWindowPercent (80%) on the execute phase (call #2).
    // The review phase (call #3) returns confidence 96% (above default 95% target).
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

let result, ctxPct;
if (count === 1) {
  result = "## Plan\\n\\n1. Implement the feature\\n2. Add tests";
  ctxPct = 10;
} else if (count === 2) {
  result = "## Progress\\n\\nImplemented the feature. All tests pass.";
  ctxPct = 80;
} else if (count === 3) {
  result = JSON.stringify({ confidence: 96, summary: "All good", issues: [], suggestions: [], blockers: [], remediationPlan: "" });
  ctxPct = 10;
} else {
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
  ctxPct = 0;
}

process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.01, context_window_percent: ctxPct }));
`;
    await writeFile(join(fakeBinDir, "claude"), fakeClaude, { mode: 0o755 });

    // Real git repo (branch operations need it)
    // .gitignore keeps .hootl/ and fake-bin/ out of the working tree so
    // commitTaskChanges finds nothing to commit (no generateCommitMessage calls).
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
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("review phase executes when execute reports contextWindowPercent above limit", async () => {
    const task = await backend.createTask({
      title: "Context window test",
      description: "Verify review runs after high context window execute",
    });

    // Pre-create understanding.md to skip preflight (avoids an extra claude call)
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    // State file for the fake claude — lives outside the git repo
    const stateFile = join(stateDir, "count");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // Advisory hook avoids the default blocking simplify hook injection.
      // Non-blocking, so even if hook result parsing has issues, it won't block.
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { contextWindowLimit: 60, maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    const updated = await backend.getTask(task.id);

    // Core assertion: the review (3rd call) must have run.
    // Before the fix, the loop would `continue` after execute's contextWindowPercent (80%)
    // exceeded the limit (60%), skipping review entirely.
    assert.ok(
      callCount >= 3,
      `Expected >= 3 claude calls (plan + execute + review), got ${callCount}`,
    );

    // Task reached confidence target and transitioned to review (onConfidence: "none")
    assert.equal(updated.state, "review", `Expected review state, got: ${updated.state}`);
    assert.equal(updated.confidence, 96, `Expected confidence 96 from review, got: ${updated.confidence}`);
  });
});
