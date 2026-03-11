import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskBackend } from "../tasks/local.js";
import type { Task } from "../tasks/types.js";
import { topoSortTasks } from "../selection.js";
import { makeTask } from "./helpers.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-test-pri-goal-"));
}

// ---------------------------------------------------------------------------
// topoSortTasks — pure function unit tests
// ---------------------------------------------------------------------------

describe("topoSortTasks", () => {
  it("empty array returns empty array", () => {
    const result = topoSortTasks([]);
    assert.deepEqual(result, []);
  });

  it("single task returns itself", () => {
    const task = makeTask({ id: "t1" });
    const result = topoSortTasks([task]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "t1");
  });

  it("tasks with no deps preserve priority order", () => {
    const critical = makeTask({ id: "t1", priority: "critical", createdAt: "2025-01-01T00:00:00.000Z" });
    const high = makeTask({ id: "t2", priority: "high", createdAt: "2025-01-01T00:00:00.000Z" });
    const medium = makeTask({ id: "t3", priority: "medium", createdAt: "2025-01-01T00:00:00.000Z" });
    const low = makeTask({ id: "t4", priority: "low", createdAt: "2025-01-01T00:00:00.000Z" });

    const result = topoSortTasks([low, medium, high, critical]);
    assert.deepEqual(
      result.map(t => t.id),
      ["t1", "t2", "t3", "t4"],
      "should sort by priority: critical > high > medium > low",
    );
  });

  it("linear chain A→B→C produces correct order", () => {
    const a = makeTask({ id: "a", dependencies: [] });
    const b = makeTask({ id: "b", dependencies: ["a"] });
    const c = makeTask({ id: "c", dependencies: ["b"] });

    const result = topoSortTasks([c, b, a]); // scrambled input order
    assert.deepEqual(
      result.map(t => t.id),
      ["a", "b", "c"],
      "linear chain should produce a → b → c",
    );
  });

  it("diamond dependency produces valid topological order with D last", () => {
    // A → B, A → C, B → D, C → D
    const a = makeTask({ id: "a", dependencies: [] });
    const b = makeTask({ id: "b", dependencies: ["a"] });
    const c = makeTask({ id: "c", dependencies: ["a"] });
    const d = makeTask({ id: "d", dependencies: ["b", "c"] });

    const result = topoSortTasks([d, c, b, a]);
    const ids = result.map(t => t.id);

    // A must be first
    assert.equal(ids[0], "a", "a (no deps) must be first");
    // D must be last
    assert.equal(ids[3], "d", "d (depends on b and c) must be last");
    // B and C must be between A and D
    assert.ok(ids.indexOf("b") < ids.indexOf("d"), "b must come before d");
    assert.ok(ids.indexOf("c") < ids.indexOf("d"), "c must come before d");
  });

  it("external dependencies are ignored for ordering", () => {
    // Task b depends on "external-task" which is not in the set
    const a = makeTask({ id: "a", dependencies: [] });
    const b = makeTask({ id: "b", dependencies: ["external-task"] });

    const result = topoSortTasks([b, a]);
    // Both have 0 internal deps, so sorted by priority then createdAt
    assert.equal(result.length, 2);
    // Neither should be blocked by external dependency
    const ids = result.map(t => t.id);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
  });

  it("ties at same topological level respect priority field then createdAt", () => {
    const a = makeTask({ id: "root", dependencies: [] });
    const b = makeTask({
      id: "high-task",
      priority: "high",
      dependencies: ["root"],
      createdAt: "2025-01-02T00:00:00.000Z",
    });
    const c = makeTask({
      id: "critical-task",
      priority: "critical",
      dependencies: ["root"],
      createdAt: "2025-01-03T00:00:00.000Z",
    });
    const d = makeTask({
      id: "high-task-early",
      priority: "high",
      dependencies: ["root"],
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const result = topoSortTasks([d, c, b, a]);
    const ids = result.map(t => t.id);

    assert.equal(ids[0], "root", "root comes first");
    // Among the three dependents: critical first, then high with earlier createdAt, then high with later
    assert.equal(ids[1], "critical-task", "critical priority wins at same topo level");
    assert.equal(ids[2], "high-task-early", "earlier createdAt breaks high-priority tie");
    assert.equal(ids[3], "high-task", "later createdAt is last");
  });

  it("handles cycles defensively by appending remaining tasks", () => {
    // Artificial cycle: a → b → a (shouldn't happen with removeCycles, but defensive)
    const a = makeTask({ id: "a", dependencies: ["b"] });
    const b = makeTask({ id: "b", dependencies: ["a"] });
    const c = makeTask({ id: "c", dependencies: [] });

    const result = topoSortTasks([a, b, c]);
    assert.equal(result.length, 3, "all tasks should be in result despite cycle");
    // c has no deps, so it should appear
    assert.ok(result.map(t => t.id).includes("c"), "non-cyclic task should be included");
    // a and b are both in a cycle but should still be appended
    assert.ok(result.map(t => t.id).includes("a"), "cyclic task a should be appended");
    assert.ok(result.map(t => t.id).includes("b"), "cyclic task b should be appended");
  });
});

// ---------------------------------------------------------------------------
// prioritizeGoal — integration tests with real backend
// ---------------------------------------------------------------------------

describe("prioritizeGoal behavior", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sets contiguous userPriority on all tasks matching the goal ID", async () => {
    const t1 = await backend.createTask({ title: "Task 1", description: "D1" });
    await backend.updateTask(t1.id, { goal: "my-goal" });
    const t2 = await backend.createTask({ title: "Task 2", description: "D2" });
    await backend.updateTask(t2.id, { goal: "my-goal" });
    const t3 = await backend.createTask({ title: "Task 3", description: "D3" });
    await backend.updateTask(t3.id, { goal: "my-goal" });

    // Use topoSortTasks + manual update to simulate what prioritizeGoal does
    const allTasks = await backend.listTasks();
    const goalTasks = allTasks.filter(t => t.goal === "my-goal" && t.state !== "done");
    const sorted = topoSortTasks(goalTasks);
    for (let i = 0; i < sorted.length; i++) {
      await backend.updateTask(sorted[i]!.id, { userPriority: i + 1 });
    }

    // Verify contiguous assignment
    const updated1 = await backend.getTask(t1.id);
    const updated2 = await backend.getTask(t2.id);
    const updated3 = await backend.getTask(t3.id);
    assert.ok(updated1.userPriority !== null, "t1 should have userPriority");
    assert.ok(updated2.userPriority !== null, "t2 should have userPriority");
    assert.ok(updated3.userPriority !== null, "t3 should have userPriority");
    // All three should have distinct sequential values
    const priorities = [updated1.userPriority!, updated2.userPriority!, updated3.userPriority!];
    priorities.sort((a, b) => a - b);
    assert.deepEqual(priorities, [1, 2, 3], "priorities should be contiguous 1, 2, 3");
  });

  it("respects dependency order: B depends on A → A gets lower userPriority", async () => {
    const tA = await backend.createTask({ title: "Base task", description: "A" });
    await backend.updateTask(tA.id, { goal: "dep-goal" });

    const tB = await backend.createTask({
      title: "Dependent task",
      description: "B",
      dependencies: [tA.id],
    });
    await backend.updateTask(tB.id, { goal: "dep-goal" });

    // Simulate prioritizeGoal
    const allTasks = await backend.listTasks();
    const goalTasks = allTasks.filter(t => t.goal === "dep-goal" && t.state !== "done");
    const sorted = topoSortTasks(goalTasks);
    for (let i = 0; i < sorted.length; i++) {
      await backend.updateTask(sorted[i]!.id, { userPriority: i + 1 });
    }

    const updatedA = await backend.getTask(tA.id);
    const updatedB = await backend.getTask(tB.id);
    assert.ok(
      updatedA.userPriority! < updatedB.userPriority!,
      `A (userPriority=${updatedA.userPriority}) should have lower number than B (userPriority=${updatedB.userPriority})`,
    );
  });

  it("tasks not in the goal are unaffected", async () => {
    const inGoal = await backend.createTask({ title: "In goal", description: "G" });
    await backend.updateTask(inGoal.id, { goal: "target-goal" });

    const outside = await backend.createTask({ title: "Outside", description: "O" });
    // outside has goal: null (default)

    // Simulate prioritizeGoal (only affects "target-goal")
    const allTasks = await backend.listTasks();
    const goalTasks = allTasks.filter(t => t.goal === "target-goal" && t.state !== "done");
    const sorted = topoSortTasks(goalTasks);
    for (let i = 0; i < sorted.length; i++) {
      await backend.updateTask(sorted[i]!.id, { userPriority: i + 1 });
    }

    const updatedOutside = await backend.getTask(outside.id);
    assert.equal(updatedOutside.userPriority, null, "task outside the goal should remain unaffected");
  });

  it("works across multiple task states (ready, in_progress, proposed)", async () => {
    const t1 = await backend.createTask({ title: "Ready", description: "R" });
    await backend.updateTask(t1.id, { goal: "multi-state" });

    const t2 = await backend.createTask({ title: "In Progress", description: "IP" });
    await backend.updateTask(t2.id, { goal: "multi-state", state: "in_progress" });

    const t3 = await backend.createTask({ title: "Proposed", description: "P" });
    await backend.updateTask(t3.id, { goal: "multi-state", state: "proposed" });

    // Simulate prioritizeGoal (listTasks without state filter gets all)
    const allTasks = await backend.listTasks();
    const goalTasks = allTasks.filter(t => t.goal === "multi-state" && t.state !== "done");
    const sorted = topoSortTasks(goalTasks);
    for (let i = 0; i < sorted.length; i++) {
      await backend.updateTask(sorted[i]!.id, { userPriority: i + 1 });
    }

    const updated1 = await backend.getTask(t1.id);
    const updated2 = await backend.getTask(t2.id);
    const updated3 = await backend.getTask(t3.id);
    assert.ok(updated1.userPriority !== null, "ready task should have userPriority");
    assert.ok(updated2.userPriority !== null, "in_progress task should have userPriority");
    assert.ok(updated3.userPriority !== null, "proposed task should have userPriority");
  });

  it("excludes done tasks from prioritization", async () => {
    const active = await backend.createTask({ title: "Active", description: "A" });
    await backend.updateTask(active.id, { goal: "done-test" });

    const done = await backend.createTask({ title: "Done", description: "D" });
    await backend.updateTask(done.id, { goal: "done-test", state: "done" });

    const allTasks = await backend.listTasks();
    const goalTasks = allTasks.filter(t => t.goal === "done-test" && t.state !== "done");
    assert.equal(goalTasks.length, 1, "only active task should be included");

    const sorted = topoSortTasks(goalTasks);
    for (let i = 0; i < sorted.length; i++) {
      await backend.updateTask(sorted[i]!.id, { userPriority: i + 1 });
    }

    const updatedDone = await backend.getTask(done.id);
    assert.equal(updatedDone.userPriority, null, "done task should not get userPriority");
  });
});

// ---------------------------------------------------------------------------
// prioritizeGoals — integration tests with real backend
// ---------------------------------------------------------------------------

describe("prioritizeGoals behavior", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sets userPriority across goals in specified order (goal-a first, then goal-b)", async () => {
    const a1 = await backend.createTask({ title: "A1", description: "A" });
    await backend.updateTask(a1.id, { goal: "goal-a" });
    const a2 = await backend.createTask({ title: "A2", description: "A" });
    await backend.updateTask(a2.id, { goal: "goal-a" });

    const b1 = await backend.createTask({ title: "B1", description: "B" });
    await backend.updateTask(b1.id, { goal: "goal-b" });
    const b2 = await backend.createTask({ title: "B2", description: "B" });
    await backend.updateTask(b2.id, { goal: "goal-b" });

    // Simulate prioritizeGoals with order: goal-a, goal-b
    const allTasks = await backend.listTasks();
    const activeTasks = allTasks.filter(t => t.state !== "done");
    const ordered: Task[] = [];
    const assigned = new Set<string>();

    for (const goalId of ["goal-a", "goal-b"]) {
      const goalTasks = activeTasks.filter(t => t.goal === goalId && !assigned.has(t.id));
      const sorted = topoSortTasks(goalTasks);
      for (const task of sorted) {
        ordered.push(task);
        assigned.add(task.id);
      }
    }

    const ungrouped = activeTasks.filter(t => !assigned.has(t.id));
    ordered.push(...ungrouped);

    for (let i = 0; i < ordered.length; i++) {
      await backend.updateTask(ordered[i]!.id, { userPriority: i + 1 });
    }

    const updA1 = await backend.getTask(a1.id);
    const updA2 = await backend.getTask(a2.id);
    const updB1 = await backend.getTask(b1.id);
    const updB2 = await backend.getTask(b2.id);

    // All goal-a tasks should have lower userPriority numbers than goal-b tasks
    assert.ok(updA1.userPriority! < updB1.userPriority!, "goal-a tasks should come before goal-b");
    assert.ok(updA1.userPriority! < updB2.userPriority!, "goal-a tasks should come before goal-b");
    assert.ok(updA2.userPriority! < updB1.userPriority!, "goal-a tasks should come before goal-b");
    assert.ok(updA2.userPriority! < updB2.userPriority!, "goal-a tasks should come before goal-b");
  });

  it("ungrouped tasks (goal === null) placed at end", async () => {
    const grouped = await backend.createTask({ title: "Grouped", description: "G" });
    await backend.updateTask(grouped.id, { goal: "my-goal" });

    const ungrouped = await backend.createTask({ title: "Ungrouped", description: "U" });
    // ungrouped has goal: null

    // Simulate prioritizeGoals
    const allTasks = await backend.listTasks();
    const activeTasks = allTasks.filter(t => t.state !== "done");
    const ordered: Task[] = [];
    const assigned = new Set<string>();

    for (const goalId of ["my-goal"]) {
      const goalTasks = activeTasks.filter(t => t.goal === goalId && !assigned.has(t.id));
      const sorted = topoSortTasks(goalTasks);
      for (const task of sorted) {
        ordered.push(task);
        assigned.add(task.id);
      }
    }

    const remaining = activeTasks.filter(t => !assigned.has(t.id));
    ordered.push(...remaining);

    for (let i = 0; i < ordered.length; i++) {
      await backend.updateTask(ordered[i]!.id, { userPriority: i + 1 });
    }

    const updGrouped = await backend.getTask(grouped.id);
    const updUngrouped = await backend.getTask(ungrouped.id);

    assert.ok(
      updGrouped.userPriority! < updUngrouped.userPriority!,
      "grouped task should have lower userPriority than ungrouped",
    );
  });

  it("tasks with goals not in the list treated as ungrouped", async () => {
    const listed = await backend.createTask({ title: "Listed", description: "L" });
    await backend.updateTask(listed.id, { goal: "listed-goal" });

    const unlisted = await backend.createTask({ title: "Unlisted goal", description: "U" });
    await backend.updateTask(unlisted.id, { goal: "unlisted-goal" });

    // Only "listed-goal" in the goals list
    const allTasks = await backend.listTasks();
    const activeTasks = allTasks.filter(t => t.state !== "done");
    const ordered: Task[] = [];
    const assigned = new Set<string>();

    for (const goalId of ["listed-goal"]) {
      const goalTasks = activeTasks.filter(t => t.goal === goalId && !assigned.has(t.id));
      const sorted = topoSortTasks(goalTasks);
      for (const task of sorted) {
        ordered.push(task);
        assigned.add(task.id);
      }
    }

    const remaining = activeTasks.filter(t => !assigned.has(t.id));
    ordered.push(...remaining);

    for (let i = 0; i < ordered.length; i++) {
      await backend.updateTask(ordered[i]!.id, { userPriority: i + 1 });
    }

    const updListed = await backend.getTask(listed.id);
    const updUnlisted = await backend.getTask(unlisted.id);

    assert.ok(
      updListed.userPriority! < updUnlisted.userPriority!,
      "task with listed goal should come before task with unlisted goal",
    );
  });

  it("dependency order within each goal is respected", async () => {
    // Goal-a: base → dependent
    const base = await backend.createTask({ title: "Base", description: "B" });
    await backend.updateTask(base.id, { goal: "goal-a" });

    const dep = await backend.createTask({
      title: "Dependent",
      description: "D",
      dependencies: [base.id],
    });
    await backend.updateTask(dep.id, { goal: "goal-a" });

    // Simulate prioritizeGoals
    const allTasks = await backend.listTasks();
    const activeTasks = allTasks.filter(t => t.state !== "done");
    const ordered: Task[] = [];
    const assigned = new Set<string>();

    for (const goalId of ["goal-a"]) {
      const goalTasks = activeTasks.filter(t => t.goal === goalId && !assigned.has(t.id));
      const sorted = topoSortTasks(goalTasks);
      for (const task of sorted) {
        ordered.push(task);
        assigned.add(task.id);
      }
    }

    const remaining = activeTasks.filter(t => !assigned.has(t.id));
    ordered.push(...remaining);

    for (let i = 0; i < ordered.length; i++) {
      await backend.updateTask(ordered[i]!.id, { userPriority: i + 1 });
    }

    const updBase = await backend.getTask(base.id);
    const updDep = await backend.getTask(dep.id);

    assert.ok(
      updBase.userPriority! < updDep.userPriority!,
      "base task should have lower userPriority than dependent task",
    );
  });

  it("single goal behaves same as prioritizeGoal", async () => {
    const t1 = await backend.createTask({ title: "T1", description: "D" });
    await backend.updateTask(t1.id, { goal: "solo-goal" });
    const t2 = await backend.createTask({ title: "T2", description: "D", dependencies: [t1.id] });
    await backend.updateTask(t2.id, { goal: "solo-goal" });

    // Simulate prioritizeGoals with single goal
    const allTasks = await backend.listTasks();
    const activeTasks = allTasks.filter(t => t.state !== "done");
    const ordered: Task[] = [];
    const assigned = new Set<string>();

    for (const goalId of ["solo-goal"]) {
      const goalTasks = activeTasks.filter(t => t.goal === goalId && !assigned.has(t.id));
      const sorted = topoSortTasks(goalTasks);
      for (const task of sorted) {
        ordered.push(task);
        assigned.add(task.id);
      }
    }

    for (let i = 0; i < ordered.length; i++) {
      await backend.updateTask(ordered[i]!.id, { userPriority: i + 1 });
    }

    const upd1 = await backend.getTask(t1.id);
    const upd2 = await backend.getTask(t2.id);

    assert.equal(upd1.userPriority, 1, "t1 (no deps) should be priority 1");
    assert.equal(upd2.userPriority, 2, "t2 (depends on t1) should be priority 2");
  });
});
