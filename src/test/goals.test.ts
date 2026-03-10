import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGoals, saveGoals, GoalSchema, slugifyGoalId } from "../goals.js";
import { TaskSchema } from "../tasks/types.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-goals-test-"));
}

// ── GoalSchema ────────────────────────────────────────────────────

describe("GoalSchema", () => {
  it("validates a complete goal object", () => {
    const result = GoalSchema.parse({ id: "g1", title: "My Goal", description: "A description" });
    assert.equal(result.id, "g1");
    assert.equal(result.title, "My Goal");
    assert.equal(result.description, "A description");
  });

  it("defaults description to empty string when omitted", () => {
    const result = GoalSchema.parse({ id: "g1", title: "My Goal" });
    assert.equal(result.description, "");
  });

  it("rejects missing id", () => {
    assert.throws(() => GoalSchema.parse({ title: "No ID" }));
  });

  it("rejects missing title", () => {
    assert.throws(() => GoalSchema.parse({ id: "g1" }));
  });
});

// ── slugifyGoalId ─────────────────────────────────────────────────

describe("slugifyGoalId", () => {
  it("converts title case to slug", () => {
    assert.equal(slugifyGoalId("Git Integration"), "git-integration");
  });

  it("converts multi-word titles", () => {
    assert.equal(slugifyGoalId("CLI Commands"), "cli-commands");
  });

  it("collapses multiple spaces and dashes", () => {
    assert.equal(slugifyGoalId("  Spaces  and--dashes  "), "spaces-and-dashes");
  });

  it("returns 'ungrouped' for empty string", () => {
    assert.equal(slugifyGoalId(""), "ungrouped");
  });

  it("returns 'ungrouped' for whitespace-only input", () => {
    assert.equal(slugifyGoalId("   "), "ungrouped");
  });

  it("handles special characters", () => {
    assert.equal(slugifyGoalId("Test & Debug (v2)"), "test-debug-v2");
  });

  it("handles single word", () => {
    assert.equal(slugifyGoalId("Logging"), "logging");
  });

  it("strips leading/trailing hyphens from punctuation", () => {
    assert.equal(slugifyGoalId("--hello--world--"), "hello-world");
  });
});

// ── TaskSchema backward compat ────────────────────────────────────

describe("TaskSchema goal backward compat", () => {
  it("defaults goal to null when field is absent", () => {
    const input = {
      id: "t1",
      title: "Test",
      description: "A test task",
      priority: "medium",
      type: "feature",
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
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    // No 'goal' field in input
    const parsed = TaskSchema.parse(input);
    assert.equal(parsed.goal, null);
  });

  it("preserves explicit goal string", () => {
    const input = {
      id: "t1",
      title: "Test",
      description: "A test task",
      priority: "medium",
      type: "feature",
      state: "ready",
      dependencies: [],
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      goal: "my-goal",
      blockers: [],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const parsed = TaskSchema.parse(input);
    assert.equal(parsed.goal, "my-goal");
  });

  it("preserves explicit goal null", () => {
    const input = {
      id: "t1",
      title: "Test",
      description: "A test task",
      priority: "medium",
      type: "feature",
      state: "ready",
      dependencies: [],
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      goal: null,
      blockers: [],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const parsed = TaskSchema.parse(input);
    assert.equal(parsed.goal, null);
  });
});

// ── loadGoals ─────────────────────────────────────────────────────

describe("loadGoals", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when file does not exist", async () => {
    const result = await loadGoals(tempDir);
    assert.deepEqual(result, []);
  });

  it("returns empty array for invalid JSON", async () => {
    await writeFile(join(tempDir, "goals.json"), "not valid json!!!", "utf-8");
    const result = await loadGoals(tempDir);
    assert.deepEqual(result, []);
  });

  it("returns empty array for non-array JSON", async () => {
    await writeFile(join(tempDir, "goals.json"), '{"id": "g1"}', "utf-8");
    const result = await loadGoals(tempDir);
    assert.deepEqual(result, []);
  });

  it("parses valid goals array", async () => {
    const goals = [
      { id: "g1", title: "Goal 1", description: "First goal" },
      { id: "g2", title: "Goal 2", description: "" },
    ];
    await writeFile(join(tempDir, "goals.json"), JSON.stringify(goals), "utf-8");

    const result = await loadGoals(tempDir);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.id, "g1");
    assert.equal(result[0]?.title, "Goal 1");
    assert.equal(result[1]?.id, "g2");
  });

  it("returns empty array for empty JSON array", async () => {
    await writeFile(join(tempDir, "goals.json"), "[]", "utf-8");
    const result = await loadGoals(tempDir);
    assert.deepEqual(result, []);
  });
});

// ── saveGoals ─────────────────────────────────────────────────────

describe("saveGoals", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes goals and reads them back (round-trip)", async () => {
    const goals = [
      { id: "g1", title: "Goal One", description: "First" },
      { id: "g2", title: "Goal Two", description: "Second" },
    ];
    await saveGoals(tempDir, goals);
    const loaded = await loadGoals(tempDir);

    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.id, "g1");
    assert.equal(loaded[0]?.title, "Goal One");
    assert.equal(loaded[0]?.description, "First");
    assert.equal(loaded[1]?.id, "g2");
    assert.equal(loaded[1]?.title, "Goal Two");
  });

  it("creates directory if missing", async () => {
    const subDir = join(tempDir, "nested", "deep");
    await saveGoals(subDir, [{ id: "g1", title: "Test", description: "" }]);

    const raw = await readFile(join(subDir, "goals.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal((parsed as Array<{ id: string }>)[0]?.id, "g1");
  });

  it("overwrites existing goals file", async () => {
    await saveGoals(tempDir, [{ id: "g1", title: "Original", description: "" }]);
    await saveGoals(tempDir, [{ id: "g2", title: "Replaced", description: "" }]);

    const loaded = await loadGoals(tempDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, "g2");
    assert.equal(loaded[0]?.title, "Replaced");
  });

  it("writes pretty-printed JSON with trailing newline", async () => {
    await saveGoals(tempDir, [{ id: "g1", title: "Test", description: "" }]);
    const raw = await readFile(join(tempDir, "goals.json"), "utf-8");
    assert.ok(raw.endsWith("\n"), "File should end with newline");
    assert.ok(raw.includes("\n  "), "JSON should be pretty-printed");
  });

  it("handles empty array", async () => {
    await saveGoals(tempDir, []);
    const loaded = await loadGoals(tempDir);
    assert.deepEqual(loaded, []);
  });
});
