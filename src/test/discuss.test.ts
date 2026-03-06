import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscussArgs,
  formatTaskChoice,
  parseTaskIdFromChoice,
  type DiscussTaskContext,
} from "../discuss.js";
import type { Task } from "../tasks/types.js";

function makeCtx(overrides: Partial<DiscussTaskContext> = {}): DiscussTaskContext {
  return {
    title: "Test task",
    description: "A test description",
    state: "in_progress",
    taskBlockers: [],
    ...overrides,
  };
}

describe("buildDiscussArgs", () => {
  it("returns only --dangerously-skip-permissions when no task context and no claudeMdPath", () => {
    const args = buildDiscussArgs();
    assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
  });

  it("returns only --dangerously-skip-permissions for undefined context and no claudeMdPath", () => {
    const args = buildDiscussArgs(undefined, undefined);
    assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
  });

  it("includes --system-prompt with task title and description", () => {
    const ctx = makeCtx({ title: "Fix login bug", description: "The login form crashes on empty email" });
    const args = buildDiscussArgs(ctx);

    assert.strictEqual(args[0], "--dangerously-skip-permissions");
    assert.strictEqual(args[1], "--system-prompt");
    assert.ok(args[2]!.includes("Fix login bug"));
    assert.ok(args[2]!.includes("The login form crashes on empty email"));
  });

  it("includes state section", () => {
    const ctx = makeCtx({ state: "blocked" });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## State"));
    assert.ok(prompt.includes("blocked"));
  });

  it("state appears after description and before plan", () => {
    const ctx = makeCtx({ plan: "The plan" });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    const descIdx = prompt.indexOf("## Description");
    const stateIdx = prompt.indexOf("## State");
    const planIdx = prompt.indexOf("## Current Plan");

    assert.ok(descIdx < stateIdx, "Description should come before State");
    assert.ok(stateIdx < planIdx, "State should come before Plan");
  });

  it("includes plan section when plan is provided", () => {
    const ctx = makeCtx({
      title: "Add tests",
      description: "Write unit tests for auth module",
      plan: "Step 1: Mock the auth service\nStep 2: Test login flow",
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Current Plan"));
    assert.ok(prompt.includes("Step 1: Mock the auth service"));
  });

  it("includes progress section when progress is provided", () => {
    const ctx = makeCtx({
      progress: "Completed schema migration for users table",
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Progress So Far"));
    assert.ok(prompt.includes("Completed schema migration"));
  });

  it("includes test results section when testResults is provided", () => {
    const ctx = makeCtx({
      testResults: "5 passed, 2 failed\nFailing: auth.test.ts, db.test.ts",
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Test Results"));
    assert.ok(prompt.includes("5 passed, 2 failed"));
  });

  it("omits test results section when testResults is empty", () => {
    const ctx = makeCtx({ testResults: "" });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Test Results"));
  });

  it("omits test results section when testResults is whitespace", () => {
    const ctx = makeCtx({ testResults: "   \n  " });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Test Results"));
  });

  it("includes blockers section when blockers file content is provided", () => {
    const ctx = makeCtx({
      blockers: "CI pipeline failing on integration tests",
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Blockers"));
    assert.ok(prompt.includes("CI pipeline failing"));
  });

  it("includes task blockers section when taskBlockers array is non-empty", () => {
    const ctx = makeCtx({
      taskBlockers: ["Missing API credentials", "Waiting on design review"],
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Task Blockers"));
    assert.ok(prompt.includes("- Missing API credentials"));
    assert.ok(prompt.includes("- Waiting on design review"));
  });

  it("omits task blockers section when taskBlockers array is empty", () => {
    const ctx = makeCtx({ taskBlockers: [] });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Task Blockers"));
  });

  it("includes project context section when claudeMdPath is provided with task context", () => {
    const ctx = makeCtx();
    const args = buildDiscussArgs(ctx, "/path/to/CLAUDE.md");
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Project Context"));
    assert.ok(prompt.includes("/path/to/CLAUDE.md"));
    assert.ok(prompt.includes("codebase context"));
  });

  it("generates system prompt with only project context when no task but claudeMdPath provided", () => {
    const args = buildDiscussArgs(undefined, "/path/to/CLAUDE.md");

    assert.strictEqual(args[0], "--dangerously-skip-permissions");
    assert.strictEqual(args[1], "--system-prompt");
    assert.ok(args[2]!.includes("# Project Context"));
    assert.ok(args[2]!.includes("/path/to/CLAUDE.md"));
    assert.ok(!args[2]!.includes("# Task:"));
  });

  it("omits empty optional sections", () => {
    const ctx = makeCtx({
      plan: "",
      progress: "   ",
      testResults: "",
      blockers: "",
      taskBlockers: [],
    });
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Current Plan"));
    assert.ok(!prompt.includes("## Progress So Far"));
    assert.ok(!prompt.includes("## Test Results"));
    assert.ok(!prompt.includes("## Blockers"));
    assert.ok(!prompt.includes("## Task Blockers"));
  });

  it("omits undefined optional sections", () => {
    const ctx = makeCtx();
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Current Plan"));
    assert.ok(!prompt.includes("## Progress So Far"));
    assert.ok(!prompt.includes("## Test Results"));
    assert.ok(!prompt.includes("## Blockers"));
    assert.ok(!prompt.includes("## Task Blockers"));
  });

  it("always has --dangerously-skip-permissions as first arg", () => {
    const ctx = makeCtx({
      plan: "The plan",
      progress: "The progress",
      testResults: "All passed",
      blockers: "The blockers",
      taskBlockers: ["A blocker"],
    });
    const args = buildDiscussArgs(ctx, "/path/to/CLAUDE.md");

    assert.strictEqual(args[0], "--dangerously-skip-permissions");
    assert.strictEqual(args.length, 3); // flag, --system-prompt, value
  });

  it("includes all sections in correct order when all provided", () => {
    const ctx = makeCtx({
      plan: "Plan content",
      progress: "Progress content",
      testResults: "Test content",
      blockers: "Blocker content",
      taskBlockers: ["A task blocker"],
    });
    const args = buildDiscussArgs(ctx, "/path/to/CLAUDE.md");
    const prompt = args[2]!;

    const descIdx = prompt.indexOf("## Description");
    const stateIdx = prompt.indexOf("## State");
    const planIdx = prompt.indexOf("## Current Plan");
    const progressIdx = prompt.indexOf("## Progress So Far");
    const testIdx = prompt.indexOf("## Test Results");
    const blockerIdx = prompt.indexOf("## Blockers");
    const taskBlockerIdx = prompt.indexOf("## Task Blockers");
    const projectIdx = prompt.indexOf("## Project Context");

    assert.ok(descIdx < stateIdx, "Description before State");
    assert.ok(stateIdx < planIdx, "State before Plan");
    assert.ok(planIdx < progressIdx, "Plan before Progress");
    assert.ok(progressIdx < testIdx, "Progress before Test Results");
    assert.ok(testIdx < blockerIdx, "Test Results before Blockers");
    assert.ok(blockerIdx < taskBlockerIdx, "Blockers before Task Blockers");
    assert.ok(taskBlockerIdx < projectIdx, "Task Blockers before Project Context");
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-abc",
    title: "Fix login bug",
    description: "The login form crashes",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 75,
    attempts: 2,
    totalCost: 1.5,
    branch: null,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatTaskChoice", () => {
  it("includes task id, title, state, and confidence", () => {
    const task = makeTask({ id: "task-abc", title: "Fix login bug", state: "in_progress", confidence: 75 });
    const result = formatTaskChoice(task);
    assert.strictEqual(result, "[task-abc] Fix login bug (in_progress, 75%)");
  });

  it("handles 0% confidence", () => {
    const task = makeTask({ confidence: 0 });
    const result = formatTaskChoice(task);
    assert.ok(result.includes("0%"));
  });

  it("handles 100% confidence", () => {
    const task = makeTask({ confidence: 100 });
    const result = formatTaskChoice(task);
    assert.ok(result.includes("100%"));
  });

  it("handles long titles", () => {
    const longTitle = "A".repeat(200);
    const task = makeTask({ title: longTitle });
    const result = formatTaskChoice(task);
    assert.ok(result.includes(longTitle));
    assert.ok(result.startsWith("[task-abc]"));
  });

  it("handles all task states", () => {
    for (const state of ["proposed", "ready", "in_progress", "review", "blocked", "done"] as const) {
      const task = makeTask({ state });
      const result = formatTaskChoice(task);
      assert.ok(result.includes(`(${state},`), `Should include state ${state}`);
    }
  });
});

describe("parseTaskIdFromChoice", () => {
  it("extracts task ID from formatted choice string", () => {
    const result = parseTaskIdFromChoice("[task-abc] Fix login bug (in_progress, 75%)");
    assert.strictEqual(result, "task-abc");
  });

  it("extracts ID with different format", () => {
    const result = parseTaskIdFromChoice("[task-xyz123] Some title (done, 100%)");
    assert.strictEqual(result, "task-xyz123");
  });

  it("returns undefined for string without brackets", () => {
    const result = parseTaskIdFromChoice("General discussion (no task context)");
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for empty string", () => {
    const result = parseTaskIdFromChoice("");
    assert.strictEqual(result, undefined);
  });

  it("handles bracket not at start", () => {
    const result = parseTaskIdFromChoice("prefix [task-abc] title");
    assert.strictEqual(result, undefined);
  });

  it("round-trips with formatTaskChoice", () => {
    const task = makeTask({ id: "task-round-trip" });
    const choice = formatTaskChoice(task);
    const parsed = parseTaskIdFromChoice(choice);
    assert.strictEqual(parsed, "task-round-trip");
  });
});
