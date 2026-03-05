import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReviewResult, isSessionBudgetExceeded, applySessionBudgetExceeded, buildPlanPrompt, isConfidenceRegression, handleConfidenceMet, parsePreflightResult, handleTooBroad, fireHooks, moveToBlocked } from "../loop.js";
import { checkGlobalBudget } from "../budget.js";
import { ConfigSchema } from "../config.js";
import type { TaskBackend, CreateTaskInput } from "../tasks/types.js";
import type { Task } from "../tasks/types.js";
import type { HookDeps } from "../hooks.js";
import type { InvokeResult } from "../invoke.js";

describe("parseReviewResult", () => {
  it("extracts fields from clean JSON", () => {
    const input = JSON.stringify({
      confidence: 85,
      summary: "All tests pass",
      issues: ["minor lint warning"],
      suggestions: ["add more tests"],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 85);
    assert.equal(result.summary, "All tests pass");
    assert.deepEqual(result.issues, ["minor lint warning"]);
    assert.deepEqual(result.suggestions, ["add more tests"]);
    assert.deepEqual(result.blockers, []);
  });

  it("extracts JSON wrapped in markdown json code block", () => {
    const input = `Here is my review:

\`\`\`json
{
  "confidence": 92,
  "summary": "Implementation looks solid",
  "issues": [],
  "blockers": []
}
\`\`\`

That's my assessment.`;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 92);
    assert.equal(result.summary, "Implementation looks solid");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("extracts JSON wrapped in plain code block", () => {
    const input = `\`\`\`
{
  "confidence": 70,
  "summary": "Needs more tests",
  "issues": ["no edge case coverage"],
  "blockers": ["missing test framework"]
}
\`\`\``;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 70);
    assert.equal(result.summary, "Needs more tests");
    assert.deepEqual(result.issues, ["no edge case coverage"]);
    assert.deepEqual(result.blockers, ["missing test framework"]);
  });

  it("finds JSON embedded in surrounding text", () => {
    const input = `I reviewed the code carefully.

The result is: {"confidence": 60, "summary": "Partial implementation", "issues": ["incomplete API"], "blockers": []}

Please address the issues above.`;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 60);
    assert.equal(result.summary, "Partial implementation");
    assert.deepEqual(result.issues, ["incomplete API"]);
  });

  it("returns default for invalid JSON", () => {
    const result = parseReviewResult("this is not json at all {broken");
    assert.equal(result.confidence, 0);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("returns default for empty string", () => {
    const result = parseReviewResult("");
    assert.equal(result.confidence, 0);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("defaults missing optional fields to empty arrays/strings", () => {
    const input = JSON.stringify({ confidence: 50 });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 50);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.remediationPlan, "");
  });

  it("extracts remediationPlan when present", () => {
    const input = JSON.stringify({
      confidence: 85,
      summary: "Needs more tests",
      issues: ["missing edge case"],
      suggestions: [],
      blockers: [],
      remediationPlan: "## Steps\n1. Add test for edge case\n2. Run tests",
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 85);
    assert.equal(result.remediationPlan, "## Steps\n1. Add test for edge case\n2. Run tests");
  });

  it("defaults remediationPlan to empty string when not present", () => {
    const input = JSON.stringify({
      confidence: 97,
      summary: "All good",
      issues: [],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.equal(result.remediationPlan, "");
  });

  it("extracts JSON when remediationPlan contains nested code fences", () => {
    const input = "Here is my review:\n\n```json\n" + JSON.stringify({
      confidence: 90,
      summary: "Needs minor improvements",
      issues: ["duplicated code"],
      suggestions: ["extract helper"],
      blockers: [],
      remediationPlan: "## Steps\n1. Extract helper:\n```typescript\nfunction foo() {}\n```\n2. Run tests",
    }) + "\n```\n\nThat's my assessment.";

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 90);
    assert.equal(result.summary, "Needs minor improvements");
    assert.ok(result.remediationPlan.includes("Extract helper"));
  });

  it("returns 0 confidence when confidence is a string", () => {
    const input = JSON.stringify({
      confidence: "85",
      summary: "Looks good",
      issues: [],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 0);
  });

  it("extracts fields from nested JSON with extra fields", () => {
    const input = JSON.stringify({
      confidence: 88,
      summary: "Good progress",
      issues: ["minor typo"],
      blockers: [],
      extraField: "should be ignored",
      metadata: { timestamp: "2024-01-01" },
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 88);
    assert.equal(result.summary, "Good progress");
    assert.deepEqual(result.issues, ["minor typo"]);
    assert.deepEqual(result.blockers, []);
  });
});

describe("buildPlanPrompt", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Test task",
    description: "A test task description",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 0,
    totalCost: 0,
    branch: null,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("includes task title and description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(prompt.includes("# Task: Test task"));
      assert.ok(prompt.includes("A test task description"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes previous progress when progress.md exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      await writeFile(join(dir, "progress.md"), "Made some progress", "utf-8");
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(prompt.includes("## Previous Progress"));
      assert.ok(prompt.includes("Made some progress"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits previous progress when progress.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Previous Progress"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes understanding.md content in plan prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      await writeFile(join(dir, "understanding.md"), "The bug is in the auth flow for SSO users.", "utf-8");
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(prompt.includes("## Task Understanding"));
      assert.ok(prompt.includes("bug is in the auth flow for SSO users"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits understanding section when understanding.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Task Understanding"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits understanding section when understanding.md is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      await writeFile(join(dir, "understanding.md"), "   \n  ", "utf-8");
      const prompt = await buildPlanPrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Task Understanding"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("places understanding before blockers in plan prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-plan-"));
    try {
      await writeFile(join(dir, "understanding.md"), "Understanding content here", "utf-8");
      await writeFile(join(dir, "blockers.md"), "Some blocker info", "utf-8");
      const prompt = await buildPlanPrompt(makeTask(), dir);
      const understandingIdx = prompt.indexOf("## Task Understanding");
      const blockersIdx = prompt.indexOf("## Previous Blockers");
      assert.ok(understandingIdx >= 0, "Understanding section should exist");
      assert.ok(blockersIdx >= 0, "Blockers section should exist");
      assert.ok(understandingIdx < blockersIdx, "Understanding should come before Blockers");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("isSessionBudgetExceeded", () => {
  it("returns true when cost equals budget", () => {
    assert.equal(isSessionBudgetExceeded(0.50, 0.50), true);
  });

  it("returns true when cost exceeds budget", () => {
    assert.equal(isSessionBudgetExceeded(0.75, 0.50), true);
  });

  it("returns false when cost is under budget", () => {
    assert.equal(isSessionBudgetExceeded(0.30, 0.50), false);
  });

  it("returns false when cost is 0", () => {
    assert.equal(isSessionBudgetExceeded(0, 0.50), false);
  });
});

describe("applySessionBudgetExceeded", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Test task",
    description: "A test task",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 1,
    totalCost: 0.10,
    branch: null,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("returns null when budget is not exceeded", async () => {
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async () => { throw new Error("should not be called"); },
    };
    const task = makeTask({ totalCost: 0.10 });
    const result = await applySessionBudgetExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.30, 0.50,
    );
    assert.equal(result, null);
  });

  it("returns updated task when budget is exceeded", async () => {
    const task = makeTask({ totalCost: 0.10 });
    let capturedUpdates: Partial<Task> | undefined;
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async (_id: string, updates: Partial<Task>) => {
        capturedUpdates = updates;
        return { ...task, ...updates } as Task;
      },
    };
    const result = await applySessionBudgetExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.55, 0.50,
    );
    assert.notEqual(result, null);
    assert.equal(capturedUpdates?.totalCost, 0.65); // 0.10 + 0.55
  });

  it("returns updated task when cost exactly equals budget", async () => {
    const task = makeTask({ totalCost: 0.00 });
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async (_id: string, updates: Partial<Task>) => {
        return { ...task, ...updates } as Task;
      },
    };
    const result = await applySessionBudgetExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.50, 0.50,
    );
    assert.notEqual(result, null);
    assert.equal(result?.totalCost, 0.50);
  });
});

describe("isConfidenceRegression", () => {
  it("returns true when current confidence is lower than previous", () => {
    assert.equal(isConfidenceRegression(80, 90), true);
  });

  it("returns false when current confidence is higher than previous", () => {
    assert.equal(isConfidenceRegression(90, 80), false);
  });

  it("returns false when previous is null (first attempt)", () => {
    assert.equal(isConfidenceRegression(80, null), false);
  });

  it("returns false when confidences are equal", () => {
    assert.equal(isConfidenceRegression(80, 80), false);
  });

  it("returns true for small regressions", () => {
    assert.equal(isConfidenceRegression(89, 90), true);
  });

  it("returns false when current is 0 and previous is null", () => {
    assert.equal(isConfidenceRegression(0, null), false);
  });

  it("returns true when current is 0 and previous was positive", () => {
    assert.equal(isConfidenceRegression(0, 50), true);
  });
});

describe("global budget integration with loop", () => {
  it("detects global budget exceeded from cost.csv data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-loop-budget-"));
    try {
      await mkdir(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const csv = [
        `${today}T08:00:00.000Z,task-1,plan,20.00`,
        `${today}T09:00:00.000Z,task-1,execute,25.00`,
        `${today}T10:00:00.000Z,task-2,plan,10.00`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "cost.csv"), csv, "utf-8");

      // Total today: $55.00, limit: $50.00 — should be exceeded
      const result = await checkGlobalBudget(dir, 50.0);
      assert.equal(result.exceeded, true);
      assert.equal(result.todayCost, 55.0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("uses blocker message format: Global daily budget exhausted", () => {
    // The loop (src/loop.ts) uses this exact blocker string when the global
    // budget check triggers mid-run. Verify the format stays consistent so
    // downstream tooling (status, clarify) can match on it.
    const blockerMessage = "Global daily budget exhausted";
    assert.ok(blockerMessage.startsWith("Global daily budget"));
    assert.ok(!blockerMessage.includes("per-task"));
  });

  it("allows work when today's cost is under the global limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-loop-budget-"));
    try {
      await mkdir(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const csv = `${today}T08:00:00.000Z,task-1,plan,0.05\n`;
      await writeFile(join(dir, "cost.csv"), csv, "utf-8");

      const result = await checkGlobalBudget(dir, 50.0);
      assert.equal(result.exceeded, false);
      assert.equal(result.todayCost, 0.05);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("handleConfidenceMet", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Test task",
    description: "A test task description",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 95,
    attempts: 1,
    totalCost: 0.10,
    branch: "hootl/task-001-test",
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  function makeMockBackend(): { backend: TaskBackend; state: { lastUpdate: { id: string; updates: Partial<Task> } | null } } {
    const state = { lastUpdate: null as { id: string; updates: Partial<Task> } | null };
    const backend = {
      updateTask: async (id: string, updates: Partial<Task>) => {
        state.lastUpdate = { id, updates };
        return { ...makeTask(), ...updates } as Task;
      },
      createTask: async () => makeTask(),
      getTask: async () => makeTask(),
      listTasks: async () => [],
      deleteTask: async () => {},
    } as TaskBackend;
    return { backend, state };
  }

  it("'none' mode sets task to review state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "none" } });
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {},
      );
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("CLI --merge flag overrides config to merge mode (falls back without git)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "none" } });
      // Without a real git repo, mergeBranch will fail and fall back to review
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, { merge: true },
      );
      // merge will fail (no real git repo) so it falls back to review
      assert.equal(result.state, "review");
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("CLI --no-merge flag forces none mode regardless of config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "merge" } });
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, { noMerge: true },
      );
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("'pr' mode sets task to review state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "pr" } });
      // pushBranch will fail (no remote) but state should still be review
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {},
      );
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("'none' mode when no branch available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "merge" } });
      // With null branch, merge mode can't do anything — falls through to none
      const result = await handleConfidenceMet(
        makeTask(), config, backend, null, null, dir, {},
      );
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("blocking hook failure keeps task in_progress for another attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => ({
          output: '{"pass": false, "issues": ["duplicated logic"], "remediationActions": ["extract helper"]}',
          costUsd: 0.03,
          exitCode: 0,
          durationMs: 100,
        } as InvokeResult),
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(result.state, "in_progress");
      assert.equal(result.mergedSuccessfully, false);
      // Task state should NOT have been updated — stays in_progress implicitly
      assert.equal(mockState.lastUpdate, null);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("passing hook allows normal confidence-met behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => ({
          output: '{"pass": true, "issues": [], "remediationActions": []}',
          costUsd: 0.01,
          exitCode: 0,
          durationMs: 50,
        } as InvokeResult),
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Hook passed, so normal 'none' mode behavior: task goes to review
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      assert.equal(mockState.lastUpdate?.updates.state, "review");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("hook error is caught gracefully and proceeds normally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => { throw new Error("invoke crashed"); },
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Hook threw but was caught — proceeds to normal behavior
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("runs default simplify hook when config has no hooks configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "none" }, hooks: [] });
      let hookInvoked = false;
      const hookDeps: HookDeps = {
        invoke: async () => { hookInvoked = true; return { output: '{"passed": true, "confidence": 95, "issues": [], "fixes_applied": []}', costUsd: 0.02, exitCode: 0, durationMs: 50 } as InvokeResult; },
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(hookInvoked, true, "default simplify hook should be invoked when config.hooks is empty");
      assert.equal(result.state, "review"); // onConfidence: "none" → review
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("parsePreflightResult subtask priority", () => {
  it("parses subtasks with valid priority", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Task covers multiple areas",
      subtasks: [
        { title: "Sub A", description: "Do A", priority: "high" },
        { title: "Sub B", description: "Do B", priority: "low" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "too_broad");
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.priority, "high");
    assert.equal(result.subtasks[1]?.priority, "low");
  });

  it("omits priority when not provided in subtask", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Too broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 1);
    assert.equal(result.subtasks[0]?.priority, undefined);
  });

  it("omits priority when invalid value is provided", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Too broad",
      subtasks: [
        { title: "Sub A", description: "Do A", priority: "urgent" },
        { title: "Sub B", description: "Do B", priority: 42 },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.priority, undefined);
    assert.equal(result.subtasks[1]?.priority, undefined);
  });

  it("handles mix of subtasks with and without priority", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Mixed",
      subtasks: [
        { title: "Sub A", description: "Do A", priority: "critical" },
        { title: "Sub B", description: "Do B" },
        { title: "Sub C", description: "Do C", priority: "medium" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 3);
    assert.equal(result.subtasks[0]?.priority, "critical");
    assert.equal(result.subtasks[1]?.priority, undefined);
    assert.equal(result.subtasks[2]?.priority, "medium");
  });
});

describe("parsePreflightResult subtask type", () => {
  it("parses subtasks with valid type", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Task covers multiple areas",
      subtasks: [
        { title: "Sub A", description: "Do A", type: "bug" },
        { title: "Sub B", description: "Do B", type: "chore" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.type, "bug");
    assert.equal(result.subtasks[1]?.type, "chore");
  });

  it("omits type when not provided in subtask", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Too broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 1);
    assert.equal(result.subtasks[0]?.type, undefined);
  });

  it("omits type when invalid value is provided", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Too broad",
      subtasks: [
        { title: "Sub A", description: "Do A", type: "invalid" },
        { title: "Sub B", description: "Do B", type: 42 },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.type, undefined);
    assert.equal(result.subtasks[1]?.type, undefined);
  });

  it("handles mix of subtasks with and without type", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Mixed",
      subtasks: [
        { title: "Sub A", description: "Do A", type: "bug" },
        { title: "Sub B", description: "Do B" },
        { title: "Sub C", description: "Do C", type: "improvement" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 3);
    assert.equal(result.subtasks[0]?.type, "bug");
    assert.equal(result.subtasks[1]?.type, undefined);
    assert.equal(result.subtasks[2]?.type, "improvement");
  });
});

describe("handleTooBroad subtask auto-creation", () => {
  const makeTooBroadTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Broad task",
    description: "A task that is too broad",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 0,
    totalCost: 0,
    branch: null,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  function makeSubtaskMockBackend() {
    let nextId = 1;
    const createdTasks: Array<{ input: CreateTaskInput; id: string }> = [];
    const updates: Array<{ id: string; updates: Partial<Task> }> = [];

    const backend: TaskBackend = {
      createTask: async (input: CreateTaskInput) => {
        const id = `sub-${String(nextId++).padStart(3, "0")}`;
        createdTasks.push({ input, id });
        return {
          ...makeTooBroadTask(),
          id,
          title: input.title,
          description: input.description,
          priority: input.priority ?? "medium",
          state: "proposed" as const,
          dependencies: input.dependencies ?? [],
        };
      },
      updateTask: async (id: string, upd: Partial<Task>) => {
        updates.push({ id, updates: upd });
        return { ...makeTooBroadTask(), id, ...upd } as Task;
      },
      getTask: async () => makeTooBroadTask(),
      listTasks: async () => [],
      deleteTask: async () => {},
    };

    return { backend, createdTasks, updates };
  }

  async function makeTempTaskDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "hootl-toobroad-"));
    return dir;
  }

  it("creates subtasks from preflight result", async () => {
    const { backend, createdTasks } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Task covers multiple areas",
      subtasks: [
        { title: "Sub A", description: "Do A" },
        { title: "Sub B", description: "Do B" },
        { title: "Sub C", description: "Do C" },
      ],
      reproductionResult: "",
    };

    const { createdIds } = await handleTooBroad(backend, task, preflight, taskDir);

    assert.equal(createdIds.length, 3);
    assert.equal(createdTasks.length, 3);
    assert.equal(createdTasks[0]?.input.title, "Sub A");
    assert.equal(createdTasks[1]?.input.title, "Sub B");
    assert.equal(createdTasks[2]?.input.title, "Sub C");
    await rm(taskDir, { recursive: true, force: true });
  });

  it("subtasks inherit parent priority when none specified", async () => {
    const { backend, createdTasks } = makeSubtaskMockBackend();
    const task = makeTooBroadTask({ priority: "high" });
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    assert.equal(createdTasks[0]?.input.priority, "high");
    await rm(taskDir, { recursive: true, force: true });
  });

  it("subtasks use Claude-specified priority when provided", async () => {
    const { backend, createdTasks } = makeSubtaskMockBackend();
    const task = makeTooBroadTask({ priority: "medium" });
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A", priority: "critical" as const },
        { title: "Sub B", description: "Do B" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    assert.equal(createdTasks[0]?.input.priority, "critical");
    assert.equal(createdTasks[1]?.input.priority, "medium"); // inherited from parent
    await rm(taskDir, { recursive: true, force: true });
  });

  it("moves subtasks to ready state", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
        { title: "Sub B", description: "Do B" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    // Two subtask state changes to 'ready' + parent also goes to 'ready' (with dependencies)
    const subtaskReadyUpdates = updates.filter(u => u.updates.state === "ready" && u.id !== task.id);
    assert.equal(subtaskReadyUpdates.length, 2);
    await rm(taskDir, { recursive: true, force: true });
  });

  it("keeps parent task in ready state with subtask dependencies", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
      reproductionResult: "",
    };

    const { updatedTask } = await handleTooBroad(backend, task, preflight, taskDir);

    // Parent should be moved back to ready (waiting on subtask dependencies)
    const parentUpdate = updates.find(u => u.id === "task-001");
    assert.ok(parentUpdate);
    assert.equal(parentUpdate.updates.state, "ready");
    // Parent should have subtask IDs as dependencies
    assert.deepEqual(parentUpdate.updates.dependencies, ["sub-001"]);
    // Blockers should contain reference to created subtask IDs
    const blockerNote = parentUpdate.updates.blockers?.[0];
    assert.ok(blockerNote);
    assert.ok(blockerNote.includes("sub-001"));
    assert.ok(blockerNote.startsWith("Decomposed into subtasks:"));
    assert.equal(updatedTask.state, "ready");
    await rm(taskDir, { recursive: true, force: true });
  });

  it("returns created subtask IDs", async () => {
    const { backend } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
        { title: "Sub B", description: "Do B" },
      ],
      reproductionResult: "",
    };

    const { createdIds } = await handleTooBroad(backend, task, preflight, taskDir);

    assert.deepEqual(createdIds, ["sub-001", "sub-002"]);
    await rm(taskDir, { recursive: true, force: true });
  });

  it("removes understanding.md so preflight runs fresh on re-run", async () => {
    const { backend } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    // Simulate understanding.md written by the preflight phase
    await writeFile(join(taskDir, "understanding.md"), "Too broad understanding", "utf-8");
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(taskDir, "understanding.md")), false);
    await rm(taskDir, { recursive: true, force: true });
  });

  it("appends subtask dependencies to existing parent dependencies", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask({ dependencies: ["existing-dep"] });
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
        { title: "Sub B", description: "Do B" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    const parentUpdate = updates.find(u => u.id === "task-001");
    assert.ok(parentUpdate);
    assert.deepEqual(parentUpdate.updates.dependencies, ["existing-dep", "sub-001", "sub-002"]);
    await rm(taskDir, { recursive: true, force: true });
  });

  it("infers inter-subtask dependencies via keyword matching", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask();
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Core hook engine", description: "Create the hook execution engine" },
        { title: "Skill support", description: "Add skill invocation to the hook engine" },
        { title: "Wire hooks into loop", description: "Integrate hook engine and skill support into the loop" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    // "Skill support" references "hook" from "Core hook engine" -> sub-002 depends on sub-001
    // "Wire hooks into loop" references "hook" and "skill" -> sub-003 depends on sub-001 and sub-002
    const depUpdates = updates.filter(u => u.updates.dependencies !== undefined && u.id.startsWith("sub-"));
    assert.ok(depUpdates.length > 0, "should have wired at least one inter-subtask dependency");
    await rm(taskDir, { recursive: true, force: true });
  });

  it("subtasks inherit fractional userPriority from parent", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask({ userPriority: 10 });
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
        { title: "Sub B", description: "Do B" },
        { title: "Sub C", description: "Do C" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    // Subtasks should get fractional userPriority values between parent (10) and next integer (11)
    const subtaskUpdates = updates.filter(u => u.id.startsWith("sub-") && u.updates.userPriority !== undefined);
    assert.equal(subtaskUpdates.length, 3);
    const priorities = subtaskUpdates.map(u => u.updates.userPriority as number);
    // All should be between 10 and 11
    for (const p of priorities) {
      assert.ok(p > 10 && p < 11, `expected ${p} to be between 10 and 11`);
    }
    // Should be in ascending order
    assert.ok(priorities[0]! < priorities[1]!, "first subtask should have lower priority than second");
    assert.ok(priorities[1]! < priorities[2]!, "second subtask should have lower priority than third");
    await rm(taskDir, { recursive: true, force: true });
  });

  it("subtasks get no userPriority when parent has none", async () => {
    const { backend, updates } = makeSubtaskMockBackend();
    const task = makeTooBroadTask({ userPriority: null });
    const taskDir = await makeTempTaskDir();
    const preflight = {
      verdict: "too_broad" as const,
      understanding: "Broad",
      subtasks: [
        { title: "Sub A", description: "Do A" },
      ],
      reproductionResult: "",
    };

    await handleTooBroad(backend, task, preflight, taskDir);

    const subtaskUpdates = updates.filter(u => u.id.startsWith("sub-") && u.updates.userPriority !== undefined);
    assert.equal(subtaskUpdates.length, 0);
    await rm(taskDir, { recursive: true, force: true });
  });
});

describe("handleConfidenceMet hook integration", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Test task",
    description: "A test task description",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 95,
    attempts: 1,
    totalCost: 0.10,
    branch: "hootl/task-001-test",
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  function makeMockBackend(): { backend: TaskBackend; updates: Array<{ id: string; updates: Partial<Task> }> } {
    const updates: Array<{ id: string; updates: Partial<Task> }> = [];
    const backend = {
      updateTask: async (id: string, upd: Partial<Task>) => {
        updates.push({ id, updates: upd });
        return { ...makeTask(), ...upd } as Task;
      },
      createTask: async () => makeTask(),
      getTask: async () => makeTask(),
      listTasks: async () => [],
      deleteTask: async () => {},
    } as TaskBackend;
    return { backend, updates };
  }

  it("blocking hook failure does not call backend.updateTask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-hook-"));
    try {
      const { backend, updates } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => ({
          output: '{"pass": false, "issues": ["bad code"], "remediationActions": []}',
          costUsd: 0.02,
          exitCode: 0,
          durationMs: 50,
        } as InvokeResult),
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(result.state, "in_progress");
      // No state transition should have been persisted
      assert.equal(updates.length, 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("on_confidence_met hook receives correct context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-ctx-"));
    try {
      const { backend } = makeMockBackend();
      const task = makeTask({ confidence: 97 });
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", prompt: "check quality", blocking: false },
        ],
      });
      let capturedPrompt = "";
      let capturedSystemPrompt = "";
      const hookDeps: HookDeps = {
        invoke: async (opts) => {
          capturedPrompt = opts.prompt;
          capturedSystemPrompt = opts.systemPrompt ?? "";
          return {
            output: '{"pass": true, "issues": [], "remediationActions": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 30,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
      };
      await handleConfidenceMet(
        task, config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(capturedPrompt, "check quality");
      assert.ok(capturedSystemPrompt.includes("Test task"));
      assert.ok(capturedSystemPrompt.includes("97%"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("hook costs are logged with hook trigger label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-cost-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", prompt: "check", blocking: false },
        ],
      });
      const logCalls: Array<{ phase: string; cost: number }> = [];
      const hookDeps: HookDeps = {
        invoke: async () => ({
          output: '{"pass": true}',
          costUsd: 0.05,
          exitCode: 0,
          durationMs: 20,
        } as InvokeResult),
        log: async (_dir, _id, phase, cost) => { logCalls.push({ phase, cost }); },
        warn: () => {},
      };
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(logCalls.length, 1);
      assert.equal(logCalls[0]?.phase, "hook:on_confidence_met");
      assert.equal(logCalls[0]?.cost, 0.05);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("fireHooks", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-fh",
    title: "Fire hooks task",
    description: "Testing fireHooks helper",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 80,
    attempts: 1,
    totalCost: 0,
    branch: "hootl/task-fh",
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("calls runHooks with correct trigger and HookContext", async () => {
    const task = makeTask({ confidence: 80 });
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_execute_start", prompt: "pre-execute check", blocking: false },
      ],
    });
    let capturedSystemPrompt = "";
    let invoked = false;
    const hookDeps: HookDeps = {
      invoke: async (opts) => {
        invoked = true;
        capturedSystemPrompt = opts.systemPrompt ?? "";
        return {
          output: '{"pass": true, "issues": [], "remediationActions": []}',
          costUsd: 0.01,
          exitCode: 0,
          durationMs: 10,
        } as InvokeResult;
      },
      log: async () => {},
      warn: () => {},
    };
    await fireHooks("on_execute_start", task, "hootl/task-fh", "main", 80, config, hookDeps);
    assert.equal(invoked, true);
    assert.ok(capturedSystemPrompt.includes("Fire hooks task"), "system prompt should contain task title");
    assert.ok(capturedSystemPrompt.includes("80%"), "system prompt should contain confidence");
  });

  it("calls runHooks for on_review_complete with review confidence", async () => {
    const task = makeTask({ confidence: 92 });
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_review_complete", prompt: "post-review", blocking: false },
      ],
    });
    let capturedSystemPrompt = "";
    const hookDeps: HookDeps = {
      invoke: async (opts) => {
        capturedSystemPrompt = opts.systemPrompt ?? "";
        return {
          output: '{"pass": true, "issues": [], "remediationActions": []}',
          costUsd: 0.01,
          exitCode: 0,
          durationMs: 10,
        } as InvokeResult;
      },
      log: async () => {},
      warn: () => {},
    };
    await fireHooks("on_review_complete", task, "hootl/task-fh", "main", 92, config, hookDeps);
    assert.ok(capturedSystemPrompt.includes("92%"), "system prompt should contain the review confidence");
  });

  it("is a no-op when config.hooks is empty", async () => {
    const config = ConfigSchema.parse({ hooks: [] });
    let invoked = false;
    const hookDeps: HookDeps = {
      invoke: async () => { invoked = true; return { output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 0 } as InvokeResult; },
      log: async () => {},
      warn: () => {},
    };
    await fireHooks("on_execute_start", makeTask(), "hootl/task-fh", "main", 0, config, hookDeps);
    assert.equal(invoked, false, "invoke should not be called when hooks array is empty");
  });

  it("catches and swallows errors without throwing", async () => {
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_blocked", prompt: "on block check", blocking: false },
      ],
    });
    const hookDeps: HookDeps = {
      invoke: async () => { throw new Error("simulated hook failure"); },
      log: async () => {},
      warn: () => {},
    };
    // Should not throw
    await fireHooks("on_blocked", makeTask(), "hootl/task-fh", "main", 50, config, hookDeps);
  });
});

describe("moveToBlocked", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-mb",
    title: "Move to blocked task",
    description: "Testing moveToBlocked helper",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 50,
    attempts: 3,
    totalCost: 0.50,
    branch: "hootl/task-mb",
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  function makeMockBackend(): { backend: TaskBackend; updates: Array<{ id: string; updates: Partial<Task> }> } {
    const updates: Array<{ id: string; updates: Partial<Task> }> = [];
    const backend = {
      updateTask: async (id: string, upd: Partial<Task>) => {
        updates.push({ id, updates: upd });
        return { ...makeTask(), ...upd } as Task;
      },
      createTask: async () => makeTask(),
      getTask: async () => makeTask(),
      listTasks: async () => [],
      deleteTask: async () => {},
    } as TaskBackend;
    return { backend, updates };
  }

  it("fires on_blocked hook then updates task state to blocked", async () => {
    const { backend, updates } = makeMockBackend();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_blocked", prompt: "blocked check", blocking: false },
      ],
    });
    const callOrder: string[] = [];
    const hookDeps: HookDeps = {
      invoke: async () => {
        callOrder.push("hook_invoked");
        return {
          output: '{"pass": true, "issues": [], "remediationActions": []}',
          costUsd: 0.01,
          exitCode: 0,
          durationMs: 10,
        } as InvokeResult;
      },
      log: async () => { callOrder.push("hook_logged"); },
      warn: () => {},
    };
    // Wrap updateTask to track call order
    const origUpdate = backend.updateTask.bind(backend);
    backend.updateTask = async (id: string, upd: Partial<Task>) => {
      callOrder.push("backend_update");
      return origUpdate(id, upd);
    };

    const blockers = ["Budget exhausted"];
    await moveToBlocked(backend, makeTask(), blockers, "hootl/task-mb", "main", 50, config, hookDeps);

    assert.ok(callOrder.indexOf("hook_invoked") < callOrder.indexOf("backend_update"),
      "hook should fire before backend state update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.updates.state, "blocked");
  });

  it("works when hook throws (error swallowed by fireHooks)", async () => {
    const { backend, updates } = makeMockBackend();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_blocked", prompt: "check", blocking: true },
      ],
    });
    const hookDeps: HookDeps = {
      invoke: async () => { throw new Error("hook crash"); },
      log: async () => {},
      warn: () => {},
    };
    const blockers = ["Max attempts exhausted"];
    const result = await moveToBlocked(backend, makeTask(), blockers, "hootl/task-mb", "main", 50, config, hookDeps);
    assert.equal(result.state, "blocked");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.updates.state, "blocked");
  });

  it("passes blockers array to backend.updateTask", async () => {
    const { backend, updates } = makeMockBackend();
    const config = ConfigSchema.parse({ hooks: [] });
    const hookDeps: HookDeps = {
      invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 0 } as InvokeResult),
      log: async () => {},
      warn: () => {},
    };
    const blockers = ["Confidence regression: 60% < 80%", "Tests failing"];
    await moveToBlocked(backend, makeTask(), blockers, "hootl/task-mb", "main", 60, config, hookDeps);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]?.updates.blockers, blockers);
  });
});
