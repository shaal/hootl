import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGoalFromFlag, loadGoals, saveGoals, slugifyGoalId } from "../goals.js";

/** Minimal mock backend that records updateTask calls */
function mockBackend(): {
  updateTask: (id: string, updates: { goal: string }) => Promise<void>;
  updates: Array<{ id: string; goal: string }>;
} {
  const updates: Array<{ id: string; goal: string }> = [];
  return {
    updates,
    async updateTask(id: string, upd: { goal: string }): Promise<void> {
      updates.push({ id, goal: upd.goal });
    },
  };
}

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-goal-auto-test-"));
}

describe("ensureGoalFromFlag", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a new goal and assigns all tasks", async () => {
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
      [2, "task-003"],
    ]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("User Authentication", indexToId, backend, tempDir);

    assert.equal(result.goalId, "user-authentication");
    assert.equal(result.created, true);
    assert.equal(result.assigned, 3);

    // All tasks assigned to the goal
    assert.equal(backend.updates.length, 3);
    for (const update of backend.updates) {
      assert.equal(update.goal, "user-authentication");
    }

    // Goal persisted
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 1);
    assert.equal(goals[0]?.id, "user-authentication");
    assert.equal(goals[0]?.title, "User Authentication");
    assert.equal(goals[0]?.description, "");
  });

  it("reuses existing goal when matching slug already exists", async () => {
    // Pre-populate with a goal that matches the slug
    await saveGoals(tempDir, [
      { id: "user-authentication", title: "Auth System (existing)", description: "Already here" },
    ]);

    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
    ]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("User Authentication", indexToId, backend, tempDir);

    assert.equal(result.goalId, "user-authentication");
    assert.equal(result.created, false);
    assert.equal(result.assigned, 2);

    // Existing goal preserved (title/description not overwritten)
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 1);
    assert.equal(goals[0]?.title, "Auth System (existing)");
    assert.equal(goals[0]?.description, "Already here");

    // Tasks still assigned
    assert.equal(backend.updates.length, 2);
    for (const update of backend.updates) {
      assert.equal(update.goal, "user-authentication");
    }
  });

  it("creates new goal alongside existing different goals", async () => {
    await saveGoals(tempDir, [
      { id: "existing-goal", title: "Existing Goal", description: "Keep me" },
    ]);

    const indexToId = new Map<number, string>([[0, "task-001"]]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("New Feature", indexToId, backend, tempDir);

    assert.equal(result.goalId, "new-feature");
    assert.equal(result.created, true);

    // Both goals present
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 2);
    assert.equal(goals[0]?.id, "existing-goal");
    assert.equal(goals[0]?.title, "Existing Goal");
    assert.equal(goals[1]?.id, "new-feature");
    assert.equal(goals[1]?.title, "New Feature");
  });

  it("handles goal text with special characters", async () => {
    const indexToId = new Map<number, string>([[0, "task-001"]]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("Test & Debug (v2)!", indexToId, backend, tempDir);

    assert.equal(result.goalId, "test-debug-v2");
    assert.equal(result.created, true);

    const goals = await loadGoals(tempDir);
    assert.equal(goals[0]?.id, "test-debug-v2");
    assert.equal(goals[0]?.title, "Test & Debug (v2)!");
  });

  it("trims leading and trailing whitespace from goal text", async () => {
    const indexToId = new Map<number, string>([[0, "task-001"]]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("  Spaced Goal  ", indexToId, backend, tempDir);

    assert.equal(result.goalId, "spaced-goal");
    assert.equal(result.created, true);

    const goals = await loadGoals(tempDir);
    assert.equal(goals[0]?.title, "Spaced Goal");
  });

  it("assigns zero tasks when indexToId is empty", async () => {
    const indexToId = new Map<number, string>();
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("Empty Plan", indexToId, backend, tempDir);

    assert.equal(result.goalId, "empty-plan");
    assert.equal(result.created, true);
    assert.equal(result.assigned, 0);
    assert.equal(backend.updates.length, 0);

    // Goal still created even with no tasks
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 1);
  });

  it("assigns all tasks from indexToId regardless of index values", async () => {
    // Non-contiguous indices — all values should still be assigned
    const indexToId = new Map<number, string>([
      [0, "task-a"],
      [5, "task-b"],
      [10, "task-c"],
    ]);
    const backend = mockBackend();

    const result = await ensureGoalFromFlag("My Goal", indexToId, backend, tempDir);

    assert.equal(result.assigned, 3);
    assert.equal(backend.updates.length, 3);

    const assignedIds = new Set(backend.updates.map((u) => u.id));
    assert.ok(assignedIds.has("task-a"));
    assert.ok(assignedIds.has("task-b"));
    assert.ok(assignedIds.has("task-c"));
  });
});

describe("slugifyGoalId edge cases for --goal flag", () => {
  it("lowercases and hyphenates multi-word text", () => {
    assert.equal(slugifyGoalId("User Authentication"), "user-authentication");
  });

  it("collapses multiple special characters into single hyphen", () => {
    assert.equal(slugifyGoalId("foo---bar___baz"), "foo-bar-baz");
  });

  it("strips leading and trailing hyphens after slugification", () => {
    assert.equal(slugifyGoalId("--leading--"), "leading");
    assert.equal(slugifyGoalId("trailing--"), "trailing");
  });

  it("returns 'ungrouped' for empty string", () => {
    assert.equal(slugifyGoalId(""), "ungrouped");
  });

  it("returns 'ungrouped' for whitespace-only string", () => {
    assert.equal(slugifyGoalId("   "), "ungrouped");
  });

  it("handles unicode and special characters", () => {
    assert.equal(slugifyGoalId("café résumé"), "caf-r-sum");
  });

  it("handles single word", () => {
    assert.equal(slugifyGoalId("testing"), "testing");
  });

  it("handles numbers in goal text", () => {
    assert.equal(slugifyGoalId("Phase 2 Planning"), "phase-2-planning");
  });
});
