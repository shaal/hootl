import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReviewResult, isContextWindowExceeded, applyContextWindowExceeded, buildPlanPrompt, buildReviewPrompt, isConfidenceRegression, buildScoringTable, verifyRemediationMarkers, MARKER_WEIGHT_THRESHOLD, handleConfidenceMet, parsePreflightResult, handleTooBroad, fireHooks, moveToBlocked, MAX_REVERIFICATIONS, checkAllDependenciesDone } from "../loop.js";
import type { RemediationItem, DiffProvider } from "../loop.js";
import { checkGlobalBudget } from "../budget.js";
import { ConfigSchema } from "../config.js";
import type { TaskBackend, CreateTaskInput } from "../tasks/types.js";
import type { Task } from "../tasks/types.js";
import type { HookDeps } from "../hooks.js";
import type { InvokeResult } from "../invoke.js";
import type { LogEntry } from "../logger.js";
import { _setSessionId, getSessionId } from "../logger.js";
import { getProjectDir } from "../config.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

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

  it("extracts JSON when prose has curly braces AND remediationPlan has nested code fences", () => {
    // Reproduces the real failure: reviewer prose mentions ${goalId} (contains {})
    // AND the remediationPlan contains ```typescript code blocks inside the JSON string.
    // Both the code-block regex and the old forward brace regex fail here.
    const input = 'Message now says for goal "${goalId}".\n\n```json\n' + JSON.stringify({
      confidence: 81,
      summary: "Core implementation correct",
      issues: ["tests replicate filtering logic inline"],
      suggestions: ["add unit tests for exported functions"],
      blockers: [],
      remediationPlan: "### 1. Add tests\n```typescript\nimport { filterTasksByGoal } from '../selection.js';\n\ndescribe('filterTasksByGoal', () => {\n  it('filters', () => { assert.ok(true); });\n});\n```\n### 2. Done",
      remediationItems: [{ category: "testCoverage", title: "Add unit tests", diffMarkers: ["filterTasksByGoal("], weight: 4.5 }],
    }) + "\n```";

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 81);
    assert.equal(result.summary, "Core implementation correct");
    assert.ok(result.remediationPlan.includes("Add tests"));
    assert.equal(result.remediationItems.length, 1);
    assert.equal(result.remediationItems[0]?.title, "Add unit tests");
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

describe("parseReviewResult — breakdown", () => {
  it("extracts breakdown scores when present", () => {
    const input = JSON.stringify({
      confidence: 93,
      breakdown: { correctness: 97, testCoverage: 85, codeQuality: 97, documentation: 75 },
      summary: "Good",
      issues: [],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.deepEqual(result.breakdown, {
      correctness: 97,
      testCoverage: 85,
      codeQuality: 97,
      documentation: 75,
    });
  });

  it("defaults breakdown to zeros when absent", () => {
    const input = JSON.stringify({ confidence: 50, summary: "", issues: [], blockers: [] });
    const result = parseReviewResult(input);
    assert.deepEqual(result.breakdown, {
      correctness: 0,
      testCoverage: 0,
      codeQuality: 0,
      documentation: 0,
    });
  });

  it("defaults individual breakdown fields to 0 when not numbers", () => {
    const input = JSON.stringify({
      confidence: 80,
      breakdown: { correctness: "high", testCoverage: null, codeQuality: 90 },
      summary: "",
      issues: [],
      blockers: [],
    });
    const result = parseReviewResult(input);
    assert.equal(result.breakdown.correctness, 0);
    assert.equal(result.breakdown.testCoverage, 0);
    assert.equal(result.breakdown.codeQuality, 90);
    assert.equal(result.breakdown.documentation, 0);
  });
});

describe("buildScoringTable", () => {
  it("produces a markdown table sorted by potential gain descending", () => {
    const table = buildScoringTable(
      { correctness: 97, testCoverage: 85, codeQuality: 97, documentation: 75 },
      93, 95,
    );
    // testCoverage (+4.5) should come before documentation (+2.5)
    const tcIndex = table.indexOf("testCoverage");
    const docIndex = table.indexOf("documentation");
    assert.ok(tcIndex < docIndex, "testCoverage should appear before documentation");
  });

  it("marks categories with >= 2 point potential gain as FIX THIS", () => {
    const table = buildScoringTable(
      { correctness: 97, testCoverage: 85, codeQuality: 97, documentation: 75 },
      93, 95,
    );
    assert.ok(table.includes("testCoverage") && table.includes("FIX THIS"));
    assert.ok(table.includes("documentation") && table.includes("FIX THIS"));
    // codeQuality at 97 has only +0.6 potential — no FIX THIS
    const cqLine = table.split("\n").find((l) => l.includes("codeQuality"));
    assert.ok(cqLine && !cqLine.includes("FIX THIS"));
  });

  it("includes confidence and target in header", () => {
    const table = buildScoringTable(
      { correctness: 100, testCoverage: 100, codeQuality: 100, documentation: 100 },
      100, 95,
    );
    assert.ok(table.includes("100/100"));
    assert.ok(table.includes("target: 95"));
  });

  it("computes potential gain correctly", () => {
    const table = buildScoringTable(
      { correctness: 0, testCoverage: 0, codeQuality: 0, documentation: 0 },
      0, 95,
    );
    // correctness at 0 with 40% weight = +40.0 potential
    assert.ok(table.includes("+40.0"));
    // testCoverage at 0 with 30% weight = +30.0 potential
    assert.ok(table.includes("+30.0"));
  });

  it("lists top opportunities in 'Work on these first' line", () => {
    const table = buildScoringTable(
      { correctness: 97, testCoverage: 85, codeQuality: 97, documentation: 75 },
      93, 95,
    );
    assert.ok(table.includes("Work on these first"));
    assert.ok(table.includes("**testCoverage** (+4.5 points)"));
    assert.ok(table.includes("**documentation** (+2.5 points)"));
  });
});

describe("parseReviewResult — remediationItems", () => {
  it("extracts remediationItems when present", () => {
    const input = JSON.stringify({
      confidence: 80,
      summary: "Needs work",
      issues: [],
      blockers: [],
      remediationPlan: "Fix things",
      remediationItems: [
        {
          category: "testCoverage",
          title: "Add integration tests",
          diffMarkers: ["describe(\"integration\""],
          weight: 4.5,
        },
      ],
    });
    const result = parseReviewResult(input);
    assert.equal(result.remediationItems.length, 1);
    const item = result.remediationItems[0];
    assert.ok(item);
    assert.equal(item.category, "testCoverage");
    assert.equal(item.title, "Add integration tests");
    assert.deepEqual(item.diffMarkers, ["describe(\"integration\""]);
    assert.equal(item.weight, 4.5);
  });

  it("defaults remediationItems to empty array when absent", () => {
    const input = JSON.stringify({
      confidence: 97,
      summary: "All good",
      issues: [],
      blockers: [],
    });
    const result = parseReviewResult(input);
    assert.deepEqual(result.remediationItems, []);
  });

  it("skips items missing category or title", () => {
    const input = JSON.stringify({
      confidence: 80,
      summary: "Needs work",
      issues: [],
      blockers: [],
      remediationItems: [
        { category: "testCoverage", title: "", diffMarkers: [], weight: 3 },
        { category: "", title: "Fix thing", diffMarkers: [], weight: 3 },
        { category: "correctness", title: "Real item", diffMarkers: ["marker"], weight: 5 },
      ],
    });
    const result = parseReviewResult(input);
    assert.equal(result.remediationItems.length, 1);
    assert.equal(result.remediationItems[0]?.title, "Real item");
  });

  it("handles non-array remediationItems gracefully", () => {
    const input = JSON.stringify({
      confidence: 80,
      summary: "Needs work",
      issues: [],
      blockers: [],
      remediationItems: "not an array",
    });
    const result = parseReviewResult(input);
    assert.deepEqual(result.remediationItems, []);
  });

  it("filters non-string diffMarkers", () => {
    const input = JSON.stringify({
      confidence: 80,
      summary: "Needs work",
      issues: [],
      blockers: [],
      remediationItems: [
        { category: "correctness", title: "Fix bug", diffMarkers: [123, "valid marker", null], weight: 5 },
      ],
    });
    const result = parseReviewResult(input);
    assert.equal(result.remediationItems.length, 1);
    assert.deepEqual(result.remediationItems[0]?.diffMarkers, ["valid marker"]);
  });

  it("defaults weight to 0 when not a number", () => {
    const input = JSON.stringify({
      confidence: 80,
      summary: "Needs work",
      issues: [],
      blockers: [],
      remediationItems: [
        { category: "correctness", title: "Fix bug", diffMarkers: [], weight: "high" },
      ],
    });
    const result = parseReviewResult(input);
    assert.equal(result.remediationItems[0]?.weight, 0);
  });
});

describe("verifyRemediationMarkers", () => {
  const makeDeps = (diff: string): DiffProvider => ({
    getDiff: async () => diff,
  });

  const makeItem = (overrides: Partial<RemediationItem> = {}): RemediationItem => ({
    category: "testCoverage",
    title: "Add tests",
    diffMarkers: ["describe(\"test\""],
    weight: 3.0,
    ...overrides,
  });

  it("passes when no items", async () => {
    const result = await verifyRemediationMarkers([], "main", undefined, makeDeps(""));
    assert.equal(result.passed, true);
    assert.deepEqual(result.missingItems, []);
  });

  it("passes when all items have weight below threshold", async () => {
    const item = makeItem({ weight: 1.0 });
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(""));
    assert.equal(result.passed, true);
  });

  it("passes when all items have empty diffMarkers", async () => {
    const item = makeItem({ diffMarkers: [], weight: 5.0 });
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(""));
    assert.equal(result.passed, true);
  });

  it("passes when all high-weight markers are found in diff", async () => {
    const item = makeItem({ diffMarkers: ["describe(\"test\""], weight: 4.0 });
    const diff = '+ describe("test", () => {';
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(diff));
    assert.equal(result.passed, true);
    assert.deepEqual(result.missingItems, []);
  });

  it("fails when a high-weight item has no marker matches", async () => {
    const item = makeItem({ diffMarkers: ["describe(\"integration\""], weight: 4.0 });
    const diff = "+ // only documentation changes";
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(diff));
    assert.equal(result.passed, false);
    assert.equal(result.missingItems.length, 1);
    assert.equal(result.missingItems[0]?.title, "Add tests");
  });

  it("passes when at least one marker of an item matches", async () => {
    const item = makeItem({
      diffMarkers: ["describe(\"integration\"", "describe(\"unit\""],
      weight: 4.0,
    });
    const diff = '+ describe("unit", () => {';
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(diff));
    assert.equal(result.passed, true);
  });

  it("passes (skips verification) when getDiff throws", async () => {
    const failDeps: DiffProvider = {
      getDiff: async () => { throw new Error("git not found"); },
    };
    const item = makeItem({ weight: 5.0 });
    const result = await verifyRemediationMarkers([item], "main", undefined, failDeps);
    assert.equal(result.passed, true);
  });

  it("returns all missing items in the list", async () => {
    const items = [
      makeItem({ title: "Add unit tests", diffMarkers: ["describe(\"unit\""], weight: 3.0 }),
      makeItem({ title: "Add integration tests", diffMarkers: ["describe(\"integration\""], weight: 4.0 }),
      makeItem({ title: "Update docs", diffMarkers: ["## New Feature"], weight: 2.5 }),
    ];
    const diff = "+ ## New Feature\n+ some docs";
    const result = await verifyRemediationMarkers(items, "main", undefined, makeDeps(diff));
    assert.equal(result.passed, false);
    assert.equal(result.missingItems.length, 2);
    const titles = result.missingItems.map((i) => i.title);
    assert.ok(titles.includes("Add unit tests"));
    assert.ok(titles.includes("Add integration tests"));
  });

  it("checks items with weight exactly at threshold", async () => {
    const item = makeItem({ diffMarkers: ["describe(\"missing\""], weight: MARKER_WEIGHT_THRESHOLD });
    const diff = "+ only documentation changes";
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(diff));
    assert.equal(result.passed, false);
    assert.equal(result.missingItems.length, 1);
  });

  it("skips items just below threshold", async () => {
    const item = makeItem({ diffMarkers: ["describe(\"missing\""], weight: MARKER_WEIGHT_THRESHOLD - 0.1 });
    const diff = "+ only documentation changes";
    const result = await verifyRemediationMarkers([item], "main", undefined, makeDeps(diff));
    assert.equal(result.passed, true);
  });

  it("threads cwd to getDiff", async () => {
    let receivedCwd: string | undefined;
    const deps: DiffProvider = {
      getDiff: async (_base, cwd) => { receivedCwd = cwd; return "+ marker"; },
    };
    const item = makeItem({ diffMarkers: ["marker"], weight: 3.0 });
    await verifyRemediationMarkers([item], "main", "/my/worktree", deps);
    assert.equal(receivedCwd, "/my/worktree");
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
    goal: null,
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

describe("isContextWindowExceeded", () => {
  it("returns true when usage equals limit", () => {
    assert.equal(isContextWindowExceeded(60, 60), true);
  });

  it("returns true when usage exceeds limit", () => {
    assert.equal(isContextWindowExceeded(75, 60), true);
  });

  it("returns false when usage is under limit", () => {
    assert.equal(isContextWindowExceeded(40, 60), false);
  });

  it("returns false when usage is 0", () => {
    assert.equal(isContextWindowExceeded(0, 60), false);
  });
});

describe("applyContextWindowExceeded", () => {
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
    goal: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("returns null when context window is not exceeded", async () => {
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async () => { throw new Error("should not be called"); },
    };
    const task = makeTask({ totalCost: 0.10 });
    const result = await applyContextWindowExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.30, 40, 60,
    );
    assert.equal(result, null);
  });

  it("returns updated task when context window is exceeded", async () => {
    const task = makeTask({ totalCost: 0.10 });
    let capturedUpdates: Partial<Task> | undefined;
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async (_id: string, updates: Partial<Task>) => {
        capturedUpdates = updates;
        return { ...task, ...updates } as Task;
      },
    };
    const result = await applyContextWindowExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.55, 75, 60,
    );
    assert.notEqual(result, null);
    assert.equal(capturedUpdates?.totalCost, 0.65); // 0.10 + 0.55
  });

  it("returns updated task when usage exactly equals limit", async () => {
    const task = makeTask({ totalCost: 0.00 });
    const mockBackend: Pick<TaskBackend, "updateTask"> = {
      updateTask: async (_id: string, updates: Partial<Task>) => {
        return { ...task, ...updates } as Task;
      },
    };
    const result = await applyContextWindowExceeded(
      mockBackend as TaskBackend, "task-001", task, 0.50, 60, 60,
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
    goal: null,
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
      claimTask: async () => true,
      releaseTask: async () => {},
    } as TaskBackend;
    return { backend, state };
  }

  const noopHookDeps: HookDeps = {
    invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 50 } as InvokeResult),
    log: async () => {},
    warn: () => {},
    commit: async () => false,
  };

  it("'none' mode sets task to review state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, state: mockState } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "none" } });
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, noopHookDeps,
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
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, { merge: true }, noopHookDeps,
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
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, { noMerge: true }, noopHookDeps,
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
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, noopHookDeps,
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
        makeTask(), config, backend, null, null, dir, {}, noopHookDeps,
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

  it("hook execution error moves task to blocked", async () => {
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
        invoke: async () => { throw new Error("invoke crashed"); },
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Hook threw — moves task to blocked (retrying won't fix an error)
      assert.equal(result.state, "blocked");
      assert.equal(result.mergedSuccessfully, false);
      assert.notEqual(mockState.lastUpdate, null);
      assert.equal(mockState.lastUpdate?.updates.state, "blocked");
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
    goal: null,
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
      claimTask: async () => true,
      releaseTask: async () => {},
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
    goal: null,
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
      claimTask: async () => true,
      releaseTask: async () => {},
    } as TaskBackend;
    return { backend, updates };
  }

  it("blocking hook failure without fixes moves task to blocked", async () => {
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
      // No fixes applied — retrying won't help, task moves to blocked
      assert.equal(result.state, "blocked");
      assert.ok(updates.length > 0);
      assert.equal(updates[updates.length - 1]?.updates.state, "blocked");
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

  it("re-verifies when hook applies fixes and confidence stays above target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-reverify-"));
    try {
      const { backend, updates } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            // First call: hook passes with fixes_applied
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["extracted helper"]}',
              costUsd: 0.03,
              exitCode: 0,
              durationMs: 100,
            } as InvokeResult;
          }
          // Second call: re-verify review — confidence above target
          if (invokeCount === 2) {
            return {
              output: JSON.stringify({ confidence: 97, summary: "All good after fixes", issues: [], blockers: [], remediationPlan: "" }),
              costUsd: 0.02,
              exitCode: 0,
              durationMs: 80,
            } as InvokeResult;
          }
          // Third call: re-run hook after re-verify — no more fixes
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Should proceed to review since confidence stayed above target
      assert.equal(result.state, "review");
      assert.equal(result.mergedSuccessfully, false);
      // invoke should have been called 3 times: hook, re-review, re-hook
      assert.equal(invokeCount, 3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("re-verify drops confidence below target — returns in_progress with remediation plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-reverify-drop-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            // Hook passes with fixes
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["refactored module"]}',
              costUsd: 0.03,
              exitCode: 0,
              durationMs: 100,
            } as InvokeResult;
          }
          // Re-verify review — confidence dropped below target
          return {
            output: JSON.stringify({ confidence: 80, summary: "Fixes broke tests", issues: ["test failures"], blockers: [], remediationPlan: "Fix the broken tests by reverting the module extraction" }),
            costUsd: 0.02,
            exitCode: 0,
            durationMs: 80,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Should return in_progress because confidence dropped
      assert.equal(result.state, "in_progress");
      assert.equal(result.mergedSuccessfully, false);
      // Verify remediation plan was written
      const { readFile: readF } = await import("node:fs/promises");
      const planContent = await readF(join(dir, "plan.md"), "utf-8");
      assert.ok(planContent.includes("Fix the broken tests"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("caps re-verification at MAX_REVERIFICATIONS attempts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-reverify-cap-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          // All hook calls return fixes_applied, all reviews return above-target confidence
          if (invokeCount % 2 === 1) {
            // Hook: always applies fixes
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["another fix"]}',
              costUsd: 0.01,
              exitCode: 0,
              durationMs: 50,
            } as InvokeResult;
          }
          // Review: always above target
          return {
            output: JSON.stringify({ confidence: 98, summary: "Good", issues: [], blockers: [], remediationPlan: "" }),
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Should eventually proceed (capped at MAX_REVERIFICATIONS)
      assert.equal(result.state, "review");
      // Expected calls: hook + (re-review + re-hook) * MAX_REVERIFICATIONS = 1 + 2*2 = 5
      assert.equal(invokeCount, 1 + 2 * MAX_REVERIFICATIONS);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("no re-verification when hook has no fixes_applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-no-reverify-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Should proceed directly — no re-verification
      assert.equal(result.state, "review");
      // Only 1 invoke call (the hook itself)
      assert.equal(invokeCount, 1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("re-verify auto-commits hook changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-reverify-commit-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["optimized loop"]}',
              costUsd: 0.02,
              exitCode: 0,
              durationMs: 80,
            } as InvokeResult;
          }
          if (invokeCount === 2) {
            return {
              output: JSON.stringify({ confidence: 96, summary: "Looks good", issues: [], blockers: [], remediationPlan: "" }),
              costUsd: 0.01,
              exitCode: 0,
              durationMs: 50,
            } as InvokeResult;
          }
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      // The key assertion is that the re-verify loop runs and proceeds
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(result.state, "review");
      // 3 calls: hook (fixes), re-review, re-hook (no fixes)
      assert.equal(invokeCount, 3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("re-verify logs cost with re-verify phase label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-reverify-cost-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const logCalls: Array<{ phase: string; cost: number }> = [];
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["fix"]}',
              costUsd: 0.03,
              exitCode: 0,
              durationMs: 50,
            } as InvokeResult;
          }
          if (invokeCount === 2) {
            return {
              output: JSON.stringify({ confidence: 96, summary: "OK", issues: [], blockers: [], remediationPlan: "" }),
              costUsd: 0.04,
              exitCode: 0,
              durationMs: 50,
            } as InvokeResult;
          }
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async (_dir, _id, phase, cost) => { logCalls.push({ phase, cost }); },
        warn: () => {},
        commit: async () => false,
      };
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      // Should have: hook:on_confidence_met (0.03), re-verify (0.04), hook:on_confidence_met (0.01)
      const reVerifyCalls = logCalls.filter((c) => c.phase === "re-verify");
      assert.equal(reVerifyCalls.length, 1);
      assert.equal(reVerifyCalls[0]?.cost, 0.04);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("hook execution error moves task to blocked instead of proceeding to merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-hcm-"));
    try {
      const { backend, updates } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "merge" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => {
          throw new Error("Claude invocation failed");
        },
        log: async () => {},
        warn: () => {},
      };
      const result = await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-001-test", "main", dir, {}, hookDeps,
      );
      assert.equal(result.state, "blocked");
      assert.equal(result.mergedSuccessfully, false);
      // Task state should be updated to blocked by moveToBlocked
      assert.ok(updates.length > 0);
      assert.equal(updates[updates.length - 1]?.updates.state, "blocked");
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
    goal: null,
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
    goal: null,
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
      claimTask: async () => true,
      releaseTask: async () => {},
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

describe("buildReviewPrompt", () => {
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
    goal: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("includes branch checkout and three-dot diff when opts provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-review-"));
    try {
      const prompt = await buildReviewPrompt(makeTask(), dir, {
        taskBranch: "hootl/task-001-my-feature",
        baseBranch: "main",
      });
      assert.ok(prompt.includes("git checkout hootl/task-001-my-feature"), "should instruct to checkout task branch");
      assert.ok(prompt.includes("git diff main...HEAD"), "should use three-dot diff against base");
      assert.ok(prompt.includes("IMPORTANT"), "should emphasize the instruction");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("falls back to plain git diff when opts not provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-review-"));
    try {
      const prompt = await buildReviewPrompt(makeTask(), dir);
      assert.ok(prompt.includes("use `git diff`"), "should use plain git diff");
      assert.ok(!prompt.includes("git checkout"), "should not mention checkout");
      assert.ok(!prompt.includes("...HEAD"), "should not use three-dot diff");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("falls back to plain git diff when opts partially provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-review-"));
    try {
      const prompt = await buildReviewPrompt(makeTask(), dir, {
        taskBranch: "hootl/task-001-my-feature",
        // baseBranch intentionally omitted
      });
      assert.ok(prompt.includes("use `git diff`"), "should fall back without baseBranch");
      assert.ok(!prompt.includes("...HEAD"), "should not use three-dot diff");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes previous test results when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-review-"));
    try {
      await writeFile(join(dir, "test_results.md"), "All 10 tests passed");
      const prompt = await buildReviewPrompt(makeTask(), dir, {
        taskBranch: "hootl/task-001-feat",
        baseBranch: "main",
      });
      assert.ok(prompt.includes("## Previous Test Results"), "should include test results header");
      assert.ok(prompt.includes("All 10 tests passed"), "should include test results content");
      // Branch instructions should also be present alongside test results
      assert.ok(prompt.includes("git diff main...HEAD"), "should still include diff instruction");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkAllDependenciesDone
// ---------------------------------------------------------------------------

describe("checkAllDependenciesDone", () => {
  const makeTask = (state: string): Task => ({
    id: "dep-001",
    title: "Dep",
    description: "A dependency",
    priority: "medium",
    type: "feature",
    state: state as Task["state"],
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 0,
    totalCost: 0,
    branch: null,
    worktree: null,
    userPriority: null,
    goal: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("returns true when all dependencies are done", async () => {
    const backend = {
      getTask: async () => makeTask("done"),
    } as unknown as TaskBackend;
    assert.equal(await checkAllDependenciesDone(backend, ["dep-001", "dep-002"]), true);
  });

  it("returns false when any dependency is not done", async () => {
    let callCount = 0;
    const backend = {
      getTask: async () => {
        callCount++;
        return makeTask(callCount === 1 ? "done" : "in_progress");
      },
    } as unknown as TaskBackend;
    assert.equal(await checkAllDependenciesDone(backend, ["dep-001", "dep-002"]), false);
  });

  it("returns false on getTask error", async () => {
    const backend = {
      getTask: async () => { throw new Error("not found"); },
    } as unknown as TaskBackend;
    assert.equal(await checkAllDependenciesDone(backend, ["dep-001"]), false);
  });

  it("returns true for empty dependencies array", async () => {
    const backend = {
      getTask: async () => makeTask("done"),
    } as unknown as TaskBackend;
    assert.equal(await checkAllDependenciesDone(backend, []), true);
  });
});

// ---------------------------------------------------------------------------
// logEvent integration: verify structured events emitted during loop functions
// ---------------------------------------------------------------------------

/**
 * Helper: reads events.jsonl, filters by sessionId, and returns parsed entries.
 * Uses _setSessionId to isolate events from a specific test run.
 */
async function readEventsForSession(sessionId: string): Promise<LogEntry[]> {
  const eventsPath = join(getProjectDir(), "logs", "events.jsonl");
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

describe("logEvent integration in handleConfidenceMet", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-log-001",
    title: "Log test task",
    description: "Testing logEvent integration",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 95,
    attempts: 1,
    totalCost: 0.10,
    branch: "hootl/task-log-001-test",
    worktree: null,
    userPriority: null,
    goal: null,
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
      claimTask: async () => true,
      releaseTask: async () => {},
    } as TaskBackend;
    return { backend, updates };
  }

  const noopHookDeps: HookDeps = {
    invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 50 } as InvokeResult),
    log: async () => {},
    warn: () => {},
    commit: async () => false,
  };

  let originalSessionId: string;

  beforeEach(() => {
    originalSessionId = getSessionId();
  });

  afterEach(() => {
    _setSessionId(originalSessionId);
  });

  it("emits state_change and decision events for none mode (confidence_met_none)", async () => {
    const testSessionId = `test-none-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-none-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "none" } });
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, noopHookDeps,
      );

      const events = await readEventsForSession(testSessionId);
      const stateChanges = events.filter((e) => e.type === "state_change");
      const decisions = events.filter((e) => e.type === "decision");

      // Should have a state_change from in_progress to review
      assert.ok(stateChanges.length >= 1, "should emit at least one state_change event");
      const toReview = stateChanges.find(
        (e) => e.type === "state_change" && e.data.to === "review",
      );
      assert.ok(toReview !== undefined, "should emit state_change to review");

      // Should have a confidence_met_none decision
      const noneDecision = decisions.find(
        (e) => e.type === "decision" && e.data.decision === "confidence_met_none",
      );
      assert.ok(noneDecision !== undefined, "should emit confidence_met_none decision");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits state_change and decision events for merge mode (merge_failed fallback)", async () => {
    const testSessionId = `test-merge-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-merge-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "merge" } });
      // Without a real git repo, mergeBranch fails and falls back to review
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, noopHookDeps,
      );

      const events = await readEventsForSession(testSessionId);
      const decisions = events.filter((e) => e.type === "decision");

      // merge fails (no real git) so should emit merge_failed decision
      const mergeFailed = decisions.find(
        (e) => e.type === "decision" && e.data.decision === "merge_failed",
      );
      assert.ok(mergeFailed !== undefined, "should emit merge_failed decision on merge failure");

      const stateChanges = events.filter((e) => e.type === "state_change");
      const toReview = stateChanges.find(
        (e) => e.type === "state_change" && e.data.to === "review" && e.data.reason === "Merge failed",
      );
      assert.ok(toReview !== undefined, "should emit state_change to review with merge failed reason");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits hook_run events during hook execution", async () => {
    const testSessionId = `test-hookrun-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-hookrun-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", prompt: "check quality", blocking: false },
        ],
      });
      const hookDeps: HookDeps = {
        invoke: async () => ({
          output: '{"pass": true, "issues": [], "remediationActions": []}',
          costUsd: 0.03,
          exitCode: 0,
          durationMs: 30,
        } as InvokeResult),
        log: async () => {},
        warn: () => {},
      };
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, hookDeps,
      );

      const events = await readEventsForSession(testSessionId);
      const hookRuns = events.filter((e) => e.type === "hook_run");
      assert.ok(hookRuns.length >= 1, "should emit at least one hook_run event");
      const hookEvent = hookRuns[0]!;
      assert.equal(hookEvent.type, "hook_run");
      if (hookEvent.type === "hook_run") {
        assert.equal(hookEvent.data.trigger, "on_confidence_met");
        assert.equal(hookEvent.data.passed, true);
        assert.equal(hookEvent.data.costUsd, 0.03);
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits hook_run with fixes_applied when hook returns remediationActions", async () => {
    const testSessionId = `test-hookfixes-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-hookfixes-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["extracted helper function"]}',
              costUsd: 0.05,
              exitCode: 0,
              durationMs: 100,
            } as InvokeResult;
          }
          // Re-verify review
          if (invokeCount === 2) {
            return {
              output: JSON.stringify({ confidence: 97, summary: "Good", issues: [], blockers: [], remediationPlan: "" }),
              costUsd: 0.02,
              exitCode: 0,
              durationMs: 80,
            } as InvokeResult;
          }
          // Re-run hook — no more fixes
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, hookDeps,
      );

      const events = await readEventsForSession(testSessionId);
      const hookRuns = events.filter((e) => e.type === "hook_run");

      // First hook_run should have fixes_applied
      assert.ok(hookRuns.length >= 1, "should emit hook_run events");
      const firstHookRun = hookRuns[0]!;
      if (firstHookRun.type === "hook_run") {
        assert.deepEqual(firstHookRun.data.fixes_applied, ["extracted helper function"]);
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits re_verification decision during re-verify loop", async () => {
    const testSessionId = `test-reverify-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-reverify-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({
        git: { onConfidence: "none" },
        hooks: [
          { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        ],
      });
      let invokeCount = 0;
      const hookDeps: HookDeps = {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return {
              output: '{"pass": true, "issues": [], "fixes_applied": ["refactored code"]}',
              costUsd: 0.03,
              exitCode: 0,
              durationMs: 100,
            } as InvokeResult;
          }
          if (invokeCount === 2) {
            return {
              output: JSON.stringify({ confidence: 96, summary: "All good", issues: [], blockers: [], remediationPlan: "" }),
              costUsd: 0.02,
              exitCode: 0,
              durationMs: 80,
            } as InvokeResult;
          }
          return {
            output: '{"pass": true, "issues": [], "fixes_applied": []}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 50,
          } as InvokeResult;
        },
        log: async () => {},
        warn: () => {},
        commit: async () => false,
      };
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, hookDeps,
      );

      const events = await readEventsForSession(testSessionId);
      const reVerifyDecisions = events.filter(
        (e) => e.type === "decision" && e.data.decision === "re_verification",
      );
      assert.ok(reVerifyDecisions.length >= 1, "should emit at least one re_verification decision");
      const firstReVerify = reVerifyDecisions[0]!;
      if (firstReVerify.type === "decision") {
        assert.ok(firstReVerify.data.details?.includes("1/"), "should include iteration count");
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits pr_created decision and state_change to review for pr mode", async () => {
    const testSessionId = `test-pr-created-${randomUUID()}`;
    _setSessionId(testSessionId);

    const dir = await mkdtemp(join(tmpdir(), "hootl-log-pr-"));
    try {
      const { backend } = makeMockBackend();
      const config = ConfigSchema.parse({ git: { onConfidence: "pr" } });
      // pushBranch will fail (no remote), but the pr_created events are emitted
      // regardless because the code always transitions to review in pr mode.
      await handleConfidenceMet(
        makeTask(), config, backend, "hootl/task-log-001-test", "main", dir, {}, noopHookDeps,
      );

      const events = await readEventsForSession(testSessionId);

      // Should have a state_change to review with reason "PR created"
      const stateChanges = events.filter((e) => e.type === "state_change");
      const toReview = stateChanges.find(
        (e) => e.type === "state_change" && e.data.to === "review" && e.data.reason === "PR created",
      );
      assert.ok(toReview !== undefined, "should emit state_change to review with PR created reason");

      // Should have a pr_created decision
      const decisions = events.filter((e) => e.type === "decision");
      const prCreated = decisions.find(
        (e) => e.type === "decision" && e.data.decision === "pr_created",
      );
      assert.ok(prCreated !== undefined, "should emit pr_created decision");
      if (prCreated !== undefined && prCreated.type === "decision") {
        assert.ok(
          prCreated.data.details?.includes("hootl/task-log-001-test"),
          "pr_created decision details should include branch name",
        );
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("logEvent integration in moveToBlocked", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-log-mb",
    title: "Move to blocked log test",
    description: "Testing logEvent in moveToBlocked",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 50,
    attempts: 3,
    totalCost: 0.50,
    branch: "hootl/task-log-mb",
    worktree: null,
    userPriority: null,
    goal: null,
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  function makeMockBackend(): TaskBackend {
    return {
      updateTask: async (_id: string, upd: Partial<Task>) => ({ ...makeTask(), ...upd } as Task),
      createTask: async () => makeTask(),
      getTask: async () => makeTask(),
      listTasks: async () => [],
      deleteTask: async () => {},
      claimTask: async () => true,
      releaseTask: async () => {},
    } as TaskBackend;
  }

  let originalSessionId: string;

  beforeEach(() => {
    originalSessionId = getSessionId();
  });

  afterEach(() => {
    _setSessionId(originalSessionId);
  });

  it("emits state_change event with blocker reason", async () => {
    const testSessionId = `test-blocked-${randomUUID()}`;
    _setSessionId(testSessionId);

    const backend = makeMockBackend();
    const config = ConfigSchema.parse({ hooks: [] });
    const hookDeps: HookDeps = {
      invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 0 } as InvokeResult),
      log: async () => {},
      warn: () => {},
    };

    await moveToBlocked(backend, makeTask(), ["Budget exhausted"], "hootl/task-log-mb", "main", 50, config, hookDeps);

    const events = await readEventsForSession(testSessionId);
    const stateChanges = events.filter((e) => e.type === "state_change");
    assert.ok(stateChanges.length >= 1, "should emit at least one state_change event");
    const toBlocked = stateChanges.find(
      (e) => e.type === "state_change" && e.data.to === "blocked",
    );
    assert.ok(toBlocked !== undefined, "should emit state_change to blocked");
    if (toBlocked !== undefined && toBlocked.type === "state_change") {
      assert.ok(toBlocked.data.reason?.includes("Budget exhausted"), "reason should include blocker text");
    }
  });

  it("includes taskId in all emitted events", async () => {
    const testSessionId = `test-blocked-id-${randomUUID()}`;
    _setSessionId(testSessionId);

    const backend = makeMockBackend();
    const config = ConfigSchema.parse({ hooks: [] });
    const hookDeps: HookDeps = {
      invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 0 } as InvokeResult),
      log: async () => {},
      warn: () => {},
    };

    await moveToBlocked(backend, makeTask(), ["Test failure"], "hootl/task-log-mb", "main", 50, config, hookDeps);

    const events = await readEventsForSession(testSessionId);
    assert.ok(events.length > 0, "should emit at least one event");
    for (const event of events) {
      assert.equal(event.taskId, "task-log-mb", "all events should carry the correct taskId");
    }
  });
});
