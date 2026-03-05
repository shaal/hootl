import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskBackend } from "../tasks/local.js";
import { TaskSchema } from "../tasks/types.js";
import { findRunnableTask } from "../selection.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-test-pri-"));
}

describe("userPriority schema", () => {
  it("defaults to null when field is missing from JSON", () => {
    const raw = {
      id: "task-001",
      title: "Test",
      description: "Desc",
      priority: "medium",
      state: "ready",
      dependencies: [],
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      blockers: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    // No userPriority field — Zod's .default(null) should handle it
    const parsed = TaskSchema.parse(raw);
    assert.equal(parsed.userPriority, null);
  });

  it("preserves explicit userPriority value", () => {
    const raw = {
      id: "task-001",
      title: "Test",
      description: "Desc",
      priority: "medium",
      state: "ready",
      dependencies: [],
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      userPriority: 3,
      blockers: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const parsed = TaskSchema.parse(raw);
    assert.equal(parsed.userPriority, 3);
  });
});

describe("userPriority sort order", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("tasks with userPriority sort before tasks without", async () => {
    // Create a critical task (no userPriority) and a low task (with userPriority)
    const critical = await backend.createTask({
      title: "Critical no override",
      description: "Critical",
      priority: "critical",
    });
    const low = await backend.createTask({
      title: "Low with override",
      description: "Low",
      priority: "low",
    });

    // Give the low-priority task a userPriority
    await backend.updateTask(low.id, { userPriority: 1 });

    const tasks = await backend.listTasks();
    assert.equal(tasks[0]!.id, low.id, "userPriority task should come first");
    assert.equal(tasks[1]!.id, critical.id);
  });

  it("userPriority tasks sort ascending by number", async () => {
    const t1 = await backend.createTask({ title: "A", description: "A", priority: "low" });
    const t2 = await backend.createTask({ title: "B", description: "B", priority: "low" });
    const t3 = await backend.createTask({ title: "C", description: "C", priority: "low" });

    await backend.updateTask(t1.id, { userPriority: 3 });
    await backend.updateTask(t2.id, { userPriority: 1 });
    await backend.updateTask(t3.id, { userPriority: 2 });

    const tasks = await backend.listTasks();
    assert.equal(tasks[0]!.id, t2.id, "userPriority 1 first");
    assert.equal(tasks[1]!.id, t3.id, "userPriority 2 second");
    assert.equal(tasks[2]!.id, t1.id, "userPriority 3 third");
  });

  it("tasks without userPriority still sort by priority then createdAt", async () => {
    await backend.createTask({ title: "Low", description: "L", priority: "low" });
    await backend.createTask({ title: "High", description: "H", priority: "high" });
    await backend.createTask({ title: "Critical", description: "C", priority: "critical" });

    const tasks = await backend.listTasks();
    assert.equal(tasks[0]!.priority, "critical");
    assert.equal(tasks[1]!.priority, "high");
    assert.equal(tasks[2]!.priority, "low");
  });

  it("createTask defaults userPriority to null", async () => {
    const task = await backend.createTask({ title: "Test", description: "Test" });
    assert.equal(task.userPriority, null);
  });

  it("clearing userPriority reverts to automatic ordering", async () => {
    const low = await backend.createTask({ title: "Low", description: "L", priority: "low" });
    const critical = await backend.createTask({ title: "Critical", description: "C", priority: "critical" });

    // Set low task as #1
    await backend.updateTask(low.id, { userPriority: 1 });
    let tasks = await backend.listTasks();
    assert.equal(tasks[0]!.id, low.id);

    // Clear it
    await backend.updateTask(low.id, { userPriority: null });
    tasks = await backend.listTasks();
    assert.equal(tasks[0]!.id, critical.id, "critical should be first after clearing userPriority");
  });
});

describe("findRunnableTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns first candidate when it has no dependencies", async () => {
    const t1 = await backend.createTask({ title: "No deps", description: "None" });
    const t2 = await backend.createTask({ title: "Also no deps", description: "None" });

    const { task, skipped } = await findRunnableTask([t1, t2], backend);
    assert.equal(task!.id, t1.id);
    assert.equal(skipped.length, 0);
  });

  it("skips candidate with unmet dependencies and returns next", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "Dep" });
    const t1 = await backend.createTask({
      title: "Has dep",
      description: "Depends on dep",
      dependencies: [dep.id],
    });
    const t2 = await backend.createTask({ title: "No deps", description: "Free" });

    // dep is in 'ready' state, not 'done' or 'review'
    const { task, skipped } = await findRunnableTask([t1, t2], backend);
    assert.equal(task!.id, t2.id);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0]!.reason.includes(dep.id));
    assert.ok(skipped[0]!.reason.includes("ready"));
  });

  it("returns candidate whose dependencies are all done", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "Dep" });
    await backend.updateTask(dep.id, { state: "done" });

    const t1 = await backend.createTask({
      title: "Has met dep",
      description: "Dep is done",
      dependencies: [dep.id],
    });

    const { task, skipped } = await findRunnableTask([t1], backend);
    assert.equal(task!.id, t1.id);
    assert.equal(skipped.length, 0);
  });

  it("returns candidate whose dependencies are in review", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "Dep" });
    await backend.updateTask(dep.id, { state: "review" });

    const t1 = await backend.createTask({
      title: "Has met dep",
      description: "Dep is in review",
      dependencies: [dep.id],
    });

    const { task, skipped } = await findRunnableTask([t1], backend);
    assert.equal(task!.id, t1.id);
    assert.equal(skipped.length, 0);
  });

  it("returns undefined when all candidates have unmet dependencies", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "Dep" });

    const t1 = await backend.createTask({
      title: "Blocked 1",
      description: "Blocked",
      dependencies: [dep.id],
    });
    const t2 = await backend.createTask({
      title: "Blocked 2",
      description: "Also blocked",
      dependencies: [dep.id],
    });

    const { task, skipped } = await findRunnableTask([t1, t2], backend);
    assert.equal(task, undefined);
    assert.equal(skipped.length, 2);
  });

  it("handles missing dependency task gracefully", async () => {
    const t1 = await backend.createTask({
      title: "Bad dep",
      description: "Depends on nonexistent",
      dependencies: ["task-999"],
    });

    const { task, skipped } = await findRunnableTask([t1], backend);
    assert.equal(task, undefined);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0]!.reason.includes("not found"));
  });

  it("returns empty result for empty candidates list", async () => {
    const { task, skipped } = await findRunnableTask([], backend);
    assert.equal(task, undefined);
    assert.equal(skipped.length, 0);
  });
});
