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
import type { Task } from "../tasks/types.js";

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

  function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
    return {
      state: "ready",
      description: "",
      priority: "medium",
      type: "feature",
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      blockers: [],
      dependencies: [],
      userPriority: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

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
