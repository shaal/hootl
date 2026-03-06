import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { logEvent, getSessionId, _setSessionId, type LogEvent, type LoggerDeps, type LogEntry } from "../logger.js";

const FIXED_TIMESTAMP = "2025-01-01T00:00:00.000Z";
const FIXED_SESSION_ID = "test-session-00000000";

interface TrackingDeps {
  deps: LoggerDeps;
  appended: Array<{ path: string; data: string }>;
  mkdirCalls: Array<{ path: string; opts: { recursive: boolean } }>;
}

function makeTrackingDeps(): TrackingDeps {
  const appended: Array<{ path: string; data: string }> = [];
  const mkdirCalls: Array<{ path: string; opts: { recursive: boolean } }> = [];
  const deps: LoggerDeps = {
    appendFn: async (path, data) => {
      appended.push({ path, data });
    },
    mkdirFn: async (path, opts) => {
      mkdirCalls.push({ path, opts });
    },
    now: () => FIXED_TIMESTAMP,
  };
  return { deps, appended, mkdirCalls };
}

function parseEntry(tracking: TrackingDeps, index = 0): LogEntry {
  const raw = tracking.appended[index]?.data;
  assert.ok(raw, `No appended data at index ${index}`);
  return JSON.parse(raw.trimEnd()) as LogEntry;
}

describe("logEvent", () => {
  beforeEach(() => {
    _setSessionId(FIXED_SESSION_ID);
  });

  it("writes valid JSONL for phase_start", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "execute", attempt: 2 } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "phase_start");
    assert.equal(entry.taskId, "t1");
    assert.equal(entry.timestamp, FIXED_TIMESTAMP);
    assert.equal(entry.sessionId, FIXED_SESSION_ID);
    assert.equal(entry.data.phase, "execute");
    assert.equal(entry.data.attempt, 2);
  });

  it("writes valid JSONL for phase_end with costUsd", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t2", type: "phase_end", data: { phase: "review", attempt: 1, costUsd: 0.42 } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "phase_end");
    assert.equal(entry.data.phase, "review");
    assert.equal(entry.data.costUsd, 0.42);
  });

  it("writes valid JSONL for state_change with optional reason", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t3", type: "state_change", data: { from: "ready", to: "in_progress", reason: "auto-selected" } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "state_change");
    assert.equal(entry.data.from, "ready");
    assert.equal(entry.data.to, "in_progress");
    assert.equal(entry.data.reason, "auto-selected");
  });

  it("writes valid JSONL for state_change without reason", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t3b", type: "state_change", data: { from: "in_progress", to: "done" } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "state_change");
    assert.equal(entry.data.reason, undefined);
  });

  it("writes valid JSONL for decision with optional details", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t4", type: "decision", data: { decision: "skip-plan", details: "remediation plan exists" } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "decision");
    assert.equal(entry.data.decision, "skip-plan");
    assert.equal(entry.data.details, "remediation plan exists");
  });

  it("writes valid JSONL for error", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t5", type: "error", data: { phase: "execute", message: "timeout after 5m" } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "error");
    assert.equal(entry.data.phase, "execute");
    assert.equal(entry.data.message, "timeout after 5m");
  });

  it("writes valid JSONL for hook_run", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t6", type: "hook_run", data: { trigger: "on_confidence_met", skill: "simplify", passed: true, costUsd: 0.05 } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "hook_run");
    assert.equal(entry.data.trigger, "on_confidence_met");
    assert.equal(entry.data.skill, "simplify");
    assert.equal(entry.data.passed, true);
    assert.equal(entry.data.costUsd, 0.05);
  });

  it("writes valid JSONL for budget_check", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t7", type: "budget_check", data: { todayCost: 42.5, limit: 50, exceeded: false } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.type, "budget_check");
    assert.equal(entry.data.todayCost, 42.5);
    assert.equal(entry.data.limit, 50);
    assert.equal(entry.data.exceeded, false);
  });

  it("creates log directory with recursive: true", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "plan", attempt: 1 } };
    await logEvent("/my/log/dir", event, tracking.deps);

    assert.equal(tracking.mkdirCalls.length, 1);
    assert.equal(tracking.mkdirCalls[0]!.path, "/my/log/dir");
    assert.deepEqual(tracking.mkdirCalls[0]!.opts, { recursive: true });
  });

  it("uses injected now() for timestamp", async () => {
    const customTimestamp = "2099-12-31T23:59:59.999Z";
    const tracking = makeTrackingDeps();
    tracking.deps.now = () => customTimestamp;
    const event: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "plan", attempt: 1 } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.timestamp, customTimestamp);
  });

  it("includes sessionId from getSessionId()", async () => {
    _setSessionId("custom-session-abc");
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "plan", attempt: 1 } };
    await logEvent("/logs", event, tracking.deps);

    const entry = parseEntry(tracking);
    assert.equal(entry.sessionId, "custom-session-abc");
  });

  it("appends multiple events as separate JSONL lines", async () => {
    const tracking = makeTrackingDeps();
    const event1: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "plan", attempt: 1 } };
    const event2: LogEvent = { taskId: "t1", type: "phase_end", data: { phase: "plan", attempt: 1, costUsd: 0.1 } };
    await logEvent("/logs", event1, tracking.deps);
    await logEvent("/logs", event2, tracking.deps);

    assert.equal(tracking.appended.length, 2);
    // Each line ends with \n
    assert.ok(tracking.appended[0]!.data.endsWith("\n"));
    assert.ok(tracking.appended[1]!.data.endsWith("\n"));
    // Each is valid JSON (without the trailing newline)
    const entry1 = JSON.parse(tracking.appended[0]!.data.trimEnd()) as LogEntry;
    const entry2 = JSON.parse(tracking.appended[1]!.data.trimEnd()) as LogEntry;
    assert.equal(entry1.type, "phase_start");
    assert.equal(entry2.type, "phase_end");
  });

  it("does not throw when appendFn throws", async () => {
    const tracking = makeTrackingDeps();
    tracking.deps.appendFn = async () => {
      throw new Error("disk full");
    };
    const event: LogEvent = { taskId: "t1", type: "error", data: { phase: "plan", message: "test" } };
    // Must not throw
    await logEvent("/logs", event, tracking.deps);
  });

  it("does not throw when mkdirFn throws", async () => {
    const tracking = makeTrackingDeps();
    tracking.deps.mkdirFn = async () => {
      throw new Error("permission denied");
    };
    const event: LogEvent = { taskId: "t1", type: "error", data: { phase: "plan", message: "test" } };
    // Must not throw
    await logEvent("/logs", event, tracking.deps);
  });

  it("writes to events.jsonl in the given logDir", async () => {
    const tracking = makeTrackingDeps();
    const event: LogEvent = { taskId: "t1", type: "phase_start", data: { phase: "plan", attempt: 1 } };
    await logEvent("/custom/dir", event, tracking.deps);

    assert.equal(tracking.appended.length, 1);
    assert.ok(tracking.appended[0]!.path.endsWith("/custom/dir/events.jsonl"));
  });
});

describe("getSessionId / _setSessionId", () => {
  it("returns a non-empty string", () => {
    const id = getSessionId();
    assert.ok(id.length > 0);
  });

  it("returns the same value on repeated calls", () => {
    const id1 = getSessionId();
    const id2 = getSessionId();
    assert.equal(id1, id2);
  });

  it("_setSessionId overrides the value", () => {
    _setSessionId("override-id-xyz");
    assert.equal(getSessionId(), "override-id-xyz");
    // Restore for other tests
    _setSessionId(FIXED_SESSION_ID);
  });
});
