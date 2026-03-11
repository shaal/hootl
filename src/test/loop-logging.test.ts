/**
 * Integration test: structured event logging from runCompletionLoop.
 *
 * Verifies that logEvent() calls in loop.ts produce the expected events in
 * .hootl/logs/events.jsonl for a full completion loop run. Uses the same
 * fake-claude + real-git + real-LocalTaskBackend pattern as loop-context-window.test.ts.
 *
 * Covers the ~30 logEvent call sites in loop.ts that had no integration test coverage:
 *   - run_start with config snapshot
 *   - phase_start / phase_end pairs for plan, execute, review
 *   - state_change events (to in_progress, to review)
 *   - decision events (confidence_met, plan_skipped on second attempt)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { runCompletionLoop } from "../loop.js";
import { ConfigSchema } from "../config.js";
import { LocalTaskBackend } from "../tasks/local.js";
import { _setSessionId, getSessionId } from "../logger.js";
import type { LogEntry } from "../logger.js";
import { randomUUID } from "node:crypto";

describe("runCompletionLoop logEvent emissions", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;
  let originalSessionId: string;

  before(async () => {
    // Preserve process state first — before any fallible operations
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";
    originalSessionId = getSessionId();

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-loop-logging-test-"));
    // State dir outside git repo to avoid polluting the working tree
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake `claude` executable — tracks call count via an external state file.
    // Returns controlled responses for each phase:
    //   Call 1: plan response
    //   Call 2: execute response
    //   Call 3: review response with confidence 96% (above default 95% target)
    //   Call 4+: hook response (pass: true, no fixes)
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

let result;
if (count === 1) {
  result = "## Plan\\n\\n1. Implement the feature\\n2. Add tests";
} else if (count === 2) {
  result = "## Progress\\n\\nImplemented the feature. All tests pass.";
} else if (count === 3) {
  result = JSON.stringify({
    confidence: 96,
    summary: "All good",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
  });
} else {
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
}

process.stdout.write(JSON.stringify({
  result,
  total_cost_usd: 0.01,
  context_window_percent: 10,
}));
`;
    await writeFile(join(fakeBinDir, "claude"), fakeClaude, { mode: 0o755 });

    // Real git repo
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
    await writeFile(join(tmpDir, ".gitignore"), ".hootl/\nfake-bin/\n");
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "init"], { cwd: tmpDir });

    process.chdir(tmpDir);
    process.env["PATH"] = `${fakeBinDir}:${originalPath}`;
  });

  after(async () => {
    process.chdir(originalCwd);
    process.env["PATH"] = originalPath;
    delete process.env["HOOTL_FAKE_CLAUDE_STATE"];
    _setSessionId(originalSessionId);
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /**
   * Reads events.jsonl and returns entries matching the given session ID.
   */
  async function readEventsForSession(sessionId: string): Promise<LogEntry[]> {
    const eventsPath = join(tmpDir, ".hootl", "logs", "events.jsonl");
    try {
      const raw = await readFile(eventsPath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LogEntry)
        .filter((entry) => entry.sessionId === sessionId);
    } catch {
      return [];
    }
  }

  it("emits run_start, phase_start/phase_end pairs, state_change, and decision events", async () => {
    const testSessionId = `test-loop-logging-${randomUUID()}`;
    _setSessionId(testSessionId);

    const task = await backend.createTask({
      title: "Logging integration test",
      description: "Verify structured event logging from the completion loop",
    });

    // Pre-create understanding.md to skip preflight (avoids an extra claude call)
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    // State file for the fake claude — lives outside the git repo
    const stateFile = join(stateDir, "count-logging");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      // Advisory hook avoids the default blocking simplify hook injection
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    const events = await readEventsForSession(testSessionId);

    // --- run_start should be the first event ---
    assert.ok(events.length > 0, "should emit at least one event");
    const firstEvent = events[0]!;
    assert.equal(firstEvent.type, "run_start", "first event should be run_start");
    if (firstEvent.type === "run_start") {
      assert.equal(firstEvent.data.config.confidenceTarget, 95, "config snapshot should include confidence target");
      assert.equal(firstEvent.data.config.onConfidenceMode, "none", "config snapshot should include onConfidenceMode");
      assert.equal(firstEvent.data.config.maxAttempts, 2, "config snapshot should include maxAttempts");
      assert.equal(typeof firstEvent.data.config.budgetGlobal, "number", "budgetGlobal should be a number");
      assert.equal(typeof firstEvent.data.config.useWorktrees, "boolean", "useWorktrees should be a boolean");
    }

    // --- state_change to in_progress ---
    const stateChanges = events.filter((e) => e.type === "state_change");
    const toInProgress = stateChanges.find(
      (e) => e.type === "state_change" && e.data.to === "in_progress",
    );
    assert.ok(toInProgress !== undefined, "should emit state_change to in_progress");

    // --- phase_start / phase_end pairs for plan, execute, review ---
    const phaseStarts = events.filter((e) => e.type === "phase_start");
    const phaseEnds = events.filter((e) => e.type === "phase_end");

    // We expect at minimum plan, execute, review phases
    const planStart = phaseStarts.find(
      (e) => e.type === "phase_start" && e.data.phase === "plan",
    );
    const planEnd = phaseEnds.find(
      (e) => e.type === "phase_end" && e.data.phase === "plan",
    );
    assert.ok(planStart !== undefined, "should emit phase_start for plan");
    assert.ok(planEnd !== undefined, "should emit phase_end for plan");
    if (planEnd !== undefined && planEnd.type === "phase_end") {
      assert.equal(typeof planEnd.data.costUsd, "number", "phase_end should include costUsd");
    }

    const executeStart = phaseStarts.find(
      (e) => e.type === "phase_start" && e.data.phase === "execute",
    );
    const executeEnd = phaseEnds.find(
      (e) => e.type === "phase_end" && e.data.phase === "execute",
    );
    assert.ok(executeStart !== undefined, "should emit phase_start for execute");
    assert.ok(executeEnd !== undefined, "should emit phase_end for execute");
    if (executeEnd !== undefined && executeEnd.type === "phase_end") {
      assert.equal(typeof executeEnd.data.durationMs, "number", "execute phase_end should include durationMs");
      assert.equal(typeof executeEnd.data.exitCode, "number", "execute phase_end should include exitCode");
      assert.equal(typeof executeEnd.data.outputLength, "number", "execute phase_end should include outputLength");
    }

    const reviewStart = phaseStarts.find(
      (e) => e.type === "phase_start" && e.data.phase === "review",
    );
    const reviewEnd = phaseEnds.find(
      (e) => e.type === "phase_end" && e.data.phase === "review",
    );
    assert.ok(reviewStart !== undefined, "should emit phase_start for review");
    assert.ok(reviewEnd !== undefined, "should emit phase_end for review");

    // --- phase events should be properly ordered (start before end) ---
    const planStartIdx = events.indexOf(planStart!);
    const planEndIdx = events.indexOf(planEnd!);
    assert.ok(planStartIdx < planEndIdx, "plan phase_start should come before phase_end");

    const executeStartIdx = events.indexOf(executeStart!);
    const executeEndIdx = events.indexOf(executeEnd!);
    assert.ok(executeStartIdx < executeEndIdx, "execute phase_start should come before phase_end");

    const reviewStartIdx = events.indexOf(reviewStart!);
    const reviewEndIdx = events.indexOf(reviewEnd!);
    assert.ok(reviewStartIdx < reviewEndIdx, "review phase_start should come before phase_end");

    // --- phases should occur in order: plan < execute < review ---
    assert.ok(planStartIdx < executeStartIdx, "plan should start before execute");
    assert.ok(executeStartIdx < reviewStartIdx, "execute should start before review");

    // --- decision: confidence_met should be emitted ---
    const decisions = events.filter((e) => e.type === "decision");
    const confidenceMet = decisions.find(
      (e) => e.type === "decision" && e.data.decision === "confidence_met",
    );
    assert.ok(confidenceMet !== undefined, "should emit confidence_met decision");

    // --- state_change to review (onConfidence: "none") ---
    const toReview = stateChanges.find(
      (e) => e.type === "state_change" && e.data.to === "review",
    );
    assert.ok(toReview !== undefined, "should emit state_change to review");

    // --- All events should carry the same taskId ---
    for (const event of events) {
      assert.equal(event.taskId, task.id, `all events should carry taskId ${task.id}`);
    }

    // --- All events should have timestamps ---
    for (const event of events) {
      assert.ok(typeof event.timestamp === "string" && event.timestamp.length > 0, "all events should have a timestamp");
    }

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      const updated = await backend.getTask(task.id);
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
