/**
 * Integration test: skip plan+execute when confidence already met on a clean branch.
 *
 * When a task resumes with confidence >= target, a clean working tree, and no new
 * commits since the last review, the system should skip plan+execute and jump
 * directly to handleConfidenceMet (the on_confidence_met hook). This avoids wasting
 * budget re-verifying unchanged code.
 *
 * Uses a real git repo and LocalTaskBackend. A fake `claude` binary tracks call
 * count to verify that unnecessary phases are not executed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { runCompletionLoop } from "../loop.js";
import { ConfigSchema } from "../config.js";
import { LocalTaskBackend } from "../tasks/local.js";

describe("skip-to-hook fast path", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-skip-to-hook-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake claude binary: tracks call count via state file.
    //
    // For the fast-path test, we expect ZERO claude calls (the hook runs via
    // handleConfidenceMet, but with onConfidence: "none" and no custom hooks
    // the default simplify hook is injected — however, the branch has a diff
    // so the hook WILL run. We use an advisory hook to avoid blocking).
    //
    // For negative tests (confidence too low or dirty tree), the fake handles
    // a full plan → execute → review cycle.
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

const args = process.argv.join(" ");
let result;

if (args.includes("--system-prompt") && args.includes("validate-simplify")) {
  // Hook call (simplify) — pass
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
} else if (count === 1) {
  // Plan phase
  result = "## Plan\\n\\n1. Implement the feature\\n2. Add tests";
} else if (count === 2) {
  // Execute phase
  result = "## Progress\\n\\nChanges applied.";
} else if (count === 3) {
  // Review phase — return high confidence
  result = JSON.stringify({
    confidence: 96,
    summary: "Task complete",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
  });
} else {
  // Fallback — pass
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
}

process.stdout.write(JSON.stringify({
  result,
  total_cost_usd: 0.01,
  context_window_percent: 5,
  session_id: "test-session",
  uuid: "test-uuid",
  num_turns: 1,
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
    try { await execa("rm", ["-rf", tmpDir]); } catch { /* best effort */ }
    try { await execa("rm", ["-rf", stateDir]); } catch { /* best effort */ }
  });

  it("skips plan+execute when confidence >= target and branch is clean and unchanged", async () => {
    const task = await backend.createTask({
      title: "Already-confident task",
      description: "Task that already passed review with high confidence",
    });

    // Set up the task as if it previously completed a review cycle
    await backend.updateTask(task.id, {
      state: "in_progress",
      confidence: 95,
      attempts: 1,
    });

    // Create a task branch with a real commit (so handleConfidenceMet has a diff)
    const branchName = `hootl/${task.id}-already-confident-task`;
    await execa("git", ["checkout", "-b", branchName], { cwd: tmpDir });
    await writeFile(join(tmpDir, "feature.txt"), "real work");
    await execa("git", ["add", "feature.txt"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "feature work"], { cwd: tmpDir });

    // Record the branch name on the task
    await backend.updateTask(task.id, { branch: branchName });

    // Get the HEAD SHA to simulate a previous review at this exact commit
    const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });

    // Set up task artifacts: understanding.md (skip preflight), last_confidence.txt,
    // and last_review_sha.txt (the key artifact for the fast path)
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");
    await writeFile(join(taskDir, "last_confidence.txt"), "95");
    await writeFile(join(taskDir, "last_review_sha.txt"), headSha.trim());

    // Switch back to main so the loop can check out the task branch
    await execa("git", ["checkout", "main"], { cwd: tmpDir });

    const stateFile = join(stateDir, "count-skip-hook");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // Use advisory (non-blocking) hook so handleConfidenceMet doesn't require
      // parsing a blocking hook result. The fast path should still fire.
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
    });

    await runCompletionLoop(await backend.getTask(task.id), backend, config);

    const updated = await backend.getTask(task.id);

    // Task should reach review state (onConfidence: "none" → review)
    assert.equal(updated.state, "review",
      `Expected review state, got: ${updated.state} (blockers: ${JSON.stringify(updated.blockers)})`);

    // The fast path should have fired — no plan/execute/review claude calls needed.
    // The advisory hook fires one claude call (handleConfidenceMet runs the hook).
    let callCount = 0;
    try {
      callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    } catch { /* file may not exist if zero calls */ }
    assert.ok(callCount <= 1,
      `Expected at most 1 claude call (advisory hook only), got ${callCount} — fast path should have skipped plan+execute+review`);

    // Verify the skip_to_hook decision was logged
    const logsDir = join(tmpDir, ".hootl", "logs");
    const logFiles = await readdir(logsDir);
    const eventFiles = logFiles.filter(f => f.endsWith(".jsonl"));
    let foundSkipEvent = false;
    for (const f of eventFiles) {
      const content = await readFile(join(logsDir, f), "utf-8");
      if (content.includes('"skip_to_hook"')) {
        foundSkipEvent = true;
        break;
      }
    }
    assert.ok(foundSkipEvent, "Expected a skip_to_hook decision event in the logs");

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT skip when confidence is below target", async () => {
    const task = await backend.createTask({
      title: "Low-confidence task",
      description: "Task with confidence below target",
    });

    await backend.updateTask(task.id, {
      state: "in_progress",
      confidence: 50,
      attempts: 0,
    });

    // Set up task artifacts as if a previous review happened
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");
    await writeFile(join(taskDir, "last_confidence.txt"), "50");

    // Create task branch with a commit
    const branchName = `hootl/${task.id}-low-confidence-task`;
    await execa("git", ["checkout", "-b", branchName], { cwd: tmpDir });
    await writeFile(join(tmpDir, "low-conf.txt"), "some work");
    await execa("git", ["add", "low-conf.txt"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "partial work"], { cwd: tmpDir });

    await backend.updateTask(task.id, { branch: branchName });

    const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    await writeFile(join(taskDir, "last_review_sha.txt"), headSha.trim());

    await execa("git", ["checkout", "main"], { cwd: tmpDir });

    const stateFile = join(stateDir, "count-low-conf");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 1 },
    });

    await runCompletionLoop(await backend.getTask(task.id), backend, config);

    // The loop should have run plan+execute+review — NOT the fast path
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount > 1,
      `Expected > 1 claude calls (loop should run), got ${callCount}`);

    // Verify NO skip_to_hook decision was logged for THIS task
    const logsDir = join(tmpDir, ".hootl", "logs");
    const logFiles = await readdir(logsDir);
    const eventFiles = logFiles.filter(f => f.endsWith(".jsonl"));
    let foundSkipEvent = false;
    for (const f of eventFiles) {
      const content = await readFile(join(logsDir, f), "utf-8");
      for (const line of content.split("\n")) {
        if (line.includes('"skip_to_hook"') && line.includes(task.id)) {
          foundSkipEvent = true;
          break;
        }
      }
    }
    assert.ok(!foundSkipEvent, "Should NOT have a skip_to_hook decision event for this task");

    // Clean up
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (task.id) {
        const updated = await backend.getTask(task.id);
        if (updated.branch) {
          await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
        }
      }
    } catch { /* best effort */ }
  });

  it("does NOT skip when working tree is dirty", async () => {
    const task = await backend.createTask({
      title: "Dirty-tree task",
      description: "Task with uncommitted changes despite high confidence",
    });

    await backend.updateTask(task.id, {
      state: "in_progress",
      confidence: 95,
      attempts: 0,
    });

    // Create task branch with a commit
    const branchName = `hootl/${task.id}-dirty-tree-task`;
    await execa("git", ["checkout", "-b", branchName], { cwd: tmpDir });
    await writeFile(join(tmpDir, "dirty-feat.txt"), "committed work");
    await execa("git", ["add", "dirty-feat.txt"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "feature"], { cwd: tmpDir });

    await backend.updateTask(task.id, { branch: branchName });

    const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });

    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");
    await writeFile(join(taskDir, "last_confidence.txt"), "95");
    await writeFile(join(taskDir, "last_review_sha.txt"), headSha.trim());

    // Create an uncommitted file — this makes the working tree dirty
    await writeFile(join(tmpDir, "uncommitted.txt"), "dirty!");

    // Stay on the task branch (the loop will detect we're already on it)
    // Actually, switch to main — the loop will switch to the branch and the
    // dirty file is in the repo root, visible from any branch.
    await execa("git", ["checkout", "main"], { cwd: tmpDir });

    const stateFile = join(stateDir, "count-dirty");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 1 },
    });

    await runCompletionLoop(await backend.getTask(task.id), backend, config);

    // The loop should have run plan+execute+review — NOT the fast path.
    // Claude should have been called at least once (plan phase).
    let callCount = 0;
    try {
      callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    } catch { /* file may not exist if zero calls — that means fast path didn't fire but loop also didn't run */ }
    assert.ok(callCount > 0,
      `Expected > 0 claude calls (loop should run), got ${callCount}`);

    // Verify NO skip_to_hook decision was logged for THIS task
    const logsDir = join(tmpDir, ".hootl", "logs");
    const logFiles = await readdir(logsDir);
    const eventFiles = logFiles.filter(f => f.endsWith(".jsonl"));
    let foundSkipEvent = false;
    for (const f of eventFiles) {
      const content = await readFile(join(logsDir, f), "utf-8");
      for (const line of content.split("\n")) {
        if (line.includes('"skip_to_hook"') && line.includes(task.id)) {
          foundSkipEvent = true;
          break;
        }
      }
    }
    assert.ok(!foundSkipEvent, "Should NOT have a skip_to_hook decision event for dirty tree");

    // Clean up
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      // Remove the uncommitted file
      try { await execa("rm", ["-f", join(tmpDir, "uncommitted.txt")]); } catch { /* */ }
      const updated = await backend.getTask(task.id);
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
