import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readClaimFile,
  isProcessAlive,
  getActiveInstances,
  writeStatusSummary,
} from "../status.js";
import type { Goal } from "../goals.js";
import { makeTask } from "./helpers.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-status-test-"));
}

// ── readClaimFile ──────────────────────────────────────────────────

describe("readClaimFile", () => {
  beforeEach(async () => {
    tempDir = await freshDir();
    await mkdir(join(tempDir, "task-001"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns pid and startedAt from a valid .claim file", async () => {
    const claimPath = join(tempDir, "task-001", ".claim");
    writeFileSync(claimPath, JSON.stringify({ pid: 12345, startedAt: "2025-01-01T00:00:00.000Z" }));

    const result = await readClaimFile(join(tempDir, "task-001"));
    assert.deepEqual(result, { pid: 12345, startedAt: "2025-01-01T00:00:00.000Z" });
  });

  it("returns null for missing .claim file", async () => {
    const result = await readClaimFile(join(tempDir, "task-001"));
    assert.equal(result, null);
  });

  it("returns null for corrupt non-JSON .claim file", async () => {
    writeFileSync(join(tempDir, "task-001", ".claim"), "not json {{{");

    const result = await readClaimFile(join(tempDir, "task-001"));
    assert.equal(result, null);
  });

  it("returns null for .claim with missing pid field", async () => {
    writeFileSync(
      join(tempDir, "task-001", ".claim"),
      JSON.stringify({ startedAt: "2025-01-01T00:00:00.000Z" }),
    );

    const result = await readClaimFile(join(tempDir, "task-001"));
    assert.equal(result, null);
  });

  it("returns null for .claim with wrong pid type", async () => {
    writeFileSync(
      join(tempDir, "task-001", ".claim"),
      JSON.stringify({ pid: "not-a-number", startedAt: "2025-01-01T00:00:00.000Z" }),
    );

    const result = await readClaimFile(join(tempDir, "task-001"));
    assert.equal(result, null);
  });

  it("returns null for non-existent task directory", async () => {
    const result = await readClaimFile(join(tempDir, "task-999"));
    assert.equal(result, null);
  });
});

// ── isProcessAlive ─────────────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for a PID that does not exist", () => {
    // PID space doesn't go this high on most systems
    assert.equal(isProcessAlive(4_000_000_000), false);
  });
});

// ── getActiveInstances ─────────────────────────────────────────────

describe("getActiveInstances", () => {
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await freshDir();
    tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns count 0 and empty map when no claim files exist", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 0);
    assert.equal(result.pids.size, 0);
  });

  it("counts live PIDs (current process)", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });
    writeFileSync(
      join(tasksDir, "task-001", ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 1);
    assert.equal(result.pids.get("task-001"), process.pid);
  });

  it("excludes dead PIDs from count", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });
    writeFileSync(
      join(tasksDir, "task-001", ".claim"),
      JSON.stringify({ pid: 4_000_000_000, startedAt: "2024-01-01T00:00:00.000Z" }),
    );

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 0);
    assert.equal(result.pids.size, 0);
  });

  it("handles mixed live and dead PIDs correctly", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });
    await mkdir(join(tasksDir, "task-002"), { recursive: true });

    // Live claim (current process)
    writeFileSync(
      join(tasksDir, "task-001", ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    // Dead claim
    writeFileSync(
      join(tasksDir, "task-002", ".claim"),
      JSON.stringify({ pid: 4_000_000_000, startedAt: "2024-01-01T00:00:00.000Z" }),
    );

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 1);
    assert.equal(result.pids.has("task-001"), true);
    assert.equal(result.pids.has("task-002"), false);
  });

  it("returns correct pids map keyed by task ID", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });
    await mkdir(join(tasksDir, "task-002"), { recursive: true });

    writeFileSync(
      join(tasksDir, "task-001", ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(tasksDir, "task-002", ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 2);
    assert.equal(result.pids.get("task-001"), process.pid);
    assert.equal(result.pids.get("task-002"), process.pid);
  });

  it("gracefully handles non-existent tasks directory", async () => {
    const result = await getActiveInstances(join(tempDir, "nonexistent"));
    assert.equal(result.count, 0);
    assert.equal(result.pids.size, 0);
  });

  it("skips corrupt claim files gracefully", async () => {
    await mkdir(join(tasksDir, "task-001"), { recursive: true });
    await mkdir(join(tasksDir, "task-002"), { recursive: true });

    // Corrupt claim
    writeFileSync(join(tasksDir, "task-001", ".claim"), "garbage data!!!");
    // Valid live claim
    writeFileSync(
      join(tasksDir, "task-002", ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await getActiveInstances(tasksDir);
    assert.equal(result.count, 1);
    assert.equal(result.pids.has("task-001"), false);
    assert.equal(result.pids.get("task-002"), process.pid);
  });
});

// ── writeStatusSummary with claim info ─────────────────────────────

describe("writeStatusSummary with claim info", () => {
  let hootlDir: string;

  beforeEach(async () => {
    tempDir = await freshDir();
    hootlDir = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes Active instances line when claimInfo is provided", async () => {
    const tasks = [makeTask({ id: "task-001", title: "Something", state: "ready" })];
    const claimInfo = { count: 2, pids: new Map<string, number>() };

    await writeStatusSummary(hootlDir, tasks, claimInfo);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("Active instances: 2"));
  });

  it("shows PID annotation for in_progress tasks in pids map", async () => {
    const tasks = [
      makeTask({ id: "task-001", title: "Running task", state: "in_progress", confidence: 50, attempts: 2 }),
    ];
    const pids = new Map<string, number>([["task-001", 42000]]);
    const claimInfo = { count: 1, pids };

    await writeStatusSummary(hootlDir, tasks, claimInfo);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("(PID: 42000)"));
  });

  it("does not annotate in_progress tasks not in pids map", async () => {
    const tasks = [
      makeTask({ id: "task-001", title: "Unclaimed running", state: "in_progress", confidence: 50, attempts: 1 }),
    ];
    const claimInfo = { count: 0, pids: new Map<string, number>() };

    await writeStatusSummary(hootlDir, tasks, claimInfo);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(!content.includes("(PID:"));
    assert.ok(content.includes("Unclaimed running"));
  });

  it("does not include Active instances line when claimInfo is omitted", async () => {
    const tasks = [makeTask({ id: "task-001", title: "Legacy call", state: "ready" })];

    await writeStatusSummary(hootlDir, tasks);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(!content.includes("Active instances"));
  });

  it("does not annotate review-state tasks even if in pids map", async () => {
    const tasks = [
      makeTask({ id: "task-001", title: "In review", state: "review", confidence: 95, attempts: 3 }),
    ];
    const pids = new Map<string, number>([["task-001", 42000]]);
    const claimInfo = { count: 1, pids };

    await writeStatusSummary(hootlDir, tasks, claimInfo);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(!content.includes("(PID:"));
  });
});

// ── writeStatusSummary with goals ──────────────────────────────────

describe("writeStatusSummary with goals", () => {
  let hootlDir: string;

  beforeEach(async () => {
    tempDir = await freshDir();
    hootlDir = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("groups tasks under goal headers with done counts", async () => {
    const goals: Goal[] = [
      { id: "g1", title: "Auth System", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "Login flow", goal: "g1", state: "done", updatedAt: "2025-06-01T00:00:00Z" }),
      makeTask({ id: "t2", title: "OAuth setup", goal: "g1", state: "ready" }),
      makeTask({ id: "t3", title: "Token refresh", goal: "g1", state: "in_progress", confidence: 60, attempts: 1 }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## Auth System (1/3 done)"), "Goal header with done count");
    assert.ok(content.includes("### IN_PROGRESS (1)"), "State subgroup header");
    assert.ok(content.includes("### READY (1)"), "Ready subgroup");
    assert.ok(content.includes("### DONE (1)"), "Done subgroup");
  });

  it("renders multiple goals in registry order", async () => {
    const goals: Goal[] = [
      { id: "g-beta", title: "Beta Features", description: "" },
      { id: "g-alpha", title: "Alpha Features", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "Beta task", goal: "g-beta", state: "ready" }),
      makeTask({ id: "t2", title: "Alpha task", goal: "g-alpha", state: "ready" }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    const betaIdx = content.indexOf("## Beta Features");
    const alphaIdx = content.indexOf("## Alpha Features");
    assert.ok(betaIdx !== -1, "Beta goal present");
    assert.ok(alphaIdx !== -1, "Alpha goal present");
    assert.ok(betaIdx < alphaIdx, "Goals appear in registry order, not alphabetical");
  });

  it("renders ungrouped tasks under Ungrouped header", async () => {
    const goals: Goal[] = [
      { id: "g1", title: "Goal One", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "Grouped task", goal: "g1", state: "ready" }),
      makeTask({ id: "t2", title: "Orphan task", goal: null, state: "done", updatedAt: "2025-06-01T00:00:00Z" }),
      makeTask({ id: "t3", title: "Another orphan", goal: null, state: "ready" }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## Goal One (0/1 done)"), "Goal header");
    assert.ok(content.includes("## Ungrouped (1/2 done)"), "Ungrouped header with done count");
    assert.ok(content.includes("Orphan task"));
    assert.ok(content.includes("Another orphan"));
  });

  it("treats tasks with unknown goal ID as ungrouped", async () => {
    const goals: Goal[] = [
      { id: "g1", title: "Known Goal", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "Known", goal: "g1", state: "ready" }),
      makeTask({ id: "t2", title: "Unknown ref", goal: "nonexistent", state: "ready" }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## Known Goal (0/1 done)"));
    assert.ok(content.includes("## Ungrouped (0/1 done)"));
    assert.ok(content.includes("Unknown ref"));
  });

  it("omits empty goals from output", async () => {
    const goals: Goal[] = [
      { id: "g1", title: "Has Tasks", description: "" },
      { id: "g2", title: "Empty Goal", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "Only task", goal: "g1", state: "ready" }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## Has Tasks"), "Goal with tasks shown");
    assert.ok(!content.includes("Empty Goal"), "Goal with no tasks omitted");
  });

  it("falls back to flat rendering when goals is undefined", async () => {
    const tasks = [
      makeTask({ id: "t1", title: "Flat task", state: "ready" }),
      makeTask({ id: "t2", title: "Done task", state: "done", updatedAt: "2025-06-01T00:00:00Z" }),
    ];

    await writeStatusSummary(hootlDir, tasks);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## READY (1)"), "Flat state header");
    assert.ok(content.includes("## DONE (1)"), "Flat done header");
    assert.ok(!content.includes("Ungrouped"), "No ungrouped header in flat mode");
  });

  it("falls back to flat rendering when goals array is empty", async () => {
    const tasks = [
      makeTask({ id: "t1", title: "Flat task", state: "ready" }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, []);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(content.includes("## READY (1)"), "Flat state header");
    assert.ok(!content.includes("Ungrouped"), "No ungrouped header in flat mode");
  });

  it("renders all tasks as ungrouped when none match any goal", async () => {
    const goals: Goal[] = [
      { id: "g1", title: "Empty Goal", description: "" },
    ];
    const tasks = [
      makeTask({ id: "t1", title: "No goal", goal: null, state: "ready" }),
      makeTask({ id: "t2", title: "Also no goal", goal: null, state: "blocked", blockers: ["stuck"] }),
    ];

    await writeStatusSummary(hootlDir, tasks, undefined, goals);

    const content = await readFile(join(hootlDir, "status.md"), "utf-8");
    assert.ok(!content.includes("## Empty Goal"), "Empty goal omitted");
    assert.ok(content.includes("## Ungrouped (0/2 done)"), "Ungrouped shows all");
  });
});
