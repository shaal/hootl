import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferDependencies, extractKeywords, resolveIndicesToIds } from "../dependencies.js";

describe("inferDependencies", () => {
  it("returns Claude-provided dependsOn indices unchanged", () => {
    const tasks = [
      { title: "Add schema", description: "Create the schema", dependsOn: [] },
      { title: "Add engine", description: "Build engine", dependsOn: [0] },
      { title: "Integration", description: "Wire it up", dependsOn: [0, 1] },
    ];

    const result = inferDependencies(tasks);
    assert.deepEqual(result.get(1), [0]);
    assert.deepEqual(result.get(2), [0, 1]);
    assert.equal(result.has(0), false);
  });

  it("filters out-of-range indices silently", () => {
    const tasks = [
      { title: "Schema", description: "Create schema", dependsOn: [] },
      { title: "Engine", description: "Build engine", dependsOn: [0, 5, -1] },
    ];

    const result = inferDependencies(tasks);
    assert.deepEqual(result.get(1), [0]);
  });

  it("filters self-references", () => {
    const tasks = [
      { title: "Schema", description: "Create schema", dependsOn: [0] },
    ];

    const result = inferDependencies(tasks);
    assert.equal(result.has(0), false);
  });

  it("deduplicates indices", () => {
    const tasks = [
      { title: "Schema", description: "Create schema" },
      { title: "Engine", description: "Build engine", dependsOn: [0, 0, 0] },
    ];

    const result = inferDependencies(tasks);
    assert.deepEqual(result.get(1), [0]);
  });

  it("falls back to heuristic when dependsOn is not provided", () => {
    const tasks = [
      { title: "Add database schema", description: "Define the DB tables" },
      { title: "Build query engine", description: "Requires the database schema to be defined first" },
    ];

    const result = inferDependencies(tasks);
    // Task 1 mentions "database" and "schema" from task 0's title
    assert.ok(result.has(1), "task 1 should depend on task 0 via heuristic");
    const deps = result.get(1)!;
    assert.ok(deps.includes(0));
  });

  it("returns empty map when no dependency signals detected", () => {
    const tasks = [
      { title: "Add login page", description: "Create a login form" },
      { title: "Add dashboard", description: "Create a dashboard view" },
    ];

    const result = inferDependencies(tasks);
    assert.equal(result.size, 0);
  });

  it("detects and removes circular dependencies", () => {
    const tasks = [
      { title: "Task A", description: "First", dependsOn: [1] },
      { title: "Task B", description: "Second", dependsOn: [0] },
    ];

    const result = inferDependencies(tasks);
    // At least one back edge should be removed to break the cycle
    // Both can't depend on each other
    const aOnB = result.get(0)?.includes(1) ?? false;
    const bOnA = result.get(1)?.includes(0) ?? false;
    assert.ok(!(aOnB && bOnA), "circular dependency should be broken");
  });

  it("handles three-node cycle", () => {
    const tasks = [
      { title: "A", description: "a", dependsOn: [2] },
      { title: "B", description: "b", dependsOn: [0] },
      { title: "C", description: "c", dependsOn: [1] },
    ];

    const result = inferDependencies(tasks);
    // Check that the graph is now acyclic by verifying no full cycle exists
    const aOnC = result.get(0)?.includes(2) ?? false;
    const bOnA = result.get(1)?.includes(0) ?? false;
    const cOnB = result.get(2)?.includes(1) ?? false;
    assert.ok(!(aOnC && bOnA && cOnB), "three-node cycle should be broken");
  });

  it("handles empty task list", () => {
    const result = inferDependencies([]);
    assert.equal(result.size, 0);
  });

  it("handles single task with no dependencies", () => {
    const tasks = [{ title: "Solo task", description: "Just one thing" }];
    const result = inferDependencies(tasks);
    assert.equal(result.size, 0);
  });

  it("prefers explicit dependsOn over heuristic", () => {
    const tasks = [
      { title: "Add schema validation", description: "Zod schemas" },
      { title: "Add API routes", description: "Needs schema validation", dependsOn: [] as number[] },
    ];

    // Task 1 has explicit empty dependsOn — should NOT fall back to heuristic
    // even though description mentions "schema validation"
    const result = inferDependencies(tasks);
    assert.equal(result.has(1), false, "explicit empty dependsOn should not trigger heuristic");
  });
});

describe("extractKeywords", () => {
  it("extracts significant words from title", () => {
    const keywords = extractKeywords("Add database schema validation");
    assert.ok(keywords.includes("database"));
    assert.ok(keywords.includes("schema"));
    assert.ok(keywords.includes("validation"));
    assert.ok(!keywords.includes("add"), "stop word 'add' should be filtered");
  });

  it("filters short words", () => {
    const keywords = extractKeywords("Fix UI on PC");
    assert.ok(!keywords.includes("ui"));
    assert.ok(!keywords.includes("on"));
    assert.ok(!keywords.includes("pc"));
  });

  it("handles hyphenated and underscored words", () => {
    const keywords = extractKeywords("auto-detect task_dependencies");
    assert.ok(keywords.includes("auto"));
    assert.ok(keywords.includes("detect"));
    assert.ok(keywords.includes("dependencies"));
  });
});

describe("resolveIndicesToIds", () => {
  it("maps indices to task IDs", () => {
    const depMap = new Map<number, number[]>();
    depMap.set(1, [0]);
    depMap.set(2, [0, 1]);

    const indexToId = new Map<number, string>();
    indexToId.set(0, "task-001");
    indexToId.set(1, "task-002");
    indexToId.set(2, "task-003");

    const result = resolveIndicesToIds(depMap, indexToId);
    assert.deepEqual(result.get(1), ["task-001"]);
    assert.deepEqual(result.get(2), ["task-001", "task-002"]);
  });

  it("skips indices with no matching ID", () => {
    const depMap = new Map<number, number[]>();
    depMap.set(1, [0, 5]); // index 5 doesn't exist

    const indexToId = new Map<number, string>();
    indexToId.set(0, "task-001");
    indexToId.set(1, "task-002");

    const result = resolveIndicesToIds(depMap, indexToId);
    assert.deepEqual(result.get(1), ["task-001"]);
  });

  it("returns empty map when no dependencies", () => {
    const result = resolveIndicesToIds(new Map(), new Map());
    assert.equal(result.size, 0);
  });

  it("omits entry if all dep indices are missing from indexToId", () => {
    const depMap = new Map<number, number[]>();
    depMap.set(0, [5, 6]); // neither exists

    const indexToId = new Map<number, string>();
    indexToId.set(0, "task-001");

    const result = resolveIndicesToIds(depMap, indexToId);
    assert.equal(result.has(0), false);
  });
});
