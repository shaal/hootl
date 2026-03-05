import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDiscussArgs, type DiscussTaskContext } from "../discuss.js";

describe("buildDiscussArgs", () => {
  it("returns only --dangerously-skip-permissions when no task context", () => {
    const args = buildDiscussArgs();
    assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
  });

  it("returns only --dangerously-skip-permissions for undefined context", () => {
    const args = buildDiscussArgs(undefined);
    assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
  });

  it("includes --system-prompt with task title and description", () => {
    const ctx: DiscussTaskContext = {
      title: "Fix login bug",
      description: "The login form crashes on empty email",
    };
    const args = buildDiscussArgs(ctx);

    assert.strictEqual(args[0], "--dangerously-skip-permissions");
    assert.strictEqual(args[1], "--system-prompt");
    assert.ok(args[2]!.includes("Fix login bug"));
    assert.ok(args[2]!.includes("The login form crashes on empty email"));
  });

  it("includes plan section when plan is provided", () => {
    const ctx: DiscussTaskContext = {
      title: "Add tests",
      description: "Write unit tests for auth module",
      plan: "Step 1: Mock the auth service\nStep 2: Test login flow",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Current Plan"));
    assert.ok(prompt.includes("Step 1: Mock the auth service"));
  });

  it("includes progress section when progress is provided", () => {
    const ctx: DiscussTaskContext = {
      title: "Refactor DB",
      description: "Migrate from SQLite to PostgreSQL",
      progress: "Completed schema migration for users table",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Progress So Far"));
    assert.ok(prompt.includes("Completed schema migration"));
  });

  it("includes blockers section when blockers are provided", () => {
    const ctx: DiscussTaskContext = {
      title: "Deploy v2",
      description: "Deploy the new version",
      blockers: "CI pipeline failing on integration tests",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(prompt.includes("## Blockers"));
    assert.ok(prompt.includes("CI pipeline failing"));
  });

  it("omits empty optional sections", () => {
    const ctx: DiscussTaskContext = {
      title: "Simple task",
      description: "Do something",
      plan: "",
      progress: "   ",
      blockers: "",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Current Plan"));
    assert.ok(!prompt.includes("## Progress So Far"));
    assert.ok(!prompt.includes("## Blockers"));
  });

  it("omits undefined optional sections", () => {
    const ctx: DiscussTaskContext = {
      title: "Simple task",
      description: "Do something",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    assert.ok(!prompt.includes("## Current Plan"));
    assert.ok(!prompt.includes("## Progress So Far"));
    assert.ok(!prompt.includes("## Blockers"));
  });

  it("always has --dangerously-skip-permissions as first arg", () => {
    const ctx: DiscussTaskContext = {
      title: "Full context",
      description: "A task with all fields",
      plan: "The plan",
      progress: "The progress",
      blockers: "The blockers",
    };
    const args = buildDiscussArgs(ctx);

    assert.strictEqual(args[0], "--dangerously-skip-permissions");
    assert.strictEqual(args.length, 3); // flag, --system-prompt, value
  });

  it("includes all sections in correct order when all provided", () => {
    const ctx: DiscussTaskContext = {
      title: "Ordered task",
      description: "Check ordering",
      plan: "Plan content",
      progress: "Progress content",
      blockers: "Blocker content",
    };
    const args = buildDiscussArgs(ctx);
    const prompt = args[2]!;

    const planIdx = prompt.indexOf("## Current Plan");
    const progressIdx = prompt.indexOf("## Progress So Far");
    const blockerIdx = prompt.indexOf("## Blockers");

    assert.ok(planIdx < progressIdx, "Plan should come before Progress");
    assert.ok(progressIdx < blockerIdx, "Progress should come before Blockers");
  });
});
