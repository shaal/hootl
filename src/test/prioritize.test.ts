import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskBackend } from "../tasks/local.js";
import { TaskSchema } from "../tasks/types.js";
import type { Task } from "../tasks/types.js";
import { findRunnableTask, sortByStrategy, getNextTask } from "../selection.js";
import { ConfigSchema } from "../config.js";
import type { Config } from "../config.js";
import { makeTask } from "./helpers.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-test-pri-"));
}

describe("userPriority schema", () => {
  it("defaults to null when field is missing from JSON", () => {
    // No userPriority field — Zod's .default(null) should handle it
    const { userPriority: _, ...raw } = makeTask();
    const parsed = TaskSchema.parse(raw);
    assert.equal(parsed.userPriority, null);
  });

  it("preserves explicit userPriority value", () => {
    const raw = makeTask({ userPriority: 3 });
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

// ---------------------------------------------------------------------------
// sortByStrategy
// ---------------------------------------------------------------------------

describe("sortByStrategy", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fifo strategy returns tasks in original order", async () => {
    const t1 = await backend.createTask({ title: "A", description: "A", effort: 5 });
    const t2 = await backend.createTask({ title: "B", description: "B", effort: 1 });
    const t3 = await backend.createTask({ title: "C", description: "C", effort: 3 });

    const result = sortByStrategy([t1, t2, t3], "fifo");
    assert.deepEqual(
      result.map(t => t.id),
      [t1.id, t2.id, t3.id],
      "fifo should preserve original order regardless of effort",
    );
  });

  it("quick-wins-first sorts lower effort first within same tier", async () => {
    const t1 = await backend.createTask({ title: "Big", description: "Big", effort: 5 });
    const t2 = await backend.createTask({ title: "Small", description: "Small", effort: 1 });
    const t3 = await backend.createTask({ title: "Mid", description: "Mid", effort: 3 });

    const result = sortByStrategy([t1, t2, t3], "quick-wins-first");
    assert.deepEqual(
      result.map(t => t.effort),
      [1, 3, 5],
      "should sort ascending by effort",
    );
  });

  it("big-items-first sorts higher effort first within same tier", async () => {
    const t1 = await backend.createTask({ title: "Big", description: "Big", effort: 5 });
    const t2 = await backend.createTask({ title: "Small", description: "Small", effort: 1 });
    const t3 = await backend.createTask({ title: "Mid", description: "Mid", effort: 3 });

    const result = sortByStrategy([t1, t2, t3], "big-items-first");
    assert.deepEqual(
      result.map(t => t.effort),
      [5, 3, 1],
      "should sort descending by effort",
    );
  });

  it("cross-tier ordering is preserved regardless of strategy", async () => {
    // Create tasks at different priority levels
    const critical = await backend.createTask({
      title: "Critical big",
      description: "C",
      priority: "critical",
      effort: 5,
    });
    const medium = await backend.createTask({
      title: "Medium small",
      description: "M",
      priority: "medium",
      effort: 1,
    });

    // Even with quick-wins-first, critical (effort=5) should still come before medium (effort=1)
    // because they are in different priority tiers
    const result = sortByStrategy([critical, medium], "quick-wins-first");
    assert.equal(result[0]!.id, critical.id, "critical should remain first despite higher effort");
    assert.equal(result[1]!.id, medium.id, "medium should remain second despite lower effort");
  });

  it("null effort sorts last within tier", async () => {
    const withEffort = await backend.createTask({
      title: "Has effort",
      description: "E",
      effort: 3,
    });
    const noEffort = await backend.createTask({
      title: "No effort",
      description: "N",
    });
    // noEffort has effort: null by default

    // quick-wins-first: null should come after 3
    const qw = sortByStrategy([noEffort, withEffort], "quick-wins-first");
    assert.equal(qw[0]!.id, withEffort.id, "task with effort should come first (quick-wins)");
    assert.equal(qw[1]!.id, noEffort.id, "null effort should come last (quick-wins)");

    // big-items-first: null should also come after 3
    const bi = sortByStrategy([noEffort, withEffort], "big-items-first");
    assert.equal(bi[0]!.id, withEffort.id, "task with effort should come first (big-items)");
    assert.equal(bi[1]!.id, noEffort.id, "null effort should come last (big-items)");
  });

  it("all null efforts preserve original order within tier", async () => {
    const t1 = await backend.createTask({ title: "First", description: "1" });
    const t2 = await backend.createTask({ title: "Second", description: "2" });
    const t3 = await backend.createTask({ title: "Third", description: "3" });
    // All have effort: null (default)

    const qw = sortByStrategy([t1, t2, t3], "quick-wins-first");
    assert.deepEqual(
      qw.map(t => t.id),
      [t1.id, t2.id, t3.id],
      "null efforts should preserve original order (quick-wins)",
    );

    const bi = sortByStrategy([t1, t2, t3], "big-items-first");
    assert.deepEqual(
      bi.map(t => t.id),
      [t1.id, t2.id, t3.id],
      "null efforts should preserve original order (big-items)",
    );
  });

  it("mixed userPriority tiers stay separated", async () => {
    // userPriority tasks form a separate tier from non-userPriority tasks
    const promoted = await backend.createTask({
      title: "Promoted low effort",
      description: "P",
      priority: "low",
      effort: 1,
    });
    await backend.updateTask(promoted.id, { userPriority: 1 });
    const promotedUpdated = await backend.getTask(promoted.id);

    const normal = await backend.createTask({
      title: "Normal high effort",
      description: "N",
      priority: "low",
      effort: 5,
    });

    // With big-items-first, within the same tier effort=5 would beat effort=1.
    // But these are in different tiers (userPriority=1 vs userPriority=null),
    // so the promoted task must remain first.
    const result = sortByStrategy([promotedUpdated, normal], "big-items-first");
    assert.equal(result[0]!.id, promoted.id, "userPriority task should stay in its tier position");
    assert.equal(result[1]!.id, normal.id, "non-userPriority task should stay in its tier position");
  });

  it("empty array returns empty", () => {
    const result = sortByStrategy([], "quick-wins-first");
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// getNextTask
// ---------------------------------------------------------------------------

describe("getNextTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: { orderingStrategy?: string }): Config {
    return ConfigSchema.parse({
      auto: {
        orderingStrategy: overrides?.orderingStrategy ?? "fifo",
      },
    });
  }

  it("returns highest-priority ready task", async () => {
    await backend.createTask({ title: "Low", description: "L", priority: "low" });
    const critical = await backend.createTask({ title: "Critical", description: "C", priority: "critical" });
    await backend.createTask({ title: "Medium", description: "M", priority: "medium" });

    const config = makeConfig();
    const { task } = await getNextTask(backend, config);
    assert.equal(task!.id, critical.id, "should select the critical-priority task");
  });

  it("respects ordering strategy from config (quick-wins-first)", async () => {
    // Two same-priority tasks with different efforts
    const big = await backend.createTask({ title: "Big task", description: "B", effort: 5 });
    const small = await backend.createTask({ title: "Small task", description: "S", effort: 1 });

    // With quick-wins-first, the lower-effort task should be selected
    const config = makeConfig({ orderingStrategy: "quick-wins-first" });
    const { task } = await getNextTask(backend, config);
    assert.equal(task!.id, small.id, "quick-wins-first should pick the lower-effort task");
  });

  it("respects ordering strategy from config (big-items-first)", async () => {
    // Two same-priority tasks with different efforts
    const big = await backend.createTask({ title: "Big task", description: "B", effort: 5 });
    const small = await backend.createTask({ title: "Small task", description: "S", effort: 1 });

    // With big-items-first, the higher-effort task should be selected
    const config = makeConfig({ orderingStrategy: "big-items-first" });
    const { task } = await getNextTask(backend, config);
    assert.equal(task!.id, big.id, "big-items-first should pick the higher-effort task");
  });

  it("filters by goal when goalId provided", async () => {
    const goalA = await backend.createTask({ title: "Goal A task", description: "A" });
    await backend.updateTask(goalA.id, { goal: "goal-a" });

    const goalB = await backend.createTask({ title: "Goal B task", description: "B" });
    await backend.updateTask(goalB.id, { goal: "goal-b" });

    const config = makeConfig();
    const { task } = await getNextTask(backend, config, { goalId: "goal-b" });
    assert.equal(task!.id, goalB.id, "should select only from the specified goal");
  });

  it("skips tasks with unmet dependencies", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "Dep" });
    // dep is in 'ready' state — not done/review
    const blocked = await backend.createTask({
      title: "Blocked",
      description: "Needs dep",
      dependencies: [dep.id],
    });
    const free = await backend.createTask({ title: "Free", description: "No deps" });

    const config = makeConfig();
    const { task, skipped } = await getNextTask(backend, config);

    // The dependency task itself (dep) would be selected first since it has no deps
    // and appears before `blocked` in priority order (both medium).
    // But let's verify it picks an eligible task and skips the blocked one when appropriate.
    assert.ok(task !== undefined, "should find an eligible task");
    assert.notEqual(task!.id, blocked.id, "should not select the task with unmet dependencies");
  });

  it("returns undefined when no tasks available", async () => {
    const config = makeConfig();
    const { task, skipped } = await getNextTask(backend, config);
    assert.equal(task, undefined, "should return undefined for empty queue");
    assert.equal(skipped.length, 0);
  });

  it("returns undefined when all tasks have unmet dependencies", async () => {
    const dep = await backend.createTask({ title: "Dep", description: "D" });
    await backend.updateTask(dep.id, { state: "in_progress" }); // not ready, won't be listed

    const t1 = await backend.createTask({
      title: "Blocked 1",
      description: "B1",
      dependencies: [dep.id],
    });
    const t2 = await backend.createTask({
      title: "Blocked 2",
      description: "B2",
      dependencies: [dep.id],
    });

    const config = makeConfig();
    const { task, skipped } = await getNextTask(backend, config);
    assert.equal(task, undefined, "no eligible task should be found");
    assert.equal(skipped.length, 2, "both tasks should be skipped");
  });

  it("claims the returned task", async () => {
    const t = await backend.createTask({ title: "Claim me", description: "C" });

    const config = makeConfig();
    const { task } = await getNextTask(backend, config);
    assert.equal(task!.id, t.id);

    // Verify the task was claimed (state transitioned to in_progress)
    const updated = await backend.getTask(t.id);
    assert.equal(updated.state, "in_progress", "task should be claimed and in_progress");

    // Verify .claim file exists
    const { existsSync } = await import("node:fs");
    const claimPath = join(tempDir, t.id, ".claim");
    assert.equal(existsSync(claimPath), true, ".claim file should exist");
  });
});
