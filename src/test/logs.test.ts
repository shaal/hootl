import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readLogEntries, filterEntries, formatTimeline, logsCommand, type ReadLogsDeps, type LogFilters } from "../logs.js";
import type { LogEntry } from "../logger.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TIMESTAMP = "2025-06-15T14:30:45.123Z";

function makeEntry(overrides: Partial<LogEntry> & { type: LogEntry["type"]; data: LogEntry["data"] }): LogEntry {
  return {
    timestamp: TIMESTAMP,
    sessionId: "sess-001",
    taskId: "task-1",
    ...overrides,
  } as LogEntry;
}

function makeDeps(content: string): ReadLogsDeps {
  return {
    readFileFn: async () => content,
  };
}

function makeEnoentDeps(): ReadLogsDeps {
  return {
    readFileFn: async () => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  };
}

// ── Sample entries for all 9 event types ────────────────────────────────────

const runStartEntry: LogEntry = makeEntry({
  type: "run_start",
  data: { config: { budgetGlobal: 50, confidenceTarget: 80, onConfidenceMode: "merge", maxAttempts: 5, useWorktrees: true } },
});

const phaseStartEntry: LogEntry = makeEntry({
  type: "phase_start",
  data: { phase: "execute", attempt: 2 },
});

const phaseEndEntry: LogEntry = makeEntry({
  type: "phase_end",
  data: { phase: "review", attempt: 1, costUsd: 0.42, durationMs: 12345 },
});

const phaseEndNoDurationEntry: LogEntry = makeEntry({
  type: "phase_end",
  data: { phase: "plan", attempt: 1, costUsd: 0.10 },
});

const stateChangeEntry: LogEntry = makeEntry({
  type: "state_change",
  data: { from: "ready", to: "in_progress", reason: "auto-selected" },
});

const stateChangeNoReasonEntry: LogEntry = makeEntry({
  type: "state_change",
  data: { from: "in_progress", to: "done" },
});

const decisionEntry: LogEntry = makeEntry({
  type: "decision",
  data: { decision: "skip-plan", details: "remediation plan exists" },
});

const decisionNoDetailsEntry: LogEntry = makeEntry({
  type: "decision",
  data: { decision: "confidence_met" },
});

const errorEntry: LogEntry = makeEntry({
  type: "error",
  data: { phase: "execute", message: "timeout after 5m" },
});

const hookRunEntry: LogEntry = makeEntry({
  type: "hook_run",
  data: { trigger: "on_confidence_met", passed: true, costUsd: 0.05 },
});

const hookRunFailEntry: LogEntry = makeEntry({
  type: "hook_run",
  data: { trigger: "on_confidence_met", passed: false, costUsd: 0.03 },
});

const budgetCheckEntry: LogEntry = makeEntry({
  type: "budget_check",
  data: { todayCost: 42.5, limit: 50, exceeded: false },
});

const budgetCheckExceededEntry: LogEntry = makeEntry({
  type: "budget_check",
  data: { todayCost: 55, limit: 50, exceeded: true },
});

const rollbackEntry: LogEntry = makeEntry({
  type: "rollback",
  data: { shaBefore: "abc1234def", shaAfter: "xyz9876abc", reason: "Confidence regression" },
});

// ── readLogEntries ──────────────────────────────────────────────────────────

describe("readLogEntries", () => {
  it("parses valid JSONL with multiple lines", async () => {
    const lines = [
      JSON.stringify(phaseStartEntry),
      JSON.stringify(phaseEndEntry),
    ].join("\n");

    const entries = await readLogEntries("/logs", makeDeps(lines));
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.type, "phase_start");
    assert.equal(entries[1]!.type, "phase_end");
  });

  it("skips malformed lines without crashing", async () => {
    const lines = [
      JSON.stringify(phaseStartEntry),
      "this is not json {{{",
      JSON.stringify(errorEntry),
      "{ incomplete",
    ].join("\n");

    const entries = await readLogEntries("/logs", makeDeps(lines));
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.type, "phase_start");
    assert.equal(entries[1]!.type, "error");
  });

  it("returns empty array when file is missing (ENOENT)", async () => {
    const entries = await readLogEntries("/logs", makeEnoentDeps());
    assert.deepEqual(entries, []);
  });

  it("returns empty array for empty file", async () => {
    const entries = await readLogEntries("/logs", makeDeps(""));
    assert.deepEqual(entries, []);
  });

  it("returns empty array for whitespace-only file", async () => {
    const entries = await readLogEntries("/logs", makeDeps("  \n\n  "));
    assert.deepEqual(entries, []);
  });

  it("handles trailing newline in JSONL", async () => {
    const content = JSON.stringify(phaseStartEntry) + "\n";
    const entries = await readLogEntries("/logs", makeDeps(content));
    assert.equal(entries.length, 1);
  });

  it("re-throws non-ENOENT errors", async () => {
    const deps: ReadLogsDeps = {
      readFileFn: async () => {
        throw new Error("permission denied");
      },
    };
    await assert.rejects(() => readLogEntries("/logs", deps), /permission denied/);
  });
});

// ── filterEntries ───────────────────────────────────────────────────────────

describe("filterEntries", () => {
  const entries: LogEntry[] = [
    makeEntry({ taskId: "task-1", type: "phase_start", data: { phase: "plan", attempt: 1 } }),
    makeEntry({ taskId: "task-2", type: "error", data: { phase: "execute", message: "failed" } }),
    makeEntry({ taskId: "task-1", type: "error", data: { phase: "review", message: "timeout" } }),
    makeEntry({ taskId: "task-3", type: "state_change", data: { from: "ready", to: "in_progress" } }),
  ];

  it("returns all entries with no filters", () => {
    const result = filterEntries(entries, {});
    assert.equal(result.length, 4);
  });

  it("filters by taskId", () => {
    const result = filterEntries(entries, { taskId: "task-1" });
    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.taskId === "task-1"));
  });

  it("filters by event type", () => {
    const result = filterEntries(entries, { eventType: "error" });
    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.type === "error"));
  });

  it("stacks filters with AND logic", () => {
    const result = filterEntries(entries, { taskId: "task-1", eventType: "error" });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.taskId, "task-1");
    assert.equal(result[0]!.type, "error");
  });

  it("returns empty array when no matches", () => {
    const result = filterEntries(entries, { taskId: "nonexistent" });
    assert.deepEqual(result, []);
  });
});

// ── formatTimeline ──────────────────────────────────────────────────────────

describe("formatTimeline", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(formatTimeline([]), []);
  });

  it("formats run_start event", () => {
    const lines = formatTimeline([runStartEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("run_start"));
    assert.ok(lines[0]!.includes("budget=$50/day"));
    assert.ok(lines[0]!.includes("target=80%"));
  });

  it("formats phase_start event", () => {
    const lines = formatTimeline([phaseStartEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("phase_start"));
    assert.ok(lines[0]!.includes("execute attempt #2"));
  });

  it("formats phase_end event with duration", () => {
    const lines = formatTimeline([phaseEndEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("phase_end"));
    assert.ok(lines[0]!.includes("review attempt #1"));
    assert.ok(lines[0]!.includes("$0.42"));
    assert.ok(lines[0]!.includes("(12345ms)"));
  });

  it("formats phase_end event without duration", () => {
    const lines = formatTimeline([phaseEndNoDurationEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("$0.1"));
    assert.ok(!lines[0]!.includes("ms)"));
  });

  it("formats state_change event with reason", () => {
    const lines = formatTimeline([stateChangeEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("state_change"));
    assert.ok(lines[0]!.includes("ready → in_progress"));
    assert.ok(lines[0]!.includes("(auto-selected)"));
  });

  it("formats state_change event without reason", () => {
    const lines = formatTimeline([stateChangeNoReasonEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("in_progress → done"));
    assert.ok(!lines[0]!.includes("("));
  });

  it("formats decision event with details", () => {
    const lines = formatTimeline([decisionEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("decision"));
    assert.ok(lines[0]!.includes("skip-plan"));
    assert.ok(lines[0]!.includes("(remediation plan exists)"));
  });

  it("formats decision event without details", () => {
    const lines = formatTimeline([decisionNoDetailsEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("confidence_met"));
    assert.ok(!lines[0]!.includes("("));
  });

  it("formats error event", () => {
    const lines = formatTimeline([errorEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("error"));
    assert.ok(lines[0]!.includes("[execute] timeout after 5m"));
  });

  it("formats hook_run event (passed)", () => {
    const lines = formatTimeline([hookRunEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("hook_run"));
    assert.ok(lines[0]!.includes("on_confidence_met ✓ $0.05"));
  });

  it("formats hook_run event (failed)", () => {
    const lines = formatTimeline([hookRunFailEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("on_confidence_met ✗ $0.03"));
  });

  it("formats budget_check event (ok)", () => {
    const lines = formatTimeline([budgetCheckEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("budget_check"));
    assert.ok(lines[0]!.includes("$42.5/$50 ok"));
  });

  it("formats budget_check event (exceeded)", () => {
    const lines = formatTimeline([budgetCheckExceededEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("$55/$50 EXCEEDED"));
  });

  it("formats rollback event with truncated SHAs", () => {
    const lines = formatTimeline([rollbackEntry]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("rollback"));
    assert.ok(lines[0]!.includes("abc1234..xyz9876"));
    assert.ok(lines[0]!.includes("Confidence regression"));
  });

  it("includes timestamp in HH:MM:SS format", () => {
    // 2025-06-15T14:30:45.123Z → local time HH:MM:SS
    const lines = formatTimeline([phaseStartEntry]);
    assert.equal(lines.length, 1);
    // The line should contain a time pattern [HH:MM:SS]
    assert.ok(/\[\d{2}:\d{2}:\d{2}\]/.test(lines[0]!));
  });

  it("includes taskId in output", () => {
    const lines = formatTimeline([phaseStartEntry]);
    assert.ok(lines[0]!.includes("task-1"));
  });
});

// ── logsCommand ─────────────────────────────────────────────────────────────

describe("logsCommand", () => {
  function makeCommandDeps(entries: LogEntry[]): ReadLogsDeps {
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    return makeDeps(content);
  }

  it("shows last 50 entries by default", async () => {
    // Create 60 entries
    const entries: LogEntry[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(makeEntry({
        taskId: `task-${i}`,
        type: "phase_start",
        data: { phase: "plan", attempt: 1 },
      }));
    }

    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({}, makeCommandDeps(entries));
    } finally {
      console.log = origLog;
    }

    // Should show 50 timeline lines + 1 "showing last 50 of 60" line
    const timelineLines = output.filter((l) => l.includes("phase_start"));
    assert.equal(timelineLines.length, 50);
    // First shown entry should be task-10 (entries 10-59 = last 50)
    assert.ok(timelineLines[0]!.includes("task-10"));
  });

  it("respects custom limit", async () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(makeEntry({
        taskId: `task-${i}`,
        type: "phase_start",
        data: { phase: "plan", attempt: 1 },
      }));
    }

    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({ limit: 5 }, makeCommandDeps(entries));
    } finally {
      console.log = origLog;
    }

    const timelineLines = output.filter((l) => l.includes("phase_start"));
    assert.equal(timelineLines.length, 5);
    // Should show last 5 (task-15 through task-19)
    assert.ok(timelineLines[0]!.includes("task-15"));
  });

  it("shows 'No matching events' for missing file", async () => {
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({}, makeEnoentDeps());
    } finally {
      console.log = origLog;
    }

    assert.ok(output.some((l) => l.includes("No matching events")));
  });

  it("shows 'No matching events' when filter matches nothing", async () => {
    const entries = [phaseStartEntry];
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({ taskId: "nonexistent" }, makeCommandDeps(entries));
    } finally {
      console.log = origLog;
    }

    assert.ok(output.some((l) => l.includes("No matching events")));
  });

  it("filters by task ID", async () => {
    const entries = [
      makeEntry({ taskId: "task-1", type: "phase_start", data: { phase: "plan", attempt: 1 } }),
      makeEntry({ taskId: "task-2", type: "error", data: { phase: "execute", message: "failed" } }),
      makeEntry({ taskId: "task-1", type: "phase_end", data: { phase: "plan", attempt: 1, costUsd: 0.1 } }),
    ];

    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({ taskId: "task-1" }, makeCommandDeps(entries));
    } finally {
      console.log = origLog;
    }

    const timelineLines = output.filter((l) => l.includes("task-"));
    assert.equal(timelineLines.length, 2);
    assert.ok(timelineLines.every((l) => l.includes("task-1")));
  });

  it("filters by event type", async () => {
    const entries = [
      makeEntry({ taskId: "task-1", type: "phase_start", data: { phase: "plan", attempt: 1 } }),
      makeEntry({ taskId: "task-2", type: "error", data: { phase: "execute", message: "failed" } }),
      makeEntry({ taskId: "task-3", type: "error", data: { phase: "review", message: "timeout" } }),
    ];

    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await logsCommand({ eventType: "error" }, makeCommandDeps(entries));
    } finally {
      console.log = origLog;
    }

    const timelineLines = output.filter((l) => l.includes("error"));
    assert.equal(timelineLines.length, 2);
  });
});
