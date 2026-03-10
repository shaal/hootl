import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalsFromGroups, loadGoals, saveGoals } from "../goals.js";
import { JSON_SCHEMA_INSTRUCTION } from "../plan-prompt.js";

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
  return mkdtemp(join(tmpdir(), "hootl-clustering-test-"));
}

describe("createGoalsFromGroups", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates goals for unique group labels and assigns tasks", async () => {
    const tasks = [
      { title: "Add git hooks", group: "Git Integration" },
      { title: "Add logging", group: "Observability" },
      { title: "Fix branch naming", group: "Git Integration" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
      [2, "task-003"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    // 2 unique groups → 2 goals created
    assert.equal(result.created.length, 2);
    assert.ok(result.created.includes("git-integration"));
    assert.ok(result.created.includes("observability"));

    // All 3 tasks assigned
    assert.equal(result.assigned, 3);

    // Verify backend calls
    assert.equal(backend.updates.length, 3);
    assert.deepEqual(backend.updates[0], { id: "task-001", goal: "git-integration" });
    assert.deepEqual(backend.updates[1], { id: "task-002", goal: "observability" });
    assert.deepEqual(backend.updates[2], { id: "task-003", goal: "git-integration" });

    // Goals persisted
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 2);
    assert.equal(goals[0]?.id, "git-integration");
    assert.equal(goals[0]?.title, "Git Integration");
    assert.equal(goals[1]?.id, "observability");
    assert.equal(goals[1]?.title, "Observability");
  });

  it("does nothing when no tasks have a group field", async () => {
    const tasks = [
      { title: "Task A" },
      { title: "Task B" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    assert.equal(result.created.length, 0);
    assert.equal(result.assigned, 0);
    assert.equal(backend.updates.length, 0);

    // No goals file created
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 0);
  });

  it("handles mixed tasks (some with group, some without)", async () => {
    const tasks = [
      { title: "Grouped task", group: "CLI Commands" },
      { title: "Ungrouped task" },
      { title: "Another grouped", group: "CLI Commands" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
      [2, "task-003"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    assert.equal(result.created.length, 1);
    assert.ok(result.created.includes("cli-commands"));

    // Only 2 tasks assigned (the ones with groups)
    assert.equal(result.assigned, 2);
    assert.equal(backend.updates.length, 2);
    assert.deepEqual(backend.updates[0], { id: "task-001", goal: "cli-commands" });
    assert.deepEqual(backend.updates[1], { id: "task-003", goal: "cli-commands" });
  });

  it("deduplicates group names into a single goal", async () => {
    const tasks = [
      { title: "Task 1", group: "Budget System" },
      { title: "Task 2", group: "Budget System" },
      { title: "Task 3", group: "Budget System" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
      [2, "task-003"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    // Only 1 goal created despite 3 tasks
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0], "budget-system");

    // All 3 tasks assigned to the same goal
    assert.equal(result.assigned, 3);
    for (const update of backend.updates) {
      assert.equal(update.goal, "budget-system");
    }
  });

  it("skips creation for pre-existing goals with matching ID", async () => {
    // Pre-populate goals.json with one existing goal
    await saveGoals(tempDir, [
      { id: "git-integration", title: "Git Integration (existing)", description: "Already exists" },
    ]);

    const tasks = [
      { title: "New git task", group: "Git Integration" },
      { title: "New logging task", group: "Observability" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    // Only "observability" is new; "git-integration" already existed
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0], "observability");

    // Both tasks still assigned
    assert.equal(result.assigned, 2);

    // Existing goal preserved with original title/description
    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 2);
    assert.equal(goals[0]?.id, "git-integration");
    assert.equal(goals[0]?.title, "Git Integration (existing)");
    assert.equal(goals[0]?.description, "Already exists");
    assert.equal(goals[1]?.id, "observability");
  });

  it("applies slugification to goal IDs correctly", async () => {
    const tasks = [
      { title: "Task", group: "  Test & Debug (v2)  " },
    ];
    const indexToId = new Map<number, string>([[0, "task-001"]]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0], "test-debug-v2");
    assert.deepEqual(backend.updates[0], { id: "task-001", goal: "test-debug-v2" });
  });

  it("ignores tasks with empty or whitespace-only group strings", async () => {
    const tasks = [
      { title: "Empty group", group: "" },
      { title: "Whitespace group", group: "   " },
      { title: "Valid group", group: "Logging" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
      [2, "task-003"],
    ]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    // Only the valid group should be created
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0], "logging");

    // Only 1 task assigned
    assert.equal(result.assigned, 1);
    assert.equal(backend.updates.length, 1);
    assert.deepEqual(backend.updates[0], { id: "task-003", goal: "logging" });
  });

  it("handles tasks whose index has no corresponding ID in indexToId", async () => {
    const tasks = [
      { title: "Task with ID", group: "Testing" },
      { title: "Task without ID", group: "Testing" },
    ];
    // Only index 0 has a mapping; index 1 is missing
    const indexToId = new Map<number, string>([[0, "task-001"]]);
    const backend = mockBackend();

    const result = await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    // Goal created
    assert.equal(result.created.length, 1);

    // Only 1 task assigned (the one with a valid ID mapping)
    assert.equal(result.assigned, 1);
    assert.equal(backend.updates.length, 1);
    assert.deepEqual(backend.updates[0], { id: "task-001", goal: "testing" });
  });

  it("uses first occurrence title when multiple tasks have same slug", async () => {
    // Both slugify to the same ID but have slightly different titles
    const tasks = [
      { title: "Task 1", group: "Git Integration" },
      { title: "Task 2", group: "git integration" },
    ];
    const indexToId = new Map<number, string>([
      [0, "task-001"],
      [1, "task-002"],
    ]);
    const backend = mockBackend();

    await createGoalsFromGroups(tasks, indexToId, backend, tempDir);

    const goals = await loadGoals(tempDir);
    assert.equal(goals.length, 1);
    // First occurrence title used
    assert.equal(goals[0]?.title, "Git Integration");
  });
});

describe("JSON_SCHEMA_INSTRUCTION prompt construction", () => {
  it("includes the group field in the list of task JSON fields", () => {
    assert.ok(
      JSON_SCHEMA_INSTRUCTION.includes('"group"'),
      "JSON schema instruction must mention the \"group\" field",
    );
  });

  it("describes group as a short functional-area label", () => {
    assert.ok(
      JSON_SCHEMA_INSTRUCTION.includes("functional area"),
      "JSON schema instruction must describe group as a functional area label",
    );
  });

  it("mentions that same-group tasks are clustered into a goal", () => {
    assert.ok(
      JSON_SCHEMA_INSTRUCTION.includes("clustered into a goal"),
      "JSON schema instruction must explain goal clustering behavior",
    );
  });

  it("includes all required task JSON fields", () => {
    for (const field of ["title", "description", "priority", "group"]) {
      assert.ok(
        JSON_SCHEMA_INSTRUCTION.includes(`"${field}"`),
        `JSON schema instruction must include the "${field}" field`,
      );
    }
  });

  it("documents the dependsOn field as optional", () => {
    assert.ok(
      JSON_SCHEMA_INSTRUCTION.includes("dependsOn"),
      "JSON schema instruction must mention the dependsOn field",
    );
    assert.ok(
      JSON_SCHEMA_INSTRUCTION.includes("optionally"),
      "JSON schema instruction must indicate dependsOn is optional",
    );
  });
});
