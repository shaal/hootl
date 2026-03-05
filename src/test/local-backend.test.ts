import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getNextTaskId, LocalTaskBackend } from "../tasks/local.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-test-"));
}

describe("getNextTaskId", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns task-001 for empty directory", async () => {
    const id = await getNextTaskId(tempDir);
    assert.equal(id, "task-001");
  });

  it("returns task-001 for non-existent directory", async () => {
    const id = await getNextTaskId(join(tempDir, "nonexistent"));
    assert.equal(id, "task-001");
  });

  it("returns task-003 when task-001 and task-002 exist", async () => {
    await mkdir(join(tempDir, "task-001"));
    await mkdir(join(tempDir, "task-002"));
    const id = await getNextTaskId(tempDir);
    assert.equal(id, "task-003");
  });

  it("ignores non-task directories", async () => {
    await mkdir(join(tempDir, "task-001"));
    await mkdir(join(tempDir, "task-002"));
    await mkdir(join(tempDir, "random-dir"));
    await mkdir(join(tempDir, ".hidden"));
    await mkdir(join(tempDir, "notes"));
    const id = await getNextTaskId(tempDir);
    assert.equal(id, "task-003");
  });
});

describe("LocalTaskBackend.createTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates task directory and task.json", async () => {
    const task = await backend.createTask({
      title: "Test task",
      description: "A test description",
    });

    assert.equal(task.id, "task-001");

    const taskJsonPath = join(tempDir, "task-001", "task.json");
    const raw = await readFile(taskJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.title, "Test task");
    assert.equal(parsed.description, "A test description");
  });

  it("defaults state to ready and priority to medium", async () => {
    const task = await backend.createTask({
      title: "Defaults test",
      description: "Check defaults",
    });

    assert.equal(task.state, "ready");
    assert.equal(task.priority, "medium");
  });

  it("creates empty ancillary files", async () => {
    await backend.createTask({
      title: "Files test",
      description: "Check files",
    });

    const taskDir = join(tempDir, "task-001");
    const files = ["plan.md", "progress.md", "test_results.md", "blockers.md"];

    for (const file of files) {
      const content = await readFile(join(taskDir, file), "utf-8");
      assert.equal(content, "", `${file} should be empty`);
    }
  });

  it("assigns sequential IDs", async () => {
    const t1 = await backend.createTask({
      title: "First",
      description: "First task",
    });
    const t2 = await backend.createTask({
      title: "Second",
      description: "Second task",
    });
    const t3 = await backend.createTask({
      title: "Third",
      description: "Third task",
    });

    assert.equal(t1.id, "task-001");
    assert.equal(t2.id, "task-002");
    assert.equal(t3.id, "task-003");
  });
});

describe("LocalTaskBackend.getTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns task by ID", async () => {
    const created = await backend.createTask({
      title: "Retrievable",
      description: "Should be found",
    });

    const fetched = await backend.getTask("task-001");
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.title, "Retrievable");
    assert.equal(fetched.description, "Should be found");
  });

  it("throws on non-existent ID", async () => {
    await assert.rejects(
      () => backend.getTask("task-999"),
      { message: "Task not found: task-999" },
    );
  });
});

describe("LocalTaskBackend.listTasks", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns all tasks sorted by priority then createdAt", async () => {
    await backend.createTask({
      title: "Low priority",
      description: "Low",
      priority: "low",
    });
    await backend.createTask({
      title: "High priority",
      description: "High",
      priority: "high",
    });
    await backend.createTask({
      title: "Critical priority",
      description: "Critical",
      priority: "critical",
    });

    const tasks = await backend.listTasks();
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0]!.priority, "critical");
    assert.equal(tasks[1]!.priority, "high");
    assert.equal(tasks[2]!.priority, "low");
  });

  it("filters by state", async () => {
    const t1 = await backend.createTask({
      title: "Ready task",
      description: "Ready",
    });
    await backend.createTask({
      title: "Another ready",
      description: "Also ready",
    });

    // Update one to in_progress
    await backend.updateTask(t1.id, { state: "in_progress" });

    const readyTasks = await backend.listTasks({ state: "ready" });
    assert.equal(readyTasks.length, 1);
    assert.equal(readyTasks[0]!.title, "Another ready");

    const inProgressTasks = await backend.listTasks({ state: "in_progress" });
    assert.equal(inProgressTasks.length, 1);
    assert.equal(inProgressTasks[0]!.title, "Ready task");
  });

  it("filters by priority", async () => {
    await backend.createTask({
      title: "High",
      description: "High",
      priority: "high",
    });
    await backend.createTask({
      title: "Low",
      description: "Low",
      priority: "low",
    });
    await backend.createTask({
      title: "Also high",
      description: "High",
      priority: "high",
    });

    const highTasks = await backend.listTasks({ priority: "high" });
    assert.equal(highTasks.length, 2);
    assert.ok(highTasks.every((t) => t.priority === "high"));
  });

  it("returns empty array for empty directory", async () => {
    const tasks = await backend.listTasks();
    assert.deepEqual(tasks, []);
  });
});

describe("LocalTaskBackend.updateTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("updates fields and sets updatedAt", async () => {
    const created = await backend.createTask({
      title: "Original",
      description: "Original desc",
    });

    const updated = await backend.updateTask(created.id, {
      title: "Updated",
      state: "in_progress",
    });

    assert.equal(updated.title, "Updated");
    assert.equal(updated.state, "in_progress");
    assert.notEqual(updated.updatedAt, created.updatedAt);
  });

  it("preserves ID even if override is attempted", async () => {
    const created = await backend.createTask({
      title: "Keep ID",
      description: "ID should not change",
    });

    const updated = await backend.updateTask(created.id, {
      id: "task-999",
    } as Partial<import("../tasks/types.js").Task>);

    assert.equal(updated.id, created.id);
  });

  it("validates with zod (rejects invalid priority)", async () => {
    const created = await backend.createTask({
      title: "Validate me",
      description: "Should validate",
    });

    await assert.rejects(
      () =>
        backend.updateTask(created.id, {
          priority: "ultra" as never,
        }),
    );
  });
});

describe("LocalTaskBackend.deleteTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the task directory", async () => {
    await backend.createTask({
      title: "Delete me",
      description: "Will be deleted",
    });

    // Verify it exists
    const entries = await readdir(tempDir);
    assert.ok(entries.includes("task-001"));

    await backend.deleteTask("task-001");

    const entriesAfter = await readdir(tempDir);
    assert.ok(!entriesAfter.includes("task-001"));
  });
});
