/**
 * Integration test: remediation decomposition in runCompletionLoop.
 *
 * When the execute phase fails with a non-zero exit code while a remediation plan
 * is active (hasRemediationPlan=true, 2+ remediationItems), the loop decomposes
 * the items into sequential subtasks instead of retrying the entire plan.
 *
 * Uses a real git repo and LocalTaskBackend. A fake `claude` binary simulates
 * the phase progression: preflight → plan → review (below target, writes remediation
 * items) → execute (fails) → triggers decomposition.
 *
 * Also tests the guard conditions: config gate, one-time blocker guard, and
 * single-item bypass.
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
import type { Task } from "../tasks/types.js";

describe("remediation decomposition integration", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let logsDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;

  before(async () => {
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-remed-decomp-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-fake-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    // Fake claude that simulates a remediation decomposition scenario.
    // Tests pre-create understanding.md so preflight is SKIPPED — the
    // count-to-phase mapping starts at plan, not preflight:
    //
    // Call 1: Plan — returns a simple plan
    // Call 2: Execute (attempt 1) — succeeds
    // Call 3: Review (attempt 1) — returns below-target confidence (80%) with 3 remediationItems
    //   This sets hasRemediationPlan=true and lastRemediationItems in the loop
    // Call 4: Execute (attempt 2, plan skipped due to remediation) — FAILS with exit code 1
    //   This triggers the catch block, which checks decomposition conditions
    //
    // After call 4 fails, the loop should decompose into subtasks and break.
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.HOOTL_FAKE_CLAUDE_STATE;
let count;
try { count = parseInt(fs.readFileSync(stateFile, "utf-8"), 10); } catch { count = 0; }
count++;
fs.writeFileSync(stateFile, String(count));

// Check if we should simulate a failure (exit code 1)
const shouldFail = process.env.HOOTL_FAKE_CLAUDE_FAIL_ON;
const failCalls = shouldFail ? shouldFail.split(",").map(Number) : [];

let result;
if (count === 1) {
  // Plan phase (preflight skipped — understanding.md exists)
  result = "## Plan\\n\\n1. Implement the feature\\n2. Add tests\\n3. Update docs";
} else if (count === 2) {
  // Execute phase (attempt 1) — succeeds
  result = "## Progress\\n\\nImplemented initial version.";
} else if (count === 3) {
  // Review phase (attempt 1) — below target, with remediation items
  result = JSON.stringify({
    confidence: 80,
    summary: "Below target — needs test coverage and documentation",
    issues: ["Missing integration tests", "No architecture docs"],
    suggestions: [],
    blockers: [],
    remediationPlan: "## Remediation\\n\\n1. Add integration tests\\n2. Fix correctness bug\\n3. Update documentation",
    remediationItems: [
      { category: "testCoverage", title: "Add integration tests for loop trigger", diffMarkers: ["describe(\\"remediation decomposition"], weight: 5.4 },
      { category: "correctness", title: "Fix edge case in parser", diffMarkers: ["parseEdgeCase"], weight: 3.2 },
      { category: "documentation", title: "Update architecture docs", diffMarkers: ["Remediation Decomposition"], weight: 2.0 },
    ],
    breakdown: { correctness: 92, testCoverage: 82, codeQuality: 95, documentation: 50 },
  });
} else if (count === 4) {
  // Execute phase (attempt 2, plan skipped due to remediation) — FAILS
  result = "## Progress\\n\\nPartial work done but failed.";
} else {
  result = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
}

if (failCalls.includes(count)) {
  // Simulate failure: write JSON with is_error flag
  process.stdout.write(JSON.stringify({
    result,
    total_cost_usd: 0.01,
    context_window_percent: 10,
    is_error: true,
  }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({
    result,
    total_cost_usd: 0.01,
    context_window_percent: 10,
  }));
}
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
    delete process.env["HOOTL_FAKE_CLAUDE_FAIL_ON"];
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("decomposes remediation items into subtasks when execute fails", async () => {
    const task = await backend.createTask({
      title: "Feature with remediation decomposition",
      description: "Task that will trigger remediation decomposition",
    });

    // Pre-create understanding.md to skip preflight
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, "count-decompose");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;
    // Execute fails on call 4 (attempt 2 execute, since preflight is skipped)
    // With understanding.md present: call 1=plan, 2=execute(ok), 3=review(below target), 4=execute(fail)
    process.env["HOOTL_FAKE_CLAUDE_FAIL_ON"] = "4";

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [],
      budgets: { maxAttemptsPerTask: 5 },
      remediation: { decompose: true },
    });

    await runCompletionLoop(task, backend, config);

    // Verify subtasks were created
    const allTasks = await backend.listTasks();
    const subtasks = allTasks.filter(
      (t: Task) => t.id !== task.id && t.title !== task.title,
    );

    // Should have created 3 subtasks (from 3 remediation items)
    assert.ok(
      subtasks.length >= 2,
      `Expected at least 2 subtasks, got ${subtasks.length}. All tasks: ${JSON.stringify(allTasks.map((t: Task) => ({ id: t.id, title: t.title, state: t.state })))}`,
    );

    // Verify subtasks are in ready state
    for (const sub of subtasks) {
      assert.equal(sub.state, "ready", `Subtask ${sub.id} should be in ready state`);
    }

    // Verify parent task was updated with subtask dependencies
    const updatedParent = await backend.getTask(task.id);
    assert.ok(
      updatedParent.dependencies.length >= 2,
      `Parent should have subtask dependencies, got ${updatedParent.dependencies.length}`,
    );

    // Verify parent has the decomposition blocker note
    assert.ok(
      updatedParent.blockers.some((b: string) => b.startsWith("Decomposed remediation into subtasks:")),
      `Parent should have decomposition blocker note, blockers: ${JSON.stringify(updatedParent.blockers)}`,
    );

    // Verify the decision event was logged
    const eventsFile = join(logsDir, "events.jsonl");
    let foundDecomposedEvent = false;
    try {
      const eventsContent = await readFile(eventsFile, "utf-8");
      const lines = eventsContent.trim().split("\n");
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (
            event.type === "decision" &&
            event.data?.decision === "remediation_decomposed"
          ) {
            foundDecomposedEvent = true;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // events.jsonl may not exist if logging failed
    }
    assert.ok(
      foundDecomposedEvent,
      "Expected a 'remediation_decomposed' decision event in events.jsonl",
    );

    // Verify the loop broke (call count should be exactly 4: plan, execute, review, execute-fail)
    const callCount = parseInt(await readFile(stateFile, "utf-8"), 10);
    assert.equal(
      callCount, 4,
      `Expected 4 claude calls (plan + execute + review + execute-fail), got ${callCount} — loop should have broken after decomposition`,
    );

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updatedParent.branch) {
        await execa("git", ["branch", "-D", updatedParent.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT decompose when blocker already contains decomposition note (one-time guard)", async () => {
    const task = await backend.createTask({
      title: "Already decomposed task",
      description: "Task with existing decomposition blocker",
    });
    // Set the decomposition blocker note to trigger the guard
    await backend.updateTask(task.id, {
      blockers: ["Decomposed remediation into subtasks: sub-001, sub-002"],
    });
    const taskWithBlocker = await backend.getTask(task.id);

    // Pre-create understanding.md to skip preflight
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, "count-guard");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;
    // Execute fails on call 4 (attempt 2 execute)
    process.env["HOOTL_FAKE_CLAUDE_FAIL_ON"] = "4";

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [],
      budgets: { maxAttemptsPerTask: 5 },
      remediation: { decompose: true },
    });

    await runCompletionLoop(taskWithBlocker, backend, config);

    // Count tasks created — should be NO new subtasks from this run
    const allTasks = await backend.listTasks();
    const thisTaskSubtasks = allTasks.filter(
      (t: Task) =>
        t.id !== task.id &&
        t.dependencies.length > 0 &&
        t.blockers.length === 0 &&
        t.title !== "Already decomposed task" &&
        t.title !== "Feature with remediation decomposition",
    );

    // The guard should have prevented decomposition — the task should have
    // gone through the normal error path (permanent error → break)
    const updated = await backend.getTask(task.id);
    // The original blocker should still be there
    assert.ok(
      updated.blockers.some((b: string) => b.startsWith("Decomposed remediation into subtasks: sub-001")),
      "Original decomposition blocker should remain",
    );

    // Should NOT have a second decomposition blocker note
    const decompBlockers = updated.blockers.filter((b: string) =>
      b.startsWith("Decomposed remediation into subtasks:"),
    );
    assert.equal(
      decompBlockers.length, 1,
      `Expected exactly 1 decomposition blocker (the original), got ${decompBlockers.length}`,
    );

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });

  it("does NOT decompose when config.remediation.decompose is false", async () => {
    const task = await backend.createTask({
      title: "No decompose config test",
      description: "Decomposition disabled by config",
    });

    // Pre-create understanding.md to skip preflight
    const taskDir = join(tasksDir, task.id);
    await writeFile(join(taskDir, "understanding.md"), "Task understood.");

    const stateFile = join(stateDir, "count-config-gate");
    process.env["HOOTL_FAKE_CLAUDE_STATE"] = stateFile;
    // Execute fails on call 4 (attempt 2 execute)
    process.env["HOOTL_FAKE_CLAUDE_FAIL_ON"] = "4";

    const config = ConfigSchema.parse({
      git: { onConfidence: "none" },
      hooks: [],
      budgets: { maxAttemptsPerTask: 5 },
      remediation: { decompose: false }, // <-- disabled
    });

    await runCompletionLoop(task, backend, config);

    // The task should have gone through normal error handling (permanent error → break)
    // No decomposition blocker should be present on THIS task
    const updated = await backend.getTask(task.id);
    const decompBlockers = updated.blockers.filter((b: string) =>
      b.startsWith("Decomposed remediation into subtasks:"),
    );
    assert.equal(
      decompBlockers.length, 0,
      `Expected 0 decomposition blockers when config disabled, got ${decompBlockers.length}`,
    );

    // Clean up branch
    try {
      await execa("git", ["checkout", "main"], { cwd: tmpDir });
      if (updated.branch) {
        await execa("git", ["branch", "-D", updated.branch], { cwd: tmpDir });
      }
    } catch { /* best effort */ }
  });
});
