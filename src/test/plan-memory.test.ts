import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateMemoryEntry,
  appendMemoryEntry,
  loadRecentPatterns,
  computeMetricsFromEntries,
  computeMetrics,
  formatPlanningMemoryContext,
} from "../plan-memory.js";
import type { Task } from "../tasks/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t001",
    title: "Test task",
    description: "A test task",
    priority: "medium",
    type: "feature",
    state: "done",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 95,
    attempts: 1,
    totalCost: 0.10,
    branch: null,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("generateMemoryEntry", () => {
  it("generates success insight for 1-attempt completion", () => {
    const task = makeTask({ state: "done", attempts: 1 });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("t001"));
    assert.ok(entry.includes("done, 1 attempt"));
    assert.ok(entry.includes("completed efficiently"));
  });

  it("generates moderate iteration insight for 2-3 attempt completion", () => {
    const task = makeTask({ state: "done", attempts: 3 });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("done, 3 attempts"));
    assert.ok(entry.includes("moderate iteration"));
  });

  it("generates multi-iteration insight for 5+ attempt completion", () => {
    const task = makeTask({ state: "done", attempts: 5 });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("done, 5 attempts"));
    assert.ok(entry.includes("5 iterations"));
    assert.ok(entry.includes("smaller pieces"));
  });

  it("generates budget insight for budget blocker", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 4,
      blockers: ["Per-task budget exhausted"],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("blocked, 4 attempts"));
    assert.ok(entry.includes("budget"));
  });

  it("generates global budget insight", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 2,
      blockers: ["Global daily budget exhausted"],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("blocked"));
    assert.ok(entry.includes("global daily budget"));
  });

  it("generates regression insight for confidence regression", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 3,
      blockers: ["Confidence regression: 70% < 85% (previous attempt). Execute phase rolled back."],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("blocked"));
    assert.ok(entry.includes("destabilized"));
  });

  it("generates max attempts insight", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 10,
      blockers: ["Max attempts exhausted"],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("blocked"));
    assert.ok(entry.includes("max attempts"));
  });

  it("includes custom blocker text when no pattern matches", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 2,
      blockers: ["Missing API key for external service"],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("blocked"));
    assert.ok(entry.includes("Missing API key"));
  });

  it("truncates long blocker messages", () => {
    const longBlocker = "A".repeat(200);
    const task = makeTask({
      state: "blocked",
      attempts: 1,
      blockers: [longBlocker],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("..."));
    assert.ok(entry.length < 300);
  });

  it("handles blocked task with no blockers", () => {
    const task = makeTask({
      state: "blocked",
      attempts: 1,
      blockers: [],
    });
    const entry = generateMemoryEntry(task);
    assert.ok(entry.includes("no documented reason"));
  });

  it("includes date prefix in YYYY-MM-DD format", () => {
    const task = makeTask();
    const entry = generateMemoryEntry(task);
    const datePattern = /^\[\d{4}-\d{2}-\d{2}\]/;
    assert.ok(datePattern.test(entry));
  });
});

describe("appendMemoryEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-memory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates file when it does not exist", async () => {
    await appendMemoryEntry(tmpDir, "[2025-01-01] t001 (done, 1 attempt): Completed.");
    const content = await readFile(join(tmpDir, "planning-patterns.md"), "utf-8");
    assert.ok(content.includes("t001"));
  });

  it("appends to existing file", async () => {
    await writeFile(join(tmpDir, "planning-patterns.md"), "[2025-01-01] t001 (done, 1 attempt): First.\n", "utf-8");
    await appendMemoryEntry(tmpDir, "[2025-01-02] t002 (done, 2 attempts): Second.");
    const content = await readFile(join(tmpDir, "planning-patterns.md"), "utf-8");
    assert.ok(content.includes("t001"));
    assert.ok(content.includes("t002"));
  });

  it("rotates when exceeding 50 entries", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`[2025-01-01] t${String(i).padStart(3, "0")} (done, 1 attempt): Entry ${i}.`);
    }
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");

    await appendMemoryEntry(tmpDir, "[2025-01-02] t999 (done, 1 attempt): New entry.");

    const content = await readFile(join(tmpDir, "planning-patterns.md"), "utf-8");
    const resultLines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(resultLines.length, 50);
    // Oldest entry (t000) should be rotated out
    assert.ok(!content.includes("t000"));
    // Newest entry should be present
    assert.ok(content.includes("t999"));
  });

  it("handles missing parent directory gracefully", async () => {
    const nestedDir = join(tmpDir, "nested", "deep");
    await appendMemoryEntry(nestedDir, "[2025-01-01] t001 (done, 1 attempt): Test.");
    const content = await readFile(join(nestedDir, "planning-patterns.md"), "utf-8");
    assert.ok(content.includes("t001"));
  });
});

describe("loadRecentPatterns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-memory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string for missing file", async () => {
    const result = await loadRecentPatterns(tmpDir);
    assert.equal(result, "");
  });

  it("returns empty string for empty file", async () => {
    await writeFile(join(tmpDir, "planning-patterns.md"), "\n\n", "utf-8");
    const result = await loadRecentPatterns(tmpDir);
    assert.equal(result, "");
  });

  it("returns all entries when fewer than 20 exist", async () => {
    const lines = [
      "[2025-01-01] t001 (done, 1 attempt): First.",
      "[2025-01-02] t002 (done, 2 attempts): Second.",
      "[2025-01-03] t003 (blocked, 3 attempts): Third.",
    ];
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");
    const result = await loadRecentPatterns(tmpDir);
    assert.ok(result.includes("t001"));
    assert.ok(result.includes("t002"));
    assert.ok(result.includes("t003"));
  });

  it("returns last 20 entries from file with 30 entries", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`[2025-01-01] t${String(i).padStart(3, "0")} (done, 1 attempt): Entry ${i}.`);
    }
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");

    const result = await loadRecentPatterns(tmpDir);
    // Should not contain entries 0-9
    assert.ok(!result.includes("t000"));
    assert.ok(!result.includes("t009"));
    // Should contain entries 10-29
    assert.ok(result.includes("t010"));
    assert.ok(result.includes("t029"));
  });

  it("respects custom count parameter", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`[2025-01-01] t${String(i).padStart(3, "0")} (done, 1 attempt): Entry ${i}.`);
    }
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");

    const result = await loadRecentPatterns(tmpDir, 3);
    const resultLines = result.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(resultLines.length, 3);
    assert.ok(result.includes("t007"));
    assert.ok(result.includes("t009"));
  });
});

describe("computeMetricsFromEntries", () => {
  it("computes average attempts from mixed entries", () => {
    const entries = [
      "[2025-01-01] t001 (done, 1 attempt): Done fast.",
      "[2025-01-02] t002 (done, 3 attempts): Done slow.",
      "[2025-01-03] t003 (blocked, 5 attempts): Budget hit.",
    ];
    const metrics = computeMetricsFromEntries(entries);
    assert.equal(metrics.totalCompleted, 2);
    assert.equal(metrics.totalBlocked, 1);
    // Average: (1 + 3 + 5) / 3 = 3
    assert.ok(Math.abs(metrics.averageAttempts - 3) < 0.01);
  });

  it("computes completion rate", () => {
    const entries = [
      "[2025-01-01] t001 (done, 1 attempt): Done.",
      "[2025-01-02] t002 (done, 2 attempts): Done.",
      "[2025-01-03] t003 (blocked, 3 attempts): Blocked.",
      "[2025-01-04] t004 (done, 1 attempt): Done.",
    ];
    const metrics = computeMetricsFromEntries(entries);
    assert.equal(metrics.completionRate, 0.75);
  });

  it("extracts common blocker reasons", () => {
    const entries = [
      "[2025-01-01] t001 (blocked, 2 attempts): Budget exhausted.",
      "[2025-01-02] t002 (blocked, 3 attempts): Budget was the problem.",
      "[2025-01-03] t003 (blocked, 1 attempt): Confidence regression detected, rolled back.",
    ];
    const metrics = computeMetricsFromEntries(entries);
    assert.equal(metrics.topBlockerReasons.length, 2);
    assert.equal(metrics.topBlockerReasons[0], "budget exhausted");
  });

  it("returns zeros for empty entries", () => {
    const metrics = computeMetricsFromEntries([]);
    assert.equal(metrics.averageAttempts, 0);
    assert.equal(metrics.completionRate, 0);
    assert.equal(metrics.totalCompleted, 0);
    assert.equal(metrics.totalBlocked, 0);
    assert.deepEqual(metrics.topBlockerReasons, []);
  });

  it("skips unparseable lines", () => {
    const entries = [
      "this is not a valid entry",
      "[2025-01-01] t001 (done, 2 attempts): Valid entry.",
      "another garbage line",
    ];
    const metrics = computeMetricsFromEntries(entries);
    assert.equal(metrics.totalCompleted, 1);
    assert.equal(metrics.totalBlocked, 0);
    assert.equal(metrics.averageAttempts, 2);
  });

  it("limits top blocker reasons to 3", () => {
    const entries = [
      "[2025-01-01] t001 (blocked, 1 attempt): Budget issue.",
      "[2025-01-02] t002 (blocked, 1 attempt): Confidence regression rolled back.",
      "[2025-01-03] t003 (blocked, 1 attempt): Max attempts exhausted.",
      "[2025-01-04] t004 (blocked, 1 attempt): Plan too abstract and vague.",
      "[2025-01-05] t005 (blocked, 1 attempt): Scope too large, smaller pieces needed.",
    ];
    const metrics = computeMetricsFromEntries(entries);
    assert.ok(metrics.topBlockerReasons.length <= 3);
  });
});

describe("computeMetrics", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-memory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns zeros for missing file", async () => {
    const metrics = await computeMetrics(tmpDir);
    assert.equal(metrics.averageAttempts, 0);
    assert.equal(metrics.completionRate, 0);
    assert.equal(metrics.totalCompleted, 0);
    assert.equal(metrics.totalBlocked, 0);
  });

  it("reads and parses entries from file", async () => {
    const lines = [
      "[2025-01-01] t001 (done, 1 attempt): Done.",
      "[2025-01-02] t002 (blocked, 5 attempts): Budget exhausted.",
    ];
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");

    const metrics = await computeMetrics(tmpDir);
    assert.equal(metrics.totalCompleted, 1);
    assert.equal(metrics.totalBlocked, 1);
    assert.equal(metrics.averageAttempts, 3); // (1 + 5) / 2
  });
});

describe("formatPlanningMemoryContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-memory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no patterns exist", async () => {
    const result = await formatPlanningMemoryContext(tmpDir);
    assert.equal(result, "");
  });

  it("includes metrics and patterns when data exists", async () => {
    const lines = [
      "[2025-01-01] t001 (done, 1 attempt): Completed efficiently.",
      "[2025-01-02] t002 (blocked, 3 attempts): Budget exhausted.",
    ];
    await writeFile(join(tmpDir, "planning-patterns.md"), lines.join("\n") + "\n", "utf-8");

    const result = await formatPlanningMemoryContext(tmpDir);
    assert.ok(result.includes("Lessons from Previous Tasks"));
    assert.ok(result.includes("1 completed"));
    assert.ok(result.includes("1 blocked"));
    assert.ok(result.includes("50% completion rate"));
    assert.ok(result.includes("Recent patterns:"));
    assert.ok(result.includes("t001"));
    assert.ok(result.includes("t002"));
  });
});
