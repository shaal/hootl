import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReviewResult, isSessionBudgetExceeded, applySessionBudgetExceeded, buildPlanPrompt } from "../loop.js";
import type { TaskBackend } from "../tasks/types.js";
import type { Task } from "../tasks/types.js";

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
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 0,
    totalCost: 0,
    branch: null,
    worktree: null,
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
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 1,
    totalCost: 0.10,
    branch: null,
    worktree: null,
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
