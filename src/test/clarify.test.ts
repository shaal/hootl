import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LocalTaskBackend } from "../tasks/local.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-clarify-test-"));
}

describe("clarify flow — blocked task with blockers can be resolved", () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should resolve a blocked task back to ready with empty blockers", async () => {
    tmpDir = await makeTempDir();
    const tasksDir = join(tmpDir, "tasks");
    backend = new LocalTaskBackend(tasksDir);

    // Create a task
    const task = await backend.createTask({
      title: "Implement API endpoint",
      description: "Build the /users endpoint",
    });

    // Block it with blockers
    const blocked = await backend.updateTask(task.id, {
      state: "blocked",
      blockers: ["Need clarification on API format"],
    });
    assert.equal(blocked.state, "blocked");
    assert.deepEqual(blocked.blockers, ["Need clarification on API format"]);

    // Write blocker content to blockers.md (as clarifyCommand does)
    const blockersPath = join(tasksDir, task.id, "blockers.md");
    await writeFile(
      blockersPath,
      "## Blocker\nNeed clarification on API format\n",
      "utf-8",
    );

    // Simulate resolution: write answer to blockers.md, update task
    const existingContent = await readFile(blockersPath, "utf-8");
    const timestamp = "2026-03-05T12:00:00.000Z";
    const updatedContent =
      existingContent +
      `\n---\n## Resolution (${timestamp})\nUse JSON:API format with camelCase fields.\n`;
    await writeFile(blockersPath, updatedContent, "utf-8");

    const resolved = await backend.updateTask(task.id, {
      state: "ready",
      blockers: [],
    });

    // Verify task state
    assert.equal(resolved.state, "ready");
    assert.deepEqual(resolved.blockers, []);

    // Verify blockers.md contains resolution text
    const finalContent = await readFile(blockersPath, "utf-8");
    assert.ok(finalContent.includes("Use JSON:API format with camelCase fields."));
    assert.ok(finalContent.includes("Resolution"));
  });
});

describe("clarify flow — multiple blocked tasks can be listed and resolved independently", () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should list only blocked tasks and resolve them independently", async () => {
    tmpDir = await makeTempDir();
    const tasksDir = join(tmpDir, "tasks");
    backend = new LocalTaskBackend(tasksDir);

    // Create 3 tasks
    const task1 = await backend.createTask({
      title: "Task A",
      description: "First task",
    });
    const task2 = await backend.createTask({
      title: "Task B",
      description: "Second task",
    });
    const task3 = await backend.createTask({
      title: "Task C",
      description: "Third task",
    });

    // Block 2 of them with different blockers
    await backend.updateTask(task1.id, {
      state: "blocked",
      blockers: ["Missing DB schema"],
    });
    await backend.updateTask(task3.id, {
      state: "blocked",
      blockers: ["Waiting for design review"],
    });

    // List blocked tasks
    const blockedTasks = await backend.listTasks({ state: "blocked" });
    assert.equal(blockedTasks.length, 2);

    const blockedIds = blockedTasks.map((t) => t.id);
    assert.ok(blockedIds.includes(task1.id));
    assert.ok(blockedIds.includes(task3.id));
    assert.ok(!blockedIds.includes(task2.id));

    // Resolve one
    await backend.updateTask(task1.id, {
      state: "ready",
      blockers: [],
    });

    // Verify the other is still blocked
    const stillBlocked = await backend.listTasks({ state: "blocked" });
    assert.equal(stillBlocked.length, 1);
    assert.equal(stillBlocked[0]!.id, task3.id);
    assert.deepEqual(stillBlocked[0]!.blockers, ["Waiting for design review"]);

    // Verify resolved task is ready
    const readyTasks = await backend.listTasks({ state: "ready" });
    const resolvedTask = readyTasks.find((t) => t.id === task1.id);
    assert.ok(resolvedTask);
    assert.equal(resolvedTask.state, "ready");
    assert.deepEqual(resolvedTask.blockers, []);
  });
});

describe("clarify flow — resolving a task preserves other task fields", () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should preserve priority and other fields after resolution", async () => {
    tmpDir = await makeTempDir();
    const tasksDir = join(tmpDir, "tasks");
    backend = new LocalTaskBackend(tasksDir);

    // Create task with high priority
    const task = await backend.createTask({
      title: "Critical fix",
      description: "Fix the auth bug",
      priority: "high",
    });

    // Block it
    await backend.updateTask(task.id, {
      state: "blocked",
      blockers: ["Need repro steps"],
      confidence: 42,
      attempts: 2,
      totalCost: 1.5,
    });

    // Resolve it
    const resolved = await backend.updateTask(task.id, {
      state: "ready",
      blockers: [],
    });

    // Verify state changed
    assert.equal(resolved.state, "ready");
    assert.deepEqual(resolved.blockers, []);

    // Verify other fields preserved
    assert.equal(resolved.priority, "high");
    assert.equal(resolved.title, "Critical fix");
    assert.equal(resolved.description, "Fix the auth bug");
    assert.equal(resolved.confidence, 42);
    assert.equal(resolved.attempts, 2);
    assert.equal(resolved.totalCost, 1.5);
    assert.equal(resolved.id, task.id);
  });
});

describe("clarify flow — blocked task with empty blockers array can be marked ready", () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should transition from blocked with empty blockers to ready", async () => {
    tmpDir = await makeTempDir();
    const tasksDir = join(tmpDir, "tasks");
    backend = new LocalTaskBackend(tasksDir);

    const task = await backend.createTask({
      title: "Unclear task",
      description: "Something needs doing",
    });

    // Block with empty blockers array
    const blocked = await backend.updateTask(task.id, {
      state: "blocked",
      blockers: [],
    });
    assert.equal(blocked.state, "blocked");
    assert.deepEqual(blocked.blockers, []);

    // Mark as ready
    const ready = await backend.updateTask(task.id, {
      state: "ready",
    });
    assert.equal(ready.state, "ready");
    assert.deepEqual(ready.blockers, []);
  });
});

describe("clarify flow — blockers.md accumulates resolution history", () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("should accumulate multiple resolutions in blockers.md", async () => {
    tmpDir = await makeTempDir();
    const tasksDir = join(tmpDir, "tasks");
    backend = new LocalTaskBackend(tasksDir);

    const task = await backend.createTask({
      title: "Complex task",
      description: "Needs multiple rounds of clarification",
    });

    const blockersPath = join(tasksDir, task.id, "blockers.md");

    // First round: block, write blockers, resolve
    await backend.updateTask(task.id, {
      state: "blocked",
      blockers: ["What auth provider to use?"],
    });

    await writeFile(
      blockersPath,
      "## Blocker\nWhat auth provider to use?\n",
      "utf-8",
    );

    const content1 = await readFile(blockersPath, "utf-8");
    const resolution1 =
      content1 +
      "\n---\n## Resolution (2026-03-05T10:00:00.000Z)\nUse Auth0 for SSO.\n";
    await writeFile(blockersPath, resolution1, "utf-8");

    await backend.updateTask(task.id, {
      state: "ready",
      blockers: [],
    });

    // Second round: block again with new blockers, resolve again
    await backend.updateTask(task.id, {
      state: "blocked",
      blockers: ["What scopes are needed for the token?"],
    });

    const content2 = await readFile(blockersPath, "utf-8");
    const resolution2 =
      content2 +
      "\n---\n## Resolution (2026-03-05T14:00:00.000Z)\nNeed openid, profile, and email scopes.\n";
    await writeFile(blockersPath, resolution2, "utf-8");

    await backend.updateTask(task.id, {
      state: "ready",
      blockers: [],
    });

    // Verify both resolutions are present
    const finalContent = await readFile(blockersPath, "utf-8");
    assert.ok(finalContent.includes("Use Auth0 for SSO."));
    assert.ok(finalContent.includes("Need openid, profile, and email scopes."));
    assert.ok(finalContent.includes("2026-03-05T10:00:00.000Z"));
    assert.ok(finalContent.includes("2026-03-05T14:00:00.000Z"));

    // Verify task is back to ready
    const finalTask = await backend.getTask(task.id);
    assert.equal(finalTask.state, "ready");
    assert.deepEqual(finalTask.blockers, []);
  });
});
