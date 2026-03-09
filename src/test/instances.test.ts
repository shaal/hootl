import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerInstance,
  deregisterInstance,
  deregisterInstanceSync,
  getActiveInstances,
  _resetRegisteredDir,
} from "../instances.js";
import type { InstanceInfo } from "../instances.js";

let tempDir: string;

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hootl-instances-test-"));
}

// ── registerInstance ──────────────────────────────────────────────

describe("registerInstance", () => {
  beforeEach(async () => {
    _resetRegisteredDir();
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a <pid>.json file with correct content", async () => {
    const instancesDir = join(tempDir, "instances");
    await registerInstance("conservative", { instancesDir });

    const filePath = join(instancesDir, `${process.pid}.json`);
    assert.ok(existsSync(filePath), "Instance file should exist");

    const raw = await readFile(filePath, "utf-8");
    const data: unknown = JSON.parse(raw);
    assert.ok(typeof data === "object" && data !== null);

    const info = data as InstanceInfo;
    assert.equal(info.pid, process.pid);
    assert.equal(info.level, "conservative");
    assert.equal(typeof info.startedAt, "string");
    // Verify startedAt is a valid ISO 8601 timestamp
    assert.ok(!isNaN(Date.parse(info.startedAt)), "startedAt should be a valid ISO date");
  });

  it("creates the instances directory if it does not exist", async () => {
    const instancesDir = join(tempDir, "nested", "instances");
    assert.ok(!existsSync(instancesDir), "Dir should not exist before registration");

    await registerInstance("aggressive", { instancesDir });

    assert.ok(existsSync(instancesDir), "Dir should be created by registerInstance");
    assert.ok(existsSync(join(instancesDir, `${process.pid}.json`)));
  });

  it("file content has trailing newline (consistent with project style)", async () => {
    const instancesDir = join(tempDir, "instances");
    await registerInstance("conservative", { instancesDir });

    const raw = await readFile(join(instancesDir, `${process.pid}.json`), "utf-8");
    assert.ok(raw.endsWith("\n"), "File should end with newline");
  });
});

// ── deregisterInstance (async) ───────────────────────────────────

describe("deregisterInstance", () => {
  beforeEach(async () => {
    _resetRegisteredDir();
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the instance file after registration", async () => {
    const instancesDir = join(tempDir, "instances");
    await registerInstance("conservative", { instancesDir });

    const filePath = join(instancesDir, `${process.pid}.json`);
    assert.ok(existsSync(filePath), "File should exist before deregister");

    await deregisterInstance();

    assert.ok(!existsSync(filePath), "File should be removed after deregister");
  });

  it("accepts explicit deps to override stored dir", async () => {
    const instancesDir = join(tempDir, "instances");
    mkdirSync(instancesDir, { recursive: true });
    writeFileSync(
      join(instancesDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), level: "test" }),
    );

    await deregisterInstance({ instancesDir });

    assert.ok(!existsSync(join(instancesDir, `${process.pid}.json`)));
  });

  it("does not throw when file does not exist", async () => {
    const instancesDir = join(tempDir, "instances");
    mkdirSync(instancesDir, { recursive: true });

    // Should not throw — best-effort removal
    await deregisterInstance({ instancesDir });
  });

  it("is a no-op when no dir is stored and no deps provided", async () => {
    // No prior registerInstance call, no deps — should silently return
    await deregisterInstance();
  });
});

// ── deregisterInstanceSync ───────────────────────────────────────

describe("deregisterInstanceSync", () => {
  beforeEach(async () => {
    _resetRegisteredDir();
    tempDir = await freshDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the instance file synchronously", async () => {
    const instancesDir = join(tempDir, "instances");
    await registerInstance("conservative", { instancesDir });

    const filePath = join(instancesDir, `${process.pid}.json`);
    assert.ok(existsSync(filePath), "File should exist before sync deregister");

    deregisterInstanceSync();

    assert.ok(!existsSync(filePath), "File should be removed after sync deregister");
  });

  it("does not throw when file does not exist", () => {
    const instancesDir = join(tempDir, "instances");
    mkdirSync(instancesDir, { recursive: true });

    // Should not throw
    deregisterInstanceSync({ instancesDir });
  });
});

// ── getActiveInstances ───────────────────────────────────────────

describe("getActiveInstances", () => {
  let instancesDir: string;

  beforeEach(async () => {
    _resetRegisteredDir();
    tempDir = await freshDir();
    instancesDir = join(tempDir, "instances");
    mkdirSync(instancesDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns the current process as a live instance", async () => {
    await registerInstance("conservative", { instancesDir });

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 1);
    assert.equal(result.instances.length, 1);

    const inst = result.instances[0];
    assert.ok(inst !== undefined);
    assert.equal(inst.pid, process.pid);
    assert.equal(inst.level, "conservative");
    assert.equal(typeof inst.startedAt, "string");
  });

  it("cleans up stale entries with dead PIDs", async () => {
    // Write a fake instance with a non-existent PID
    const deadPid = 4_000_000_000;
    const fakePath = join(instancesDir, `${deadPid}.json`);
    writeFileSync(
      fakePath,
      JSON.stringify({ pid: deadPid, startedAt: "2025-01-01T00:00:00.000Z", level: "test" }),
    );
    assert.ok(existsSync(fakePath), "Stale file should exist before scan");

    const result = await getActiveInstances({ instancesDir });

    assert.equal(result.count, 0);
    assert.equal(result.instances.length, 0);
    assert.ok(!existsSync(fakePath), "Stale file should be removed after scan");
  });

  it("handles mix of live and dead PIDs correctly", async () => {
    // Register current (live) process
    await registerInstance("conservative", { instancesDir });

    // Write a fake dead-PID instance
    const deadPid = 4_000_000_000;
    const deadPath = join(instancesDir, `${deadPid}.json`);
    writeFileSync(
      deadPath,
      JSON.stringify({ pid: deadPid, startedAt: "2024-06-15T12:00:00.000Z", level: "aggressive" }),
    );

    const result = await getActiveInstances({ instancesDir });

    assert.equal(result.count, 1, "Only live instance counted");
    assert.equal(result.instances.length, 1);
    assert.equal(result.instances[0]?.pid, process.pid);
    assert.ok(!existsSync(deadPath), "Dead PID file should be cleaned up");
    assert.ok(existsSync(join(instancesDir, `${process.pid}.json`)), "Live PID file should remain");
  });

  it("returns empty result for non-existent directory", async () => {
    const result = await getActiveInstances({ instancesDir: join(tempDir, "nonexistent") });
    assert.equal(result.count, 0);
    assert.equal(result.instances.length, 0);
  });

  it("returns empty result for empty directory", async () => {
    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.equal(result.instances.length, 0);
  });

  it("removes corrupt JSON files", async () => {
    writeFileSync(join(instancesDir, "garbage.json"), "not valid json {{{");

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(instancesDir, "garbage.json")), "Corrupt file should be removed");
  });

  it("removes files with missing required fields", async () => {
    // Missing 'level' field
    writeFileSync(
      join(instancesDir, "12345.json"),
      JSON.stringify({ pid: 12345, startedAt: "2025-01-01T00:00:00.000Z" }),
    );

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(instancesDir, "12345.json")), "Invalid file should be removed");
  });

  it("ignores non-JSON files", async () => {
    writeFileSync(join(instancesDir, "readme.txt"), "not an instance file");
    await registerInstance("conservative", { instancesDir });

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 1);
    // Non-JSON file should still exist (not touched)
    assert.ok(existsSync(join(instancesDir, "readme.txt")));
  });

  it("validates JSON structure: pid must be number", async () => {
    writeFileSync(
      join(instancesDir, "bad-pid.json"),
      JSON.stringify({ pid: "not-a-number", startedAt: "2025-01-01T00:00:00.000Z", level: "test" }),
    );

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(instancesDir, "bad-pid.json")));
  });

  it("validates JSON structure: startedAt must be string", async () => {
    writeFileSync(
      join(instancesDir, "bad-time.json"),
      JSON.stringify({ pid: 12345, startedAt: 12345, level: "test" }),
    );

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(instancesDir, "bad-time.json")));
  });

  it("validates JSON structure: level must be string", async () => {
    writeFileSync(
      join(instancesDir, "bad-level.json"),
      JSON.stringify({ pid: 12345, startedAt: "2025-01-01T00:00:00.000Z", level: 42 }),
    );

    const result = await getActiveInstances({ instancesDir });
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(instancesDir, "bad-level.json")));
  });
});
