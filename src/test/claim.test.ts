import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskBackend } from "../tasks/local.js";
import { findAndClaimTask } from "../selection.js";
import type { Task, TaskBackend } from "../tasks/types.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-claim-test-"));
}

describe("LocalTaskBackend.claimTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns true and creates .claim file with correct PID", async () => {
    const task = await backend.createTask({ title: "Claimable", description: "test" });
    const claimed = await backend.claimTask(task.id);

    assert.equal(claimed, true);

    const claimPath = join(tempDir, task.id, ".claim");
    assert.equal(existsSync(claimPath), true);

    const raw = await readFile(claimPath, "utf-8");
    const data = JSON.parse(raw) as { pid: number; startedAt: string };
    assert.equal(data.pid, process.pid);
    assert.equal(typeof data.startedAt, "string");
    // startedAt should be a valid ISO date
    assert.equal(Number.isNaN(Date.parse(data.startedAt)), false);
  });

  it("transitions task to in_progress on successful claim", async () => {
    const task = await backend.createTask({ title: "State check", description: "test" });
    assert.equal(task.state, "ready");

    await backend.claimTask(task.id);

    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");
  });

  it("returns false when task is already claimed by a live process", async () => {
    const task = await backend.createTask({ title: "Conflict", description: "test" });

    // Pre-create a .claim file with the current (live) PID
    const claimPath = join(tempDir, task.id, ".claim");
    writeFileSync(claimPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    const claimed = await backend.claimTask(task.id);
    assert.equal(claimed, false);

    // Task state should remain ready (not transitioned)
    const check = await backend.getTask(task.id);
    assert.equal(check.state, "ready");
  });

  it("cleans up stale claim from dead PID and re-claims", async () => {
    const task = await backend.createTask({ title: "Stale", description: "test" });

    // Write a claim file with a PID that almost certainly doesn't exist
    const deadPid = 4_000_000_000; // PID space doesn't go this high on most systems
    const claimPath = join(tempDir, task.id, ".claim");
    writeFileSync(claimPath, JSON.stringify({ pid: deadPid, startedAt: "2024-01-01T00:00:00.000Z" }));

    const claimed = await backend.claimTask(task.id);
    assert.equal(claimed, true);

    // Verify the new claim has our PID
    const raw = await readFile(claimPath, "utf-8");
    const data = JSON.parse(raw) as { pid: number; startedAt: string };
    assert.equal(data.pid, process.pid);

    // Task should now be in_progress
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "in_progress");
  });
});

describe("LocalTaskBackend.releaseTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the .claim file after release", async () => {
    const task = await backend.createTask({ title: "Release me", description: "test" });
    await backend.claimTask(task.id);

    const claimPath = join(tempDir, task.id, ".claim");
    assert.equal(existsSync(claimPath), true);

    await backend.releaseTask(task.id);
    assert.equal(existsSync(claimPath), false);
  });

  it("does not throw when releasing an unclaimed task", async () => {
    const task = await backend.createTask({ title: "Never claimed", description: "test" });
    // Should not throw
    await backend.releaseTask(task.id);
  });
});

describe("findAndClaimTask", () => {
  let backend: LocalTaskBackend;

  beforeEach(async () => {
    tempDir = await freshDir();
    backend = new LocalTaskBackend(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("claims the first runnable task", async () => {
    const t1 = await backend.createTask({ title: "First", description: "A" });
    const t2 = await backend.createTask({ title: "Second", description: "B" });
    const candidates = [t1, t2];

    const { task, skipped } = await findAndClaimTask(candidates, backend);
    assert.equal(task?.id, t1.id);
    assert.equal(skipped.length, 0);

    // Verify claim file exists
    assert.equal(existsSync(join(tempDir, t1.id, ".claim")), true);
  });

  it("skips already-claimed task and claims the next one", async () => {
    const t1 = await backend.createTask({ title: "Claimed", description: "A" });
    const t2 = await backend.createTask({ title: "Available", description: "B" });

    // Pre-claim t1 with the current (live) PID to simulate another instance
    writeFileSync(
      join(tempDir, t1.id, ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const candidates = [t1, t2];
    const { task, skipped } = await findAndClaimTask(candidates, backend);

    assert.equal(task?.id, t2.id);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.id, t1.id);
    assert.equal(skipped[0]?.reason, "claimed by another instance");
  });

  it("respects dependencies before attempting to claim", async () => {
    const dep = await backend.createTask({ title: "Dependency", description: "dep" });
    // dep is in 'ready' state — not done/review
    const t1 = await backend.createTask({ title: "Dependent", description: "needs dep", dependencies: [dep.id] });
    const t2 = await backend.createTask({ title: "Independent", description: "no deps" });

    const candidates = [t1, t2];
    const { task, skipped } = await findAndClaimTask(candidates, backend);

    assert.equal(task?.id, t2.id);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.id, t1.id);
    assert.ok(skipped[0]?.reason.includes("depends on"));
  });

  it("returns undefined when all candidates are claimed", async () => {
    const t1 = await backend.createTask({ title: "Taken1", description: "A" });
    const t2 = await backend.createTask({ title: "Taken2", description: "B" });

    // Pre-claim both with the current PID
    writeFileSync(
      join(tempDir, t1.id, ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(tempDir, t2.id, ".claim"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const candidates = [t1, t2];
    const { task, skipped } = await findAndClaimTask(candidates, backend);

    assert.equal(task, undefined);
    assert.equal(skipped.length, 2);
  });
});
