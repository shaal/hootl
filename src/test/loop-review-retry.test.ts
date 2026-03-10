/**
 * Integration test: review phase retry on empty output.
 *
 * Verifies the review retry loop in loop.ts:
 *   - Empty review output triggers retry with reduced maxTurns (20 → 10)
 *   - Successful retry on second attempt uses that output normally
 *   - All retries empty → proceeds with confidence 0 (graceful degradation)
 *   - Raw output saved for each retry attempt (review-retry1, review-retry2)
 *
 * Uses the same fake-claude + real-git + real-LocalTaskBackend pattern
 * as loop-logging.test.ts and loop-context-window.test.ts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { execa } from "execa";
import { runCompletionLoop, MAX_REVIEW_RETRIES } from "../loop.js";
import { ConfigSchema } from "../config.js";
import { LocalTaskBackend } from "../tasks/local.js";
import { _setSessionId, getSessionId } from "../logger.js";
import type { LogEntry } from "../logger.js";
import { randomUUID } from "node:crypto";

describe("review phase retry on empty output", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;
  let originalSessionId: string;

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";
    originalSessionId = getSessionId();

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-review-retry-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

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

  /**
   * Writes a fake claude binary that returns empty review output on the first
   * review call, then valid JSON on the retry. Also records --max-turns values
   * to a separate file so we can verify the retry uses reduced maxTurns.
   */
  async function writeFakeClaude(variant: "retry-success" | "all-empty"): Promise<void> {
    const fakeBinDir = join(tmpDir, "fake-bin");

    // For "retry-success": review (call 3) returns empty, review retry (call 4) returns valid JSON
    // For "all-empty": all review calls return empty (calls 3, 4, 5)
    //
    // Phase ordering (with understanding.md pre-created to skip preflight):
    //   Call 1: plan
    //   Call 2: execute
    //   Call 3: review (first attempt — returns empty)
    //   Call 4: review retry 1 (returns valid JSON for retry-success, empty for all-empty)
    //   Call 5: review retry 2 (only for all-empty — returns empty)
    // Note: hook is skipped for retry-success because fake execute creates no real diff

    const reviewJson = JSON.stringify({
      confidence: 96,
      summary: "All good after retry",
      issues: [],
      suggestions: [],
      blockers: [],
      remediationPlan: "",
    });

    const hookJson = JSON.stringify({ pass: true, issues: [], remediationActions: [] });

    let reviewRetryResult: string;
    if (variant === "retry-success") {
      reviewRetryResult = `result = ${JSON.stringify(reviewJson)};`;
    } else {
      reviewRetryResult = `result = "";`;
    }

    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

// Record --max-turns values for verification
const maxTurnsFile = stateFile + ".maxturns";
const maxTurnsIdx = process.argv.indexOf("--max-turns");
const maxTurnsVal = maxTurnsIdx >= 0 ? process.argv[maxTurnsIdx + 1] : "none";
let turnsLog;
try { turnsLog = fs.readFileSync(maxTurnsFile, "utf-8"); } catch { turnsLog = ""; }
turnsLog += count + ":" + maxTurnsVal + "\\n";
fs.writeFileSync(maxTurnsFile, turnsLog);

let result;
if (count === 1) {
  result = "## Plan\\n\\n1. Implement the feature\\n2. Add tests";
} else if (count === 2) {
  result = "## Progress\\n\\nImplemented the feature.";
} else if (count === 3) {
  // First review attempt — always returns empty
  result = "";
} else if (count === 4) {
  // Review retry 1
  ${reviewRetryResult}
} else if (count === 5) {
  // Review retry 2 (only reached for all-empty) or hook
  ${variant === "all-empty" ? 'result = "";' : `result = ${JSON.stringify(hookJson)};`}
} else {
  result = ${JSON.stringify(hookJson)};
}

process.stdout.write(JSON.stringify({
  result,
  total_cost_usd: 0.01,
  context_window_percent: 10,
}));
`;
    await writeFile(join(fakeBinDir, "claude"), fakeClaude, { mode: 0o755 });
  }

  it("retries review on empty output and succeeds on second attempt", async () => {
    const testSessionId = `test-review-retry-success-${randomUUID()}`;
    _setSessionId(testSessionId);

    await writeFakeClaude("retry-success");

    const task = await backend.createTask({
      title: "Review retry success test",
      description: "Verify review retry with successful second attempt",
    });

    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, `count-retry-success-${testSessionId}`);
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [{ trigger: "on_confidence_met" as const, prompt: "ok", blocking: false }],
      budgets: { maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    // Verify the task reached confidence_met — the retry succeeded
    const updated = await backend.getTask(task.id);
    assert.equal(updated.state, "review", "task should reach review state (confidence met)");
    assert.equal(updated.confidence, 96, "confidence should be 96 from the retry review");

    // Verify call count: plan(1) + execute(2) + empty review(3) + retry review(4) = 4
    // (hook is skipped because the fake execute doesn't create a real diff)
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.equal(callCount, 4, "should make 4 claude calls (plan + execute + empty review + retry review)");

    // Verify maxTurns was reduced on retry (call 3: 20, call 4: 10)
    const maxTurnsLog = await readFile(stateFile + ".maxturns", "utf-8");
    const turnsEntries = maxTurnsLog.trim().split("\n");
    const call3 = turnsEntries.find((e) => e.startsWith("3:"));
    const call4 = turnsEntries.find((e) => e.startsWith("4:"));
    assert.ok(call3 !== undefined, "should have maxTurns record for call 3");
    assert.ok(call4 !== undefined, "should have maxTurns record for call 4");
    assert.equal(call3, "3:20", "first review attempt should use maxTurns=20");
    assert.equal(call4, "4:10", "review retry should use maxTurns=10");

    // Verify raw output files exist — both review and review-retry1
    const rawLogsDir = join(taskDir, "logs");
    assert.ok(existsSync(join(rawLogsDir, "review-1.txt")), "should save raw output for initial review");
    assert.ok(existsSync(join(rawLogsDir, "review-retry1-1.txt")), "should save raw output for review retry");

    // Initial review should be empty, retry should have content
    const reviewRaw = await readFile(join(rawLogsDir, "review-1.txt"), "utf-8");
    assert.equal(reviewRaw, "", "initial review raw output should be empty");
    const retryRaw = await readFile(join(rawLogsDir, "review-retry1-1.txt"), "utf-8");
    assert.ok(retryRaw.includes("All good after retry"), "retry review raw output should contain the review JSON");

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("falls back to confidence 0 when all review retries return empty", async () => {
    const testSessionId = `test-review-all-empty-${randomUUID()}`;
    _setSessionId(testSessionId);

    await writeFakeClaude("all-empty");

    const task = await backend.createTask({
      title: "Review all-empty fallback test",
      description: "Verify graceful degradation when all review retries return empty",
    });

    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, `count-all-empty-${testSessionId}`);
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [],
      budgets: { maxAttemptsPerTask: 2 },
    });

    await runCompletionLoop(task, backend, config);

    // With confidence 0, the loop should continue to attempt 2 (since maxAttempts=2)
    // After attempt 2, it should stop. Task stays in_progress.
    const updated = await backend.getTask(task.id);
    assert.equal(updated.confidence, 0, "confidence should be 0 from empty review fallback");

    // Verify call count: at least plan(1) + execute(2) + 3 empty reviews(3,4,5) = 5 for attempt 1
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.ok(callCount >= 5, `should make at least 5 claude calls on first attempt, got ${callCount}`);

    // Verify the review_empty_fallback decision was logged
    const events = await readEventsForSession(testSessionId);
    const fallbackDecision = events.find(
      (e) => e.type === "decision" && e.data.decision === "review_empty_fallback",
    );
    assert.ok(fallbackDecision !== undefined, "should log review_empty_fallback decision");

    // Verify raw output files for all 3 review attempts
    const rawLogsDir = join(taskDir, "logs");
    assert.ok(existsSync(join(rawLogsDir, "review-1.txt")), "should save raw output for initial review");
    assert.ok(existsSync(join(rawLogsDir, "review-retry1-1.txt")), "should save raw output for review retry 1");
    assert.ok(existsSync(join(rawLogsDir, "review-retry2-1.txt")), "should save raw output for review retry 2");

    // Verify maxTurns reduction on retries
    const maxTurnsLog = await readFile(stateFile + ".maxturns", "utf-8");
    const turnsEntries = maxTurnsLog.trim().split("\n");
    const call4 = turnsEntries.find((e) => e.startsWith("4:"));
    const call5 = turnsEntries.find((e) => e.startsWith("5:"));
    assert.ok(call4 !== undefined, "should have maxTurns record for retry 1");
    assert.ok(call5 !== undefined, "should have maxTurns record for retry 2");
    assert.equal(call4, "4:10", "review retry 1 should use maxTurns=10");
    assert.equal(call5, "5:10", "review retry 2 should use maxTurns=10");

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
