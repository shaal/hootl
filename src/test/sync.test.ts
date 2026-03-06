import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { LocalTaskBackend } from "../tasks/local.js";
import { syncReviewTasks } from "../sync.js";

describe("syncReviewTasks", () => {
  let tmpDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-sync-test-"));
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

  it("promotes a review task to done when its branch has been merged and deleted", async () => {
    // Create a task branch, commit, merge, and delete it
    await execa("git", ["checkout", "-b", "hootl/task-901-feature-a"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "feature-a.txt"), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "feature a"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });
    await execa("git", ["merge", "hootl/task-901-feature-a"], { cwd: tmpDir });
    await execa("git", ["branch", "-d", "hootl/task-901-feature-a"], { cwd: tmpDir });

    // Create the task in review state with the branch recorded
    const task = await backend.createTask({ title: "Feature A", description: "desc" });
    await backend.updateTask(task.id, {
      state: "review",
      branch: "hootl/task-901-feature-a",
      confidence: 95,
    });

    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 1);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("promotes a review task to done when its branch still exists but is merged", async () => {
    // Create a branch, commit, merge, but keep the branch
    await execa("git", ["checkout", "-b", "hootl/task-902-feature-b"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "feature-b.txt"), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "feature b"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });
    await execa("git", ["merge", "hootl/task-902-feature-b"], { cwd: tmpDir });
    // Branch NOT deleted — simulates user who merges but forgets to delete

    const task = await backend.createTask({ title: "Feature B", description: "desc" });
    await backend.updateTask(task.id, {
      state: "review",
      branch: "hootl/task-902-feature-b",
      confidence: 96,
    });

    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 1);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
  });

  it("does not promote a review task whose branch is unmerged", async () => {
    // Create a branch with a commit that is NOT merged into main
    await execa("git", ["checkout", "-b", "hootl/task-903-wip"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "wip.txt"), "work in progress");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "wip"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });

    const task = await backend.createTask({ title: "WIP Feature", description: "desc" });
    await backend.updateTask(task.id, {
      state: "review",
      branch: "hootl/task-903-wip",
      confidence: 80,
    });

    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 0);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "review");
  });

  it("skips review tasks with branch: null", async () => {
    const task = await backend.createTask({ title: "No Branch", description: "desc" });
    await backend.updateTask(task.id, { state: "review", confidence: 90 });

    // Should not crash or promote
    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 0);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "review");
  });

  it("returns 0 when there are no review tasks", async () => {
    // Create a task that is NOT in review state
    const task = await backend.createTask({ title: "Ready Task", description: "desc" });
    // Default state is "ready" — should be ignored
    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 0);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "ready");
  });

  it("clears worktree field when promoting a review task with a worktree to done", async () => {
    // Create a task branch, commit, merge, and delete it
    await execa("git", ["checkout", "-b", "hootl/task-906-worktree-cleanup"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "worktree-cleanup.txt"), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "worktree cleanup feature"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });
    await execa("git", ["merge", "hootl/task-906-worktree-cleanup"], { cwd: tmpDir });
    await execa("git", ["branch", "-d", "hootl/task-906-worktree-cleanup"], { cwd: tmpDir });

    // Create a fake worktree directory (not a real git worktree — removeWorktree will fail silently)
    const worktreePath = join(tmpDir, ".hootl", "worktrees", "task-906");
    await mkdir(worktreePath, { recursive: true });

    const task = await backend.createTask({ title: "Worktree Cleanup", description: "desc" });
    await backend.updateTask(task.id, {
      state: "review",
      branch: "hootl/task-906-worktree-cleanup",
      confidence: 97,
      worktree: worktreePath,
    });

    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 1);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
    // Worktree field should be nulled out even though removeWorktree failed on the fake directory
    assert.equal(updated.worktree, null);
  });

  it("promotes normally when task has no worktree", async () => {
    // Create a task branch, commit, merge, and delete it
    await execa("git", ["checkout", "-b", "hootl/task-907-no-worktree"], { cwd: tmpDir });
    await writeFile(join(tmpDir, "no-worktree.txt"), "done");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "no worktree feature"], { cwd: tmpDir });
    await execa("git", ["checkout", "main"], { cwd: tmpDir });
    await execa("git", ["merge", "hootl/task-907-no-worktree"], { cwd: tmpDir });
    await execa("git", ["branch", "-d", "hootl/task-907-no-worktree"], { cwd: tmpDir });

    const task = await backend.createTask({ title: "No Worktree", description: "desc" });
    await backend.updateTask(task.id, {
      state: "review",
      branch: "hootl/task-907-no-worktree",
      confidence: 96,
      // worktree is null by default
    });

    const promoted = await syncReviewTasks(backend);
    assert.equal(promoted, 1);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "done");
    assert.equal(updated.worktree, null);
  });
});
