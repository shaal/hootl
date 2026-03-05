import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
});
