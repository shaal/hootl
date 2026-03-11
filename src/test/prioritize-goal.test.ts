import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskBackend } from "../tasks/local.js";
import type { Task } from "../tasks/types.js";
import { topoSortTasks } from "../selection.js";
import { prioritizeGoal, prioritizeGoals } from "../prioritize.js";
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
// prioritizeGoal — calls the actual exported function with real backend
// ---------------------------------------------------------------------------

describe("prioritizeGoal", () => {
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

    const result = await prioritizeGoal(backend, "my-goal");

    assert.equal(result.updated, 3);
    assert.equal(result.assignments.length, 3);

    // Verify contiguous assignment persisted to backend
    const updated1 = await backend.getTask(t1.id);
    const updated2 = await backend.getTask(t2.id);
    const updated3 = await backend.getTask(t3.id);
    assert.ok(updated1.userPriority !== null, "t1 should have userPriority");
    assert.ok(updated2.userPriority !== null, "t2 should have userPriority");
    assert.ok(updated3.userPriority !== null, "t3 should have userPriority");
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

    const result = await prioritizeGoal(backend, "dep-goal");
    assert.equal(result.updated, 2);

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

    await prioritizeGoal(backend, "target-goal");

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

    const result = await prioritizeGoal(backend, "multi-state");
    assert.equal(result.updated, 3);

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

    const result = await prioritizeGoal(backend, "done-test");
    assert.equal(result.updated, 1, "only active task should be updated");

    const updatedDone = await backend.getTask(done.id);
    assert.equal(updatedDone.userPriority, null, "done task should not get userPriority");
  });

  it("throws for non-existent goal ID", async () => {
    // Create a task with a different goal to ensure the backend isn't empty
    const t = await backend.createTask({ title: "Other", description: "O" });
    await backend.updateTask(t.id, { goal: "other-goal" });

    await assert.rejects(
      () => prioritizeGoal(backend, "nonexistent-goal"),
      (err: Error) => {
        assert.ok(err.message.includes("nonexistent-goal"), "error should mention the goal ID");
        assert.ok(err.message.includes("No active tasks"), "error should describe the problem");
        return true;
      },
    );

    // Verify no tasks were modified
    const updated = await backend.getTask(t.id);
    assert.equal(updated.userPriority, null, "other-goal task should remain unaffected");
  });

  it("returns assignments list matching the topological order", async () => {
    const tA = await backend.createTask({ title: "A", description: "A" });
    await backend.updateTask(tA.id, { goal: "order-goal" });
    const tB = await backend.createTask({ title: "B", description: "B", dependencies: [tA.id] });
    await backend.updateTask(tB.id, { goal: "order-goal" });

    const result = await prioritizeGoal(backend, "order-goal");

    // assignments should be in dependency order: A first, B second
    assert.equal(result.assignments[0]![0], tA.id, "first assignment should be the root task");
    assert.equal(result.assignments[0]![1], 1, "first assignment priority should be 1");
    assert.equal(result.assignments[1]![0], tB.id, "second assignment should be the dependent");
    assert.equal(result.assignments[1]![1], 2, "second assignment priority should be 2");
  });
});

// ---------------------------------------------------------------------------
// prioritizeGoals — calls the actual exported function with real backend
// ---------------------------------------------------------------------------

describe("prioritizeGoals", () => {
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

    const result = await prioritizeGoals(backend, ["goal-a", "goal-b"]);
    assert.equal(result.updated, 4);

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

    const result = await prioritizeGoals(backend, ["my-goal"]);
    assert.equal(result.updated, 2, "both tasks should receive priorities");

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

    const result = await prioritizeGoals(backend, ["listed-goal"]);
    assert.equal(result.updated, 2);

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

    const result = await prioritizeGoals(backend, ["goal-a"]);
    assert.equal(result.updated, 2);

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

    const result = await prioritizeGoals(backend, ["solo-goal"]);

    const upd1 = await backend.getTask(t1.id);
    const upd2 = await backend.getTask(t2.id);

    assert.equal(upd1.userPriority, 1, "t1 (no deps) should be priority 1");
    assert.equal(upd2.userPriority, 2, "t2 (depends on t1) should be priority 2");

    // Verify result object
    assert.equal(result.updated, 2);
    assert.equal(result.assignments[0]![0], t1.id);
    assert.equal(result.assignments[1]![0], t2.id);
  });

  it("handles empty goalIds array gracefully", async () => {
    const t1 = await backend.createTask({ title: "Task", description: "D" });
    await backend.updateTask(t1.id, { goal: "some-goal" });

    const result = await prioritizeGoals(backend, []);

    // All tasks are ungrouped and should still get priorities
    assert.equal(result.updated, 1);
    const updated = await backend.getTask(t1.id);
    assert.equal(updated.userPriority, 1, "ungrouped task should get priority 1");
  });

  it("handles mixed goals where one has tasks and another doesn't", async () => {
    // goal-a has tasks, goal-b has none
    const a1 = await backend.createTask({ title: "A1", description: "A" });
    await backend.updateTask(a1.id, { goal: "goal-a" });
    const a2 = await backend.createTask({ title: "A2", description: "A" });
    await backend.updateTask(a2.id, { goal: "goal-a" });

    // No tasks for goal-b
    const ungrouped = await backend.createTask({ title: "Ungrouped", description: "U" });

    const result = await prioritizeGoals(backend, ["goal-a", "goal-b"]);

    // goal-a tasks come first (2 tasks), then ungrouped (1 task)
    // goal-b is simply empty — no error, no crash
    assert.equal(result.updated, 3, "all active tasks should get priorities");

    const updA1 = await backend.getTask(a1.id);
    const updA2 = await backend.getTask(a2.id);
    const updUngrouped = await backend.getTask(ungrouped.id);

    // goal-a tasks before ungrouped
    assert.ok(updA1.userPriority! < updUngrouped.userPriority!, "goal-a before ungrouped");
    assert.ok(updA2.userPriority! < updUngrouped.userPriority!, "goal-a before ungrouped");
  });
});

// ---------------------------------------------------------------------------
// CLI mutual exclusivity — verifies the modes array filtering logic
// ---------------------------------------------------------------------------

describe("prioritize CLI mutual exclusivity", () => {
  it("detects --goal combined with --clear as conflicting modes", () => {
    // Replicate the exact logic from the CLI action handler in index.ts
    const options = { clear: true, goal: "my-goal", goals: undefined };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.ok(modes.length > 1, "should detect multiple modes");
    assert.ok(modes.includes("--clear"), "should include --clear");
    assert.ok(modes.includes("--goal"), "should include --goal");
  });

  it("detects --goal combined with positional taskIds as conflicting modes", () => {
    const options = { clear: undefined, goal: "my-goal", goals: undefined };
    const taskIds = ["task-001", "task-002"];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.ok(modes.length > 1, "should detect multiple modes");
    assert.ok(modes.includes("--goal"), "should include --goal");
    assert.ok(modes.includes("taskIds"), "should include taskIds");
  });

  it("detects --goals combined with --goal as conflicting modes", () => {
    const options = { clear: undefined, goal: "my-goal", goals: ["g1", "g2"] };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.ok(modes.length > 1, "should detect multiple modes");
    assert.ok(modes.includes("--goal"), "should include --goal");
    assert.ok(modes.includes("--goals"), "should include --goals");
  });

  it("detects --goals combined with --clear as conflicting modes", () => {
    const options = { clear: true, goal: undefined, goals: ["g1"] };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.ok(modes.length > 1, "should detect multiple modes");
    assert.ok(modes.includes("--clear"), "should include --clear");
    assert.ok(modes.includes("--goals"), "should include --goals");
  });

  it("allows single mode --goal without conflict", () => {
    const options = { clear: undefined, goal: "my-goal", goals: undefined };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.equal(modes.length, 1, "single mode should not be flagged as conflict");
    assert.equal(modes[0], "--goal");
  });

  it("allows single mode --goals without conflict", () => {
    const options = { clear: undefined, goal: undefined, goals: ["g1", "g2"] };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.equal(modes.length, 1, "single mode should not be flagged as conflict");
    assert.equal(modes[0], "--goals");
  });

  it("allows no mode (interactive fallback)", () => {
    const options = { clear: undefined, goal: undefined, goals: undefined };
    const taskIds: string[] = [];

    const modes = [
      options.clear ? "--clear" : null,
      options.goal ? "--goal" : null,
      options.goals ? "--goals" : null,
      taskIds.length > 0 ? "taskIds" : null,
    ].filter(Boolean);

    assert.equal(modes.length, 0, "no mode selected should be valid for interactive fallback");
  });
});
