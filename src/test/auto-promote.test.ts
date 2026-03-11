/**
 * Integration test: auto-promotion of parent tasks whose subtasks are all done.
 *
 * Simulates the task-071 scenario: a parent task with dependencies that are all
 * in 'done' state and whose branch has zero diff from main. The system should
 * auto-promote the task without entering the completion loop (no plan/execute/review).
 *
 * Also tests the hook-skip path: when a task reaches confidence but its branch has
 * no diff, on_confidence_met hooks should be skipped entirely.
 *
 * Uses a real git repo and LocalTaskBackend. A fake `claude` binary tracks call
 * count to verify that unnecessary phases are not executed.
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

describe("auto-promote parent tasks completed by subtasks", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-auto-promote-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake claude that tracks call count. Every call is a sign of wasted budget.
    // For the auto-promote test, we expect ZERO calls (or only preflight).
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

let result;
if (count === 1) {
  // Preflight: return proceed verdict
  result = JSON.stringify({
    verdict: "proceed",
    understanding: "Task understood — all subtasks already completed.",
    subtasks: [],
  });
} else {
  // Should never reach here in the auto-promote path
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
}

process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.01, context_window_percent: 5 }));
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
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("auto-promotes when all dependencies are done and branch has no diff", async () => {
    // Create dependency tasks and mark them as done
    const dep1 = await backend.createTask({
      title: "Subtask 1",
      description: "Already completed subtask",
    });
    await backend.updateTask(dep1.id, { state: "done" });

    const dep2 = await backend.createTask({
      title: "Subtask 2",
      description: "Another completed subtask",
    });
    await backend.updateTask(dep2.id, { state: "done" });

    // Create parent task with dependencies on both subtasks.
    // Set attempts > 0 and confidence > 0 to simulate a task that has been worked
    // on before and completed at least one review cycle — auto-promote requires both
    // guards to prevent false promotion of fresh or failed tasks.
    const parentTask = await backend.createTask({
      title: "Parent feature",
      description: "Parent task that depends on subtask 1 and 2",
    });
    await backend.updateTask(parentTask.id, {
      dependencies: [dep1.id, dep2.id],
      attempts: 1,
      confidence: 50,
    });
    const task = await backend.getTask(parentTask.id);

    // State file for the fake claude
    const stateFile = join(stateDir, "count-promote");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // No custom hooks — would inject default simplify hook, but auto-promote
      // should fire before hooks are even considered.
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(parentTask.id);

    // Task should be promoted to review (onConfidence: "none" → review state)
    assert.equal(updated.state, "review",
      `Expected auto-promote to review, got: ${updated.state} (blockers: ${JSON.stringify(updated.blockers)})`);

    // Confidence should be set to 100 by auto-promote
    assert.equal(updated.confidence, 100,
      `Expected confidence 100 from auto-promote, got: ${updated.confidence}`);

    // Only preflight should have been called (1 call). No plan, execute, or review.
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.equal(callCount, 1,
      `Expected only 1 claude call (preflight), got ${callCount} — loop should not have run`);

    // Clean up branch
    try {
      const branchName = updated.branch;
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (branchName) {
        await execa("git", ["branch", "-D", branchName], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT auto-promote a fresh task (attempts=0) even when all deps are done", async () => {
    // A fresh task with attempts=0 always has no diff (branch just created).
    // Auto-promote should NOT fire — the task hasn't had a chance to do its work.
    const dep = await backend.createTask({
      title: "Done dep for fresh test",
      description: "Completed",
    });
    await backend.updateTask(dep.id, { state: "done" });

    const freshTask = await backend.createTask({
      title: "Fresh task with dep",
      description: "Has work to do despite dep being done",
    });
    await backend.updateTask(freshTask.id, {
      dependencies: [dep.id],
      // attempts defaults to 0 — do NOT set it
    });
    const task = await backend.getTask(freshTask.id);

    const stateFile = join(stateDir, "count-fresh");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(freshTask.id);
    // Task should NOT have been auto-promoted — it should have gone through
    // the normal loop (preflight + plan + execute + review).
    // The fake claude returns a plan error which stops the loop, so the task
    // ends up in a non-done state.
    assert.notEqual(updated.confidence, 100,
      "Fresh task should not be auto-promoted to confidence 100");

    // More than 1 claude call means the loop ran (not just preflight + auto-promote)
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount > 1,
      `Expected >1 claude calls (loop should run), got ${callCount}`);

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT auto-promote when previous attempt failed (confidence=0)", async () => {
    // A task with attempts > 0 but confidence === 0 means its previous attempt
    // failed during execute (before review could set confidence). The branch has
    // no diff because no work was committed — NOT because subtasks did everything.
    // Auto-promote must NOT fire in this case (the task still has work to do).
    const dep = await backend.createTask({
      title: "Done dep for failed-attempt test",
      description: "Completed",
    });
    await backend.updateTask(dep.id, { state: "done" });

    const failedTask = await backend.createTask({
      title: "Task that failed execute",
      description: "Previous execute phase failed before committing",
    });
    await backend.updateTask(failedTask.id, {
      dependencies: [dep.id],
      attempts: 1,
      // confidence stays at 0 (default) — no review was ever completed
    });
    const task = await backend.getTask(failedTask.id);

    const stateFile = join(stateDir, "count-failed-attempt");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      // Must be > attempts (1) so the loop actually runs an iteration
      budgets: { maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(failedTask.id);

    // Should NOT have been auto-promoted — confidence is 0 (no successful review)
    assert.notEqual(updated.confidence, 100,
      "Task with confidence=0 should not be auto-promoted to 100");

    // More than 1 claude call means the loop ran (not just preflight + auto-promote)
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount > 1,
      `Expected > 1 claude calls (loop should run, not auto-promote), got ${callCount}`);

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT auto-promote when a dependency is not done", async () => {
    // Create one done dep and one in_progress dep
    const dep1 = await backend.createTask({
      title: "Done dep",
      description: "Completed",
    });
    await backend.updateTask(dep1.id, { state: "done" });

    const dep2 = await backend.createTask({
      title: "In-progress dep",
      description: "Still working",
    });
    await backend.updateTask(dep2.id, { state: "in_progress" });

    const parentTask = await backend.createTask({
      title: "Partial parent",
      description: "Should NOT be auto-promoted",
    });
    await backend.updateTask(parentTask.id, {
      dependencies: [dep1.id, dep2.id],
    });
    const task = await backend.getTask(parentTask.id);

    const stateFile = join(stateDir, "count-no-promote");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // Use advisory hook to avoid the blocking simplify hook
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 1 },
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(parentTask.id);

    // Task should NOT have been auto-promoted — it has an unfinished dep.
    // It should have gone through the normal loop.
    assert.notEqual(updated.confidence, 100,
      "Confidence should not be 100 — auto-promote should not have fired");

    // Should have more than 1 claude call (preflight + at least plan)
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount > 1,
      `Expected > 1 claude call (loop should have run), got ${callCount}`);

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT auto-promote when branch has actual diff despite deps being done", async () => {
    // Create a done dependency
    const dep = await backend.createTask({
      title: "Done dep for diff test",
      description: "Completed",
    });
    await backend.updateTask(dep.id, { state: "done" });

    const parentTask = await backend.createTask({
      title: "Parent with diff",
      description: "Branch has real changes",
    });
    await backend.updateTask(parentTask.id, {
      dependencies: [dep.id],
    });
    const task = await backend.getTask(parentTask.id);

    // Pre-create the task branch WITH a commit (so it has a real diff from main)
    const branchName = `hootl/${task.id}-parent-with-diff`;
    await execa("git", ["checkout", "-b", branchName], { cwd: tmpDir });
    await writeFile(join(tmpDir, "new-feature.txt"), "real changes");
    await execa("git", ["add", "new-feature.txt"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "feature work"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });

    const stateFile = join(stateDir, "count-has-diff");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 1 },
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(parentTask.id);

    // Should NOT have been auto-promoted — branch has real diff
    assert.notEqual(updated.confidence, 100,
      "Should not auto-promote when branch has real changes");

    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount > 1,
      `Expected > 1 claude call (loop should have run), got ${callCount}`);

    // Clean up
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      await execa("git", ["branch", "-D", branchName], { cwd: tmpDir });
    } catch { /* best effort */ }
  });
});

describe("hook skip on empty diff at confidence met", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hook-skip-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake claude: plan → execute → review (95%) → hook (envelope with empty result).
    // Without the fix, the hook's empty-result envelope would fail parsing and block the task.
    // With the fix, the empty diff causes hooks to be skipped entirely.
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

let result;
if (count === 1) {
  result = "## Plan\\n\\n1. Verify the task is done";
} else if (count === 2) {
  result = "## Progress\\n\\nNothing to change.";
} else if (count === 3) {
  // Review: high confidence — task is "done"
  result = JSON.stringify({
    confidence: 96,
    summary: "Task complete — no changes needed",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
  });
} else if (count === 4) {
  // This is the hook call. Return an envelope with empty result (the bug scenario).
  // If hooks are properly skipped for empty diffs, this should never be reached.
  // If it IS reached, the envelope fix should still handle it gracefully.
  result = "";
} else {
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
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("skips on_confidence_met hooks when branch has no diff and task succeeds", async () => {
    const task = await backend.createTask({
      title: "No-diff hook skip test",
      description: "Task whose branch is identical to main",
    });

    // Pre-create understanding.md to skip preflight
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, "count-hook-skip");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    // Use default hooks (which would inject the blocking simplify hook).
    // If hooks are NOT skipped, the empty-result envelope would cause a block.
    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      budgets: { maxAttemptsPerTask: 1 },
    });

    await runCompletionLoop(task, backend, config);

    const updated = await backend.getTask(task.id);

    // Task should succeed — hooks skipped because branch has no diff
    assert.equal(updated.state, "review",
      `Expected review (hook skipped, onConfidence: "none"), got: ${updated.state} (blockers: ${JSON.stringify(updated.blockers)})`);

    // Should have exactly 3 calls: plan, execute, review. No hook call (4th).
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.equal(callCount, 3,
      `Expected 3 claude calls (plan + execute + review, no hook), got ${callCount}`);

    // Clean up
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
