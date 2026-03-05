import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateConditions, resolvePrompt, parseHookOutput, getSkillRegistry, runHooks } from "../hooks.js";
import type { HookContext } from "../hooks.js";
import type { Hook } from "../config.js";
import { ConfigSchema } from "../config.js";
import type { Task } from "../tasks/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
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
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    task: makeTask(),
    taskDir: "/tmp/test-hooks",
    baseBranch: "main",
    taskBranch: "hootl/task-001-test",
    confidence: 95,
    config: ConfigSchema.parse({}),
    ...overrides,
  };
}

function makeHook(overrides: Partial<Hook> = {}): Hook {
  return {
    trigger: "on_confidence_met",
    prompt: "Review the code for quality issues",
    blocking: false,
    ...overrides,
  };
}

// --- evaluateConditions ---

describe("evaluateConditions", () => {
  it("passes when no conditions are set", () => {
    const hook = makeHook({ conditions: undefined });
    const ctx = makeCtx({ confidence: 50 });
    assert.equal(evaluateConditions(hook, ctx), true);
  });

  it("passes when empty conditions object", () => {
    const hook = makeHook({ conditions: {} });
    const ctx = makeCtx({ confidence: 50 });
    assert.equal(evaluateConditions(hook, ctx), true);
  });

  it("passes when minConfidence is met", () => {
    const hook = makeHook({ conditions: { minConfidence: 90 } });
    const ctx = makeCtx({ confidence: 95 });
    assert.equal(evaluateConditions(hook, ctx), true);
  });

  it("passes when confidence equals minConfidence exactly", () => {
    const hook = makeHook({ conditions: { minConfidence: 90 } });
    const ctx = makeCtx({ confidence: 90 });
    assert.equal(evaluateConditions(hook, ctx), true);
  });

  it("fails when minConfidence is not met", () => {
    const hook = makeHook({ conditions: { minConfidence: 90 } });
    const ctx = makeCtx({ confidence: 85 });
    assert.equal(evaluateConditions(hook, ctx), false);
  });

  it("fails when confidence is null and minConfidence is set", () => {
    const hook = makeHook({ conditions: { minConfidence: 90 } });
    const ctx = makeCtx({ confidence: null });
    assert.equal(evaluateConditions(hook, ctx), false);
  });

  it("passes when confidence is null and no minConfidence", () => {
    const hook = makeHook({ conditions: {} });
    const ctx = makeCtx({ confidence: null });
    assert.equal(evaluateConditions(hook, ctx), true);
  });
});

// --- resolvePrompt ---

describe("resolvePrompt", () => {
  it("returns inline prompt as-is", async () => {
    const hook = makeHook({ prompt: "Check the code quality" });
    const ctx = makeCtx();
    const result = await resolvePrompt(hook, ctx);
    assert.equal(result, "Check the code quality");
  });

  it("resolves /simplify via skill registry", async () => {
    const hook = makeHook({ prompt: "/simplify" });
    const ctx = makeCtx({ baseBranch: "main", taskBranch: "hootl/task-001-test" });
    const result = await resolvePrompt(hook, ctx);
    assert.ok(result.includes("diff"));
    assert.ok(result.includes("main"));
    assert.ok(result.length > 50);
  });

  it("throws on unknown skill", async () => {
    const hook = makeHook({ prompt: "/nonexistent" });
    const ctx = makeCtx();
    await assert.rejects(
      () => resolvePrompt(hook, ctx),
      (err: Error) => {
        assert.ok(err.message.includes("Unknown skill"));
        assert.ok(err.message.includes("/nonexistent"));
        return true;
      },
    );
  });

  it("loads template file for templates/ prefix", async () => {
    // templates/simplify.md should exist
    const hook = makeHook({ prompt: "templates/simplify.md" });
    const ctx = makeCtx();
    const result = await resolvePrompt(hook, ctx);
    assert.ok(result.includes("code quality reviewer"));
  });

  it("throws when template file does not exist", async () => {
    const hook = makeHook({ prompt: "templates/nonexistent.md" });
    const ctx = makeCtx();
    await assert.rejects(() => resolvePrompt(hook, ctx));
  });
});

// --- parseHookOutput ---

describe("parseHookOutput", () => {
  it("parses valid JSON with pass=true", () => {
    const input = JSON.stringify({ pass: true, issues: [], fixed: ["cleaned up imports"] });
    const result = parseHookOutput(input);
    assert.equal(result.success, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.fixed, ["cleaned up imports"]);
  });

  it("parses valid JSON with pass=false and issues", () => {
    const input = JSON.stringify({
      pass: false,
      issues: ["duplicated logic in handler", "missing error handling"],
      fixed: [],
    });
    const result = parseHookOutput(input);
    assert.equal(result.success, false);
    assert.deepEqual(result.issues, ["duplicated logic in handler", "missing error handling"]);
    assert.deepEqual(result.fixed, []);
  });

  it("extracts JSON from markdown code block", () => {
    const input = `Here is my review:\n\n\`\`\`json\n{"pass": true, "issues": [], "fixed": []}\n\`\`\``;
    const result = parseHookOutput(input);
    assert.equal(result.success, true);
  });

  it("treats non-JSON non-empty output as success", () => {
    const result = parseHookOutput("Everything looks good, no issues found.");
    assert.equal(result.success, true);
    assert.deepEqual(result.issues, []);
  });

  it("treats empty output as failure", () => {
    const result = parseHookOutput("");
    assert.equal(result.success, false);
  });

  it("treats whitespace-only output as failure", () => {
    const result = parseHookOutput("   \n  ");
    assert.equal(result.success, false);
  });

  it("handles JSON with missing fixed field", () => {
    const input = JSON.stringify({ pass: true, issues: [] });
    const result = parseHookOutput(input);
    assert.equal(result.success, true);
    assert.deepEqual(result.fixed, []);
  });

  it("handles pass=false without explicit false value", () => {
    const input = JSON.stringify({ pass: "yes", issues: ["problem"] });
    const result = parseHookOutput(input);
    // pass !== true, so success is false
    assert.equal(result.success, false);
  });
});

// --- Skill Registry ---

describe("skillRegistry", () => {
  it("has simplify skill registered", () => {
    const registry = getSkillRegistry();
    assert.ok(registry.has("simplify"));
  });

  it("simplify skill produces prompt containing diff", () => {
    const registry = getSkillRegistry();
    const builder = registry.get("simplify");
    assert.ok(builder !== undefined);
    const ctx = makeCtx({ baseBranch: "main", taskBranch: "hootl/t1-foo" });
    const prompt = builder(ctx);
    assert.ok(prompt.includes("diff"));
    assert.ok(prompt.includes("main"));
    assert.ok(prompt.includes("hootl/t1-foo"));
  });

  it("simplify skill uses fallback branch names when null", () => {
    const registry = getSkillRegistry();
    const builder = registry.get("simplify");
    assert.ok(builder !== undefined);
    const ctx = makeCtx({ baseBranch: null, taskBranch: null });
    const prompt = builder(ctx);
    assert.ok(prompt.includes("HEAD"));
    assert.ok(prompt.includes("main")); // fallback
  });
});

// --- runHooks orchestration ---
// These tests verify the orchestrator logic without calling real Claude.
// We test with configs that would trigger hooks, but since invokeClaude
// would fail in test (no Claude binary), we test the filtering and
// condition evaluation paths that don't reach the actual invocation.

describe("runHooks", () => {
  it("returns allPassed=true when no hooks match the trigger", async () => {
    const ctx = makeCtx({
      config: ConfigSchema.parse({
        hooks: [
          { trigger: "on_blocked", prompt: "check something", blocking: true },
        ],
      }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    assert.equal(result.allPassed, true);
    assert.deepEqual(result.results, []);
    assert.equal(result.totalCost, 0);
  });

  it("returns allPassed=true when no hooks configured", async () => {
    const ctx = makeCtx({
      config: ConfigSchema.parse({ hooks: [] }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    assert.equal(result.allPassed, true);
    assert.deepEqual(result.results, []);
  });

  it("skips hooks that fail condition evaluation", async () => {
    const ctx = makeCtx({
      confidence: 50,
      config: ConfigSchema.parse({
        hooks: [
          {
            trigger: "on_confidence_met",
            prompt: "review code",
            blocking: true,
            conditions: { minConfidence: 90 },
          },
        ],
      }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    // Hook was skipped due to conditions, so allPassed stays true
    assert.equal(result.allPassed, true);
    assert.deepEqual(result.results, []);
  });

  it("handles hook that throws by recording failure", async () => {
    // A hook referencing an unknown skill will throw during resolvePrompt
    const ctx = makeCtx({
      config: ConfigSchema.parse({
        hooks: [
          {
            trigger: "on_confidence_met",
            prompt: "/nonexistent_skill",
            blocking: false,
          },
        ],
      }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    // Advisory hook that threw — allPassed stays true
    assert.equal(result.allPassed, true);
    assert.equal(result.results.length, 1);
    const hookResult = result.results[0];
    assert.ok(hookResult !== undefined);
    assert.equal(hookResult.success, false);
    assert.ok(hookResult.output.includes("Unknown skill"));
  });

  it("blocking hook that throws sets allPassed to false", async () => {
    const ctx = makeCtx({
      config: ConfigSchema.parse({
        hooks: [
          {
            trigger: "on_confidence_met",
            prompt: "/nonexistent_skill",
            blocking: true,
          },
        ],
      }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    assert.equal(result.allPassed, false);
    assert.equal(result.results.length, 1);
  });

  it("filters hooks by trigger point", async () => {
    const ctx = makeCtx({
      config: ConfigSchema.parse({
        hooks: [
          { trigger: "on_confidence_met", prompt: "/nonexistent1", blocking: false },
          { trigger: "on_blocked", prompt: "/nonexistent2", blocking: false },
          { trigger: "on_confidence_met", prompt: "/nonexistent3", blocking: false },
        ],
      }),
    });
    const result = await runHooks("on_confidence_met", ctx);
    // Should only run 2 hooks (the on_confidence_met ones), not the on_blocked one
    assert.equal(result.results.length, 2);
  });
});
