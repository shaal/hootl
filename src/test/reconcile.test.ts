import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { LocalTaskBackend } from "../tasks/local.js";
import { reconcileTasks, printReconcileReport, extractDecomposedSubtaskIds } from "../reconcile.js";
import type { ReconcileResult, ReconcileDeps } from "../reconcile.js";

/** No-op worktree removal for tests — suppresses git warnings from non-worktree dirs */
function noopRemoveWorktree(_path: string): Promise<void> {
  return Promise.resolve();
}

/** Tracking mock that records calls and optionally removes the directory */
function trackingRemoveWorktree(): { calls: string[]; fn: (path: string) => Promise<void> } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (path: string) => {
      calls.push(path);
      // Actually remove the directory to verify cleanup behavior
      await rm(path, { recursive: true, force: true });
    },
  };
}

const quietDeps: ReconcileDeps = { removeWorktree: noopRemoveWorktree };

describe("reconcileTasks", () => {
  let tmpDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-reconcile-test-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    await mkdir(tasksDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Initialize a git repo
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });

    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("marks a task as done when its ID appears in commits on main", async () => {
    const task = await backend.createTask({ title: "Landed Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-feature.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} implement landed feature`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0]!.id, task.id);
    assert.ok(result.reconciled[0]!.action.includes("marked done"));

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("does not change a task without commits on main", async () => {
    const task = await backend.createTask({ title: "Untouched Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    // This task should not be in reconciled list
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.equal(found, undefined);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");
  });

  it("cleans up a stale branch when reconciling a task", async () => {
    const task = await backend.createTask({ title: "Branch Cleanup", description: "desc" });
    const branchName = `hootl/${task.id}-branch-cleanup`;
    await backend.updateTask(task.id, { state: "ready", branch: branchName });

    // Create the branch (so it exists locally)
    await execa("git", ["branch", branchName], { cwd: tmpDir });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-branch.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} branch cleanup feature`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("branch cleaned"));

    // Branch should be deleted
    const branchList = await execa("git", ["branch", "--list", branchName], { cwd: tmpDir });
    assert.equal(branchList.stdout.trim(), "");

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("cleans up worktree when reconciling a task with worktree set", async () => {
    const task = await backend.createTask({ title: "Worktree Cleanup Reconcile", description: "desc" });
    const branchName = `hootl/${task.id}-worktree-reconcile`;
    const worktreePath = join(tmpDir, ".hootl", "worktrees", task.id);
    await mkdir(worktreePath, { recursive: true });
    await backend.updateTask(task.id, {
      state: "in_progress",
      branch: branchName,
      worktree: worktreePath,
    });

    // Create the branch locally
    await execa("git", ["branch", branchName], { cwd: tmpDir });

    // Make a commit on main referencing this task ID
    await writeFile(join(tmpDir, `${task.id}-worktree-reconcile.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} worktree reconcile feature`], { cwd: tmpDir });

    // Use tracking mock to verify removeWorktree is called with correct path
    const tracker = trackingRemoveWorktree();
    const result = await reconcileTasks(backend, { deps: { removeWorktree: tracker.fn } });

    // Task should be reconciled with worktree cleaned action
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("marked done"));
    assert.ok(found.action.includes("branch cleaned"));
    assert.ok(found.action.includes("worktree cleaned"));

    // removeWorktree should have been called with the task's worktree path
    assert.ok(tracker.calls.includes(worktreePath), "removeWorktree should be called with the worktree path");

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
    // Worktree field should be nulled out after cleanup
    assert.equal(updated.worktree, null);
  });

  it("reports worktree cleaned even when removeWorktree throws", async () => {
    const task = await backend.createTask({ title: "Worktree Error Resilience", description: "desc" });
    const branchName = `hootl/${task.id}-wt-error`;
    const worktreePath = join(tmpDir, ".hootl", "worktrees", task.id);
    await mkdir(worktreePath, { recursive: true });
    await backend.updateTask(task.id, {
      state: "in_progress",
      branch: branchName,
      worktree: worktreePath,
    });

    await execa("git", ["branch", branchName], { cwd: tmpDir });

    await writeFile(join(tmpDir, `${task.id}-wt-error.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} worktree error resilience`], { cwd: tmpDir });

    // Inject a removeWorktree that throws (simulates git worktree remove failure)
    const throwingDeps: ReconcileDeps = {
      removeWorktree: async () => { throw new Error("worktree remove failed"); },
    };
    const result = await reconcileTasks(backend, { deps: throwingDeps });

    // Task should still be reconciled — worktree errors are best-effort
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("worktree cleaned"));

    // Task state should be done despite worktree error
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
    // worktree field is NOT nulled when removeWorktree throws (the updateTask after it is skipped)
    assert.equal(updated.worktree, worktreePath);
  });

  it("detects and cleans orphaned worktree directories", async () => {
    // Create a task already in done state
    const task = await backend.createTask({ title: "Done With Orphan", description: "desc" });
    await backend.updateTask(task.id, { state: "done" });

    // Create a fake worktree directory for this done task
    // Use process.cwd() to match what reconcileTasks uses internally (avoids macOS symlink mismatches)
    const worktreesDir = join(process.cwd(), ".hootl", "worktrees");
    const orphanDir = join(worktreesDir, task.id);
    await mkdir(orphanDir, { recursive: true });

    // Use tracking mock to verify orphan cleanup calls removeWorktree
    const tracker = trackingRemoveWorktree();
    const result = await reconcileTasks(backend, { deps: { removeWorktree: tracker.fn } });

    // The orphaned worktree directory should be counted
    assert.ok(result.orphanedCleaned > 0);
    // removeWorktree was called for the orphan (use endsWith to handle symlink path differences)
    const orphanCalled = tracker.calls.some((c) => c.endsWith(join(".hootl", "worktrees", task.id)));
    assert.ok(orphanCalled, "removeWorktree should be called for orphaned worktree");
  });

  it("detects orphaned worktree directory for a non-existent task", async () => {
    // Create a worktree directory for a task ID that doesn't exist in the backend
    const worktreesDir = join(process.cwd(), ".hootl", "worktrees");
    const ghostDir = join(worktreesDir, "task-ghost-999");
    await mkdir(ghostDir, { recursive: true });

    const tracker = trackingRemoveWorktree();
    const result = await reconcileTasks(backend, { deps: { removeWorktree: tracker.fn } });

    // Should count the non-existent task's worktree as orphaned
    const ghostCleaned = tracker.calls.some((c) => c.includes("task-ghost-999"));
    assert.ok(ghostCleaned, "removeWorktree should be called for worktree of non-existent task");
    assert.ok(result.orphanedCleaned > 0);
  });

  it("dry-run produces no side effects", async () => {
    const task = await backend.createTask({ title: "Dry Run Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-dryrun.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} dry run feature`], { cwd: tmpDir });

    // Track whether removeWorktree is called
    const tracker = trackingRemoveWorktree();
    const result = await reconcileTasks(backend, { dryRun: true, deps: { removeWorktree: tracker.fn } });

    // Should report what would be reconciled
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);

    // But the task state should NOT be changed
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");

    // removeWorktree should never be called in dry-run mode
    assert.equal(tracker.calls.length, 0, "removeWorktree should not be called in dry-run mode");
  });

  it("dry-run does not delete branches", async () => {
    const task = await backend.createTask({ title: "Dry Run Branch", description: "desc" });
    const branchName = `hootl/${task.id}-dryrun-branch`;
    await backend.updateTask(task.id, { state: "ready", branch: branchName });

    await execa("git", ["branch", branchName], { cwd: tmpDir });

    await writeFile(join(tmpDir, `${task.id}-dryrun-branch.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} dry run branch test`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { dryRun: true, deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("branch cleaned"));

    // Branch should still exist — dry-run doesn't delete
    const branchList = await execa("git", ["branch", "--list", branchName], { cwd: tmpDir });
    assert.ok(branchList.stdout.trim().length > 0, "Branch should still exist after dry-run");

    // State should still be ready
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "ready");
  });

  it("skips tasks already in done state", async () => {
    const task = await backend.createTask({ title: "Already Done", description: "desc" });
    await backend.updateTask(task.id, { state: "done" });

    // Make a commit on main referencing this task
    await writeFile(join(tmpDir, `${task.id}-already-done.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} already done task`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    // This task should NOT appear in reconciled list
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.equal(found, undefined);
  });

  it("reconciles tasks in multiple non-done states", async () => {
    // Create tasks in different states
    const proposed = await backend.createTask({ title: "Proposed Task", description: "desc" });
    // proposed is default state

    const ready = await backend.createTask({ title: "Ready Task", description: "desc" });
    await backend.updateTask(ready.id, { state: "ready" });

    const blocked = await backend.createTask({ title: "Blocked Task", description: "desc" });
    await backend.updateTask(blocked.id, { state: "blocked" });

    // Make commits on main referencing all three task IDs
    await writeFile(join(tmpDir, `${proposed.id}-multi.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${proposed.id} and ${ready.id} and ${blocked.id} multi-state`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    // All three should be reconciled
    for (const task of [proposed, ready, blocked]) {
      const found = result.reconciled.find((r) => r.id === task.id);
      assert.ok(found !== undefined, `Task ${task.id} (${task.title}) should be reconciled`);

      const updated = await backend.getTask(task.id);
      assert.equal(updated.state, "done");
    }
  });
});

describe("extractDecomposedSubtaskIds", () => {
  it("extracts IDs from 'Decomposed into subtasks' blocker", () => {
    const ids = extractDecomposedSubtaskIds("Decomposed into subtasks: task-056, task-057, task-058");
    assert.deepEqual(ids, ["task-056", "task-057", "task-058"]);
  });

  it("extracts IDs from 'Decomposed remediation into subtasks' blocker", () => {
    const ids = extractDecomposedSubtaskIds("Decomposed remediation into subtasks: task-087, task-088");
    assert.deepEqual(ids, ["task-087", "task-088"]);
  });

  it("returns empty array for non-decomposition blocker", () => {
    const ids = extractDecomposedSubtaskIds("Some other blocker reason");
    assert.deepEqual(ids, []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(extractDecomposedSubtaskIds(""), []);
  });
});

describe("reconcileTasks — decomposed parent promotion", () => {
  let tmpDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-reconcile-decomp-test-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    await mkdir(tasksDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });

    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("promotes a blocked decomposed parent when all subtasks are done", async () => {
    const sub1 = await backend.createTask({ title: "Subtask 1", description: "desc" });
    const sub2 = await backend.createTask({ title: "Subtask 2", description: "desc" });
    await backend.updateTask(sub1.id, { state: "done" });
    await backend.updateTask(sub2.id, { state: "done" });

    const parent = await backend.createTask({ title: "Parent Task", description: "desc" });
    await backend.updateTask(parent.id, {
      state: "blocked",
      blockers: [`Decomposed into subtasks: ${sub1.id}, ${sub2.id}`],
    });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === parent.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("subtasks complete"));

    const updated = await backend.getTask(parent.id);
    assert.equal(updated.state, "done");
  });

  it("does not promote when some subtasks are not done", async () => {
    const sub1 = await backend.createTask({ title: "Done Sub", description: "desc" });
    const sub2 = await backend.createTask({ title: "Not Done Sub", description: "desc" });
    await backend.updateTask(sub1.id, { state: "done" });
    await backend.updateTask(sub2.id, { state: "in_progress" });

    const parent = await backend.createTask({ title: "Partial Parent", description: "desc" });
    await backend.updateTask(parent.id, {
      state: "blocked",
      blockers: [`Decomposed into subtasks: ${sub1.id}, ${sub2.id}`],
    });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === parent.id);
    assert.equal(found, undefined);

    const updated = await backend.getTask(parent.id);
    assert.equal(updated.state, "blocked");
  });

  it("handles remediation decomposition pattern", async () => {
    const sub1 = await backend.createTask({ title: "Remediation 1", description: "desc" });
    await backend.updateTask(sub1.id, { state: "done" });

    const parent = await backend.createTask({ title: "Remediation Parent", description: "desc" });
    await backend.updateTask(parent.id, {
      state: "blocked",
      blockers: [`Decomposed remediation into subtasks: ${sub1.id}`],
    });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === parent.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("subtasks complete"));

    const updated = await backend.getTask(parent.id);
    assert.equal(updated.state, "done");
  });

  it("skips non-blocked tasks even if they have decomposition blockers", async () => {
    const sub = await backend.createTask({ title: "Sub Ready", description: "desc" });
    await backend.updateTask(sub.id, { state: "done" });

    const parent = await backend.createTask({ title: "Ready Parent", description: "desc" });
    await backend.updateTask(parent.id, {
      state: "ready",
      blockers: [`Decomposed into subtasks: ${sub.id}`],
    });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === parent.id);
    assert.equal(found, undefined);

    const updated = await backend.getTask(parent.id);
    assert.equal(updated.state, "ready");
  });

  it("cascades: promotes grandparent when child promotion makes all subtasks done", async () => {
    const leaf = await backend.createTask({ title: "Leaf", description: "desc" });
    await backend.updateTask(leaf.id, { state: "done" });

    const child = await backend.createTask({ title: "Child", description: "desc" });
    await backend.updateTask(child.id, {
      state: "blocked",
      blockers: [`Decomposed into subtasks: ${leaf.id}`],
    });

    const grandparent = await backend.createTask({ title: "Grandparent", description: "desc" });
    await backend.updateTask(grandparent.id, {
      state: "blocked",
      blockers: [`Decomposed into subtasks: ${child.id}`],
    });

    const result = await reconcileTasks(backend, { deps: quietDeps });

    // Both child and grandparent should be promoted
    const childFound = result.reconciled.find((r) => r.id === child.id);
    const gpFound = result.reconciled.find((r) => r.id === grandparent.id);
    assert.ok(childFound !== undefined, "child should be promoted");
    assert.ok(gpFound !== undefined, "grandparent should be promoted");

    assert.equal((await backend.getTask(child.id)).state, "done");
    assert.equal((await backend.getTask(grandparent.id)).state, "done");
  });

  it("dry-run reports decomposed promotions without changing state", async () => {
    const sub = await backend.createTask({ title: "DryRun Sub", description: "desc" });
    await backend.updateTask(sub.id, { state: "done" });

    const parent = await backend.createTask({ title: "DryRun Parent", description: "desc" });
    await backend.updateTask(parent.id, {
      state: "blocked",
      blockers: [`Decomposed into subtasks: ${sub.id}`],
    });

    const result = await reconcileTasks(backend, { dryRun: true, deps: quietDeps });

    const found = result.reconciled.find((r) => r.id === parent.id);
    assert.ok(found !== undefined);

    const updated = await backend.getTask(parent.id);
    assert.equal(updated.state, "blocked", "state should not change in dry-run");
  });
});

describe("printReconcileReport", () => {
  let logOutput: string[];
  let stderrOutput: string[];
  let originalLog: typeof console.log;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    logOutput = [];
    stderrOutput = [];
    originalLog = console.log;
    originalStderrWrite = process.stderr.write;
    console.log = (...args: unknown[]) => {
      logOutput.push(args.map(String).join(" "));
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = originalLog;
    process.stderr.write = originalStderrWrite;
  });

  it("prints 'Nothing to reconcile' for empty result", () => {
    const result: ReconcileResult = { reconciled: [], orphanedCleaned: 0 };
    printReconcileReport(result, false);

    const allOutput = logOutput.join("\n");
    assert.ok(allOutput.includes("Nothing to reconcile"));
    // No success or warn output for empty results
    assert.equal(stderrOutput.length, 0);
  });

  it("prints table with correct entries for non-empty result", () => {
    const result: ReconcileResult = {
      reconciled: [
        { id: "task-001", title: "Fix auth bug", action: "marked done + branch cleaned" },
        { id: "task-002", title: "Add logging", action: "marked done" },
      ],
      orphanedCleaned: 1,
    };
    printReconcileReport(result, false);

    const allLog = logOutput.join("\n");
    // Table header and entries
    assert.ok(allLog.includes("Reconciled tasks:"));
    assert.ok(allLog.includes("ID"));
    assert.ok(allLog.includes("Title"));
    assert.ok(allLog.includes("Action"));
    assert.ok(allLog.includes("task-001"));
    assert.ok(allLog.includes("Fix auth bug"));
    assert.ok(allLog.includes("marked done + branch cleaned"));
    assert.ok(allLog.includes("task-002"));
    assert.ok(allLog.includes("Add logging"));
    assert.ok(allLog.includes("marked done"));
    // Success message with count
    assert.ok(allLog.includes("2 task(s) reconciled"));

    // Orphaned worktree warning goes to stderr
    const allStderr = stderrOutput.join("");
    assert.ok(allStderr.includes("1 orphaned worktree(s) cleaned up"));
  });

  it("includes [DRY RUN] prefix when dryRun is true", () => {
    const result: ReconcileResult = {
      reconciled: [
        { id: "task-010", title: "Test feature", action: "marked done" },
      ],
      orphanedCleaned: 2,
    };
    printReconcileReport(result, true);

    const allLog = logOutput.join("\n");
    // Both the header and success message should have prefix
    assert.ok(allLog.includes("[DRY RUN] Reconciled tasks:"));
    assert.ok(allLog.includes("[DRY RUN] 1 task(s) reconciled"));

    // Orphan warning in stderr should also have prefix
    const allStderr = stderrOutput.join("");
    assert.ok(allStderr.includes("[DRY RUN] 2 orphaned worktree(s) cleaned up"));
  });

  it("prints 'Nothing to reconcile' with [DRY RUN] prefix for empty result in dry-run mode", () => {
    const result: ReconcileResult = { reconciled: [], orphanedCleaned: 0 };
    printReconcileReport(result, true);

    const allLog = logOutput.join("\n");
    assert.ok(allLog.includes("[DRY RUN]"));
    assert.ok(allLog.includes("Nothing to reconcile"));
  });

  it("prints only orphan warning when no tasks are reconciled but orphans exist", () => {
    const result: ReconcileResult = { reconciled: [], orphanedCleaned: 3 };
    printReconcileReport(result, false);

    const allLog = logOutput.join("\n");
    // Should NOT print "Nothing to reconcile" or "Reconciled tasks" header
    assert.ok(!allLog.includes("Nothing to reconcile"));
    assert.ok(!allLog.includes("Reconciled tasks:"));
    assert.ok(!allLog.includes("task(s) reconciled"));

    // Should print orphan warning
    const allStderr = stderrOutput.join("");
    assert.ok(allStderr.includes("3 orphaned worktree(s) cleaned up"));
  });

  it("truncates long task titles in the table", () => {
    const longTitle = "A very long task title that exceeds the forty character column width limit";
    const result: ReconcileResult = {
      reconciled: [
        { id: "task-050", title: longTitle, action: "marked done" },
      ],
      orphanedCleaned: 0,
    };
    printReconcileReport(result, false);

    const allLog = logOutput.join("\n");
    // Should be truncated with "..."
    assert.ok(allLog.includes("..."));
    // Should NOT contain the full title
    assert.ok(!allLog.includes(longTitle));
    // But should contain the beginning
    assert.ok(allLog.includes("A very long task title that exceeds t"));
  });
});
