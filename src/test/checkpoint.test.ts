import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCheckpoint, readCheckpoint, clearCheckpoint } from "../loop.js";
import type { Checkpoint } from "../loop.js";

describe("writeCheckpoint", () => {
  it("writes valid JSON with phase, attempt, and timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-write-"));
    await writeCheckpoint(dir, "execute", 3);

    const raw = await readFile(join(dir, "checkpoint.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    assert.ok(typeof parsed === "object" && parsed !== null);
    const record = parsed as Record<string, unknown>;
    assert.equal(record["phase"], "execute");
    assert.equal(record["attempt"], 3);
    assert.ok(typeof record["timestamp"] === "string");
    // Timestamp should be a valid ISO date
    assert.ok(!Number.isNaN(Date.parse(record["timestamp"] as string)));
  });

  it("overwrites existing checkpoint atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-overwrite-"));
    await writeCheckpoint(dir, "plan", 1);
    await writeCheckpoint(dir, "review", 2);

    const checkpoint = await readCheckpoint(dir);
    assert.ok(checkpoint !== null);
    assert.equal(checkpoint.phase, "review");
    assert.equal(checkpoint.attempt, 2);
  });

  it("does not throw if directory is missing", async () => {
    // writeCheckpoint wraps errors in try/catch — should not throw
    await assert.doesNotReject(() =>
      writeCheckpoint("/nonexistent/path/that/does/not/exist", "plan", 1),
    );
  });
});

describe("readCheckpoint", () => {
  it("reads a valid checkpoint file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-read-"));
    const data: Checkpoint = { phase: "execute", attempt: 2, timestamp: "2026-03-05T10:00:00.000Z" };
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify(data), "utf-8");

    const result = await readCheckpoint(dir);
    assert.ok(result !== null);
    assert.equal(result.phase, "execute");
    assert.equal(result.attempt, 2);
    assert.equal(result.timestamp, "2026-03-05T10:00:00.000Z");
  });

  it("returns null for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-missing-"));
    const result = await readCheckpoint(dir);
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-invalid-"));
    await writeFile(join(dir, "checkpoint.json"), "not json at all", "utf-8");

    const result = await readCheckpoint(dir);
    assert.equal(result, null);
  });

  it("returns null for JSON missing required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-partial-"));
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify({ phase: "plan" }), "utf-8");

    const result = await readCheckpoint(dir);
    assert.equal(result, null);
  });

  it("returns null for wrong field types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-types-"));
    await writeFile(
      join(dir, "checkpoint.json"),
      JSON.stringify({ phase: 123, attempt: "two", timestamp: true }),
      "utf-8",
    );

    const result = await readCheckpoint(dir);
    assert.equal(result, null);
  });
});

describe("clearCheckpoint", () => {
  it("removes the checkpoint file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-clear-"));
    await writeCheckpoint(dir, "review", 1);
    assert.ok(existsSync(join(dir, "checkpoint.json")));

    await clearCheckpoint(dir);
    assert.ok(!existsSync(join(dir, "checkpoint.json")));
  });

  it("does not throw if file is already missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-clear-missing-"));
    await assert.doesNotReject(() => clearCheckpoint(dir));
  });
});

describe("checkpoint round-trip", () => {
  it("write then read returns the same data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-roundtrip-"));
    await writeCheckpoint(dir, "preflight", 0);

    const result = await readCheckpoint(dir);
    assert.ok(result !== null);
    assert.equal(result.phase, "preflight");
    assert.equal(result.attempt, 0);
  });

  it("clear then read returns null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-clear-read-"));
    await writeCheckpoint(dir, "execute", 5);
    await clearCheckpoint(dir);

    const result = await readCheckpoint(dir);
    assert.equal(result, null);
  });
});
