import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { LocalTaskBackend } from "../tasks/local.js";
import { reconcileTasks } from "../reconcile.js";

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
    // Create a task
    const task = await backend.createTask({ title: "Landed Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-feature.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} implement landed feature`], { cwd: tmpDir });

    const result = await reconcileTasks(backend);

    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0]!.id, task.id);
    assert.ok(result.reconciled[0]!.action.includes("marked done"));

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("does not change a task without commits on main", async () => {
    const task = await backend.createTask({ title: "Untouched Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    const result = await reconcileTasks(backend);

    // This task should not be in reconciled list
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.equal(found, undefined);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");
  });

  it("cleans up a stale branch when reconciling a task", async () => {
    // Create a task with a branch
    const task = await backend.createTask({ title: "Branch Cleanup", description: "desc" });
    const branchName = `hootl/${task.id}-branch-cleanup`;
    await backend.updateTask(task.id, { state: "ready", branch: branchName });

    // Create the branch (so it exists locally)
    await execa("git", ["branch", branchName], { cwd: tmpDir });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-branch.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} branch cleanup feature`], { cwd: tmpDir });

    const result = await reconcileTasks(backend);

    // Task should be reconciled
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);
    assert.ok(found.action.includes("branch cleaned"));

    // Branch should be deleted
    const branchList = await execa("git", ["branch", "--list", branchName], { cwd: tmpDir });
    assert.equal(branchList.stdout.trim(), "");

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("detects and cleans orphaned worktree directories", async () => {
    // Create a task already in done state
    const task = await backend.createTask({ title: "Done With Orphan", description: "desc" });
    await backend.updateTask(task.id, { state: "done" });

    // Create a fake worktree directory for this done task
    const worktreesDir = join(tmpDir, ".hootl", "worktrees");
    const orphanDir = join(worktreesDir, task.id);
    await mkdir(orphanDir, { recursive: true });

    const result = await reconcileTasks(backend);

    // The orphaned worktree directory should be counted
    assert.ok(result.orphanedCleaned > 0);
  });

  it("dry-run produces no side effects", async () => {
    // Create a task
    const task = await backend.createTask({ title: "Dry Run Feature", description: "desc" });
    await backend.updateTask(task.id, { state: "in_progress" });

    // Make a commit on main that references the task ID
    await writeFile(join(tmpDir, `${task.id}-dryrun.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} dry run feature`], { cwd: tmpDir });

    const result = await reconcileTasks(backend, { dryRun: true });

    // Should report what would be reconciled
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.ok(found !== undefined);

    // But the task state should NOT be changed
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");
  });

  it("skips tasks already in done state", async () => {
    // Create a task already in done state
    const task = await backend.createTask({ title: "Already Done", description: "desc" });
    await backend.updateTask(task.id, { state: "done" });

    // Make a commit on main referencing this task
    await writeFile(join(tmpDir, `${task.id}-already-done.txt`), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", `${task.id} already done task`], { cwd: tmpDir });

    const result = await reconcileTasks(backend);

    // This task should NOT appear in reconciled list
    const found = result.reconciled.find((r) => r.id === task.id);
    assert.equal(found, undefined);
  });
});
