import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getHooksForTrigger,
  buildHookPrompt,
  buildHookSystemPrompt,
  parseHookResult,
  runHook,
  runHooks,
  resolveSkill,
  runSkillHook,
} from "../hooks.js";
import type { HookContext, HookDeps, HookResult } from "../hooks.js";
import type { Hook } from "../config.js";
import type { Task } from "../tasks/types.js";
import type { InvokeResult } from "../invoke.js";
import { ConfigSchema } from "../config.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
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
  };
}

function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    task: makeTask(),
    branchName: "hootl/t1-test",
    baseBranch: "main",
    confidence: 80,
    config: ConfigSchema.parse({}),
    ...overrides,
  };
}

function makeHook(overrides: Partial<Hook> = {}): Hook {
  return {
    trigger: "on_confidence_met",
    prompt: "Check if the code follows best practices",
    blocking: false,
    ...overrides,
  };
}

// --- getHooksForTrigger ---

describe("getHooksForTrigger", () => {
  it("returns hooks matching the trigger", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_confidence_met" }),
      makeHook({ trigger: "on_blocked" }),
      makeHook({ trigger: "on_confidence_met" }),
    ];
    const ctx = makeContext();
    const result = getHooksForTrigger("on_confidence_met", hooks, ctx);
    assert.equal(result.length, 2);
  });

  it("filters out hooks with different triggers", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_blocked" }),
      makeHook({ trigger: "on_execute_start" }),
    ];
    const ctx = makeContext();
    const result = getHooksForTrigger("on_confidence_met", hooks, ctx);
    assert.equal(result.length, 0);
  });

  it("includes hook when confidence >= minConfidence", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", conditions: { minConfidence: 70 } }),
    ];
    const ctx = makeContext({ confidence: 80 });
    const result = getHooksForTrigger("on_review_complete", hooks, ctx);
    assert.equal(result.length, 1);
  });

  it("includes hook when confidence == minConfidence exactly", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", conditions: { minConfidence: 80 } }),
    ];
    const ctx = makeContext({ confidence: 80 });
    const result = getHooksForTrigger("on_review_complete", hooks, ctx);
    assert.equal(result.length, 1);
  });

  it("excludes hook when confidence < minConfidence", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", conditions: { minConfidence: 90 } }),
    ];
    const ctx = makeContext({ confidence: 80 });
    const result = getHooksForTrigger("on_review_complete", hooks, ctx);
    assert.equal(result.length, 0);
  });

  it("returns empty array when no hooks provided", () => {
    const ctx = makeContext();
    const result = getHooksForTrigger("on_confidence_met", [], ctx);
    assert.equal(result.length, 0);
  });

  it("includes hooks with no conditions (always pass)", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_blocked" }),
    ];
    const ctx = makeContext({ confidence: 10 });
    const result = getHooksForTrigger("on_blocked", hooks, ctx);
    assert.equal(result.length, 1);
  });

  it("mixes conditional and unconditional hooks correctly", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", conditions: { minConfidence: 90 } }),
      makeHook({ trigger: "on_review_complete" }), // no condition
      makeHook({ trigger: "on_review_complete", conditions: { minConfidence: 50 } }),
    ];
    const ctx = makeContext({ confidence: 75 });
    const result = getHooksForTrigger("on_review_complete", hooks, ctx);
    // First excluded (75 < 90), second included (no condition), third included (75 >= 50)
    assert.equal(result.length, 2);
  });
});

// --- buildHookPrompt ---

describe("buildHookPrompt", () => {
  it("returns inline string when prompt has no path indicators", async () => {
    const hook = makeHook({ prompt: "Check all code for security issues" });
    const result = await buildHookPrompt(hook);
    assert.equal(result, "Check all code for security issues");
  });

  it("returns inline string for plain text without slashes or extensions", async () => {
    const hook = makeHook({ prompt: "Validate the implementation quality" });
    const result = await buildHookPrompt(hook);
    assert.equal(result, "Validate the implementation quality");
  });

  it("reads file content when prompt ends with .md", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hooks-test-"));
    const filePath = join(tmpDir, "check.md");
    await writeFile(filePath, "# Security Check\nVerify no secrets are exposed.");

    try {
      const hook = makeHook({ prompt: filePath });
      const result = await buildHookPrompt(hook);
      assert.equal(result, "# Security Check\nVerify no secrets are exposed.");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("reads file content when prompt ends with .txt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hooks-test-"));
    const filePath = join(tmpDir, "check.txt");
    await writeFile(filePath, "Plain text hook prompt content");

    try {
      const hook = makeHook({ prompt: filePath });
      const result = await buildHookPrompt(hook);
      assert.equal(result, "Plain text hook prompt content");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("reads file when prompt starts with templates/", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hooks-test-"));
    const templatesDir = join(tmpDir, "templates");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(templatesDir, { recursive: true });
    const filePath = join(templatesDir, "hook-check");
    await writeFile(filePath, "Template hook content");

    try {
      // templates/ prefix triggers file read, but the actual resolution
      // uses the full path. Here we test with the full path starting with templates/.
      const hook = makeHook({ prompt: filePath });
      const result = await buildHookPrompt(hook);
      assert.equal(result, "Template hook content");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("falls back to raw string on file read failure", async () => {
    const hook = makeHook({ prompt: "/nonexistent/path/to/hook.md" });
    const result = await buildHookPrompt(hook);
    assert.equal(result, "/nonexistent/path/to/hook.md");
  });

  it("reads file when prompt starts with ./", async () => {
    // This tests the detection heuristic; actual read will fail for relative path
    // in test context, so it falls back to raw string
    const hook = makeHook({ prompt: "./hooks/validate.md" });
    const result = await buildHookPrompt(hook);
    // Falls back to raw string since the relative file doesn't exist
    assert.equal(result, "./hooks/validate.md");
  });
});

// --- parseHookResult ---

describe("parseHookResult", () => {
  it("parses clean JSON with pass: true", () => {
    const input = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.remediationActions, []);
  });

  it("parses clean JSON with pass: false and issues", () => {
    const input = JSON.stringify({
      pass: false,
      issues: ["missing tests", "no error handling"],
      remediationActions: ["add unit tests", "wrap in try/catch"],
    });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, ["missing tests", "no error handling"]);
    assert.deepEqual(result.remediationActions, ["add unit tests", "wrap in try/catch"]);
  });

  it("extracts JSON from markdown code block", () => {
    const input = `Here is my analysis:

\`\`\`json
{
  "pass": false,
  "issues": ["security vulnerability found"],
  "remediationActions": ["sanitize inputs"]
}
\`\`\`

That's my assessment.`;
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, ["security vulnerability found"]);
    assert.deepEqual(result.remediationActions, ["sanitize inputs"]);
  });

  it("extracts JSON embedded in surrounding text", () => {
    const input = `After review: {"pass": true, "issues": [], "remediationActions": []} End of review.`;
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
    assert.deepEqual(result.issues, []);
  });

  it("defaults to pass: true on unparseable output", () => {
    const result = parseHookResult("This is just plain text with no JSON");
    assert.equal(result.pass, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.remediationActions, []);
  });

  it("handles empty string gracefully", () => {
    const result = parseHookResult("");
    assert.equal(result.pass, true);
    assert.deepEqual(result.issues, []);
  });

  it("defaults pass to true when field is missing", () => {
    const input = JSON.stringify({ issues: ["something"], remediationActions: [] });
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
    assert.deepEqual(result.issues, ["something"]);
  });

  it("handles missing issues and remediationActions gracefully", () => {
    const input = JSON.stringify({ pass: false });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.remediationActions, []);
  });

  it("filters non-string items from issues array", () => {
    const input = JSON.stringify({ pass: true, issues: ["valid", 42, null, "also valid"], remediationActions: [] });
    const result = parseHookResult(input);
    assert.deepEqual(result.issues, ["valid", "also valid"]);
  });

  it("handles nested JSON with braces in values", () => {
    const input = JSON.stringify({
      pass: false,
      issues: ["config { foo: bar } is invalid"],
      remediationActions: ["fix the { config }"],
    });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0]?.includes("config"));
  });

  it("handles malformed JSON (unmatched braces)", () => {
    const input = "{ pass: true, issues: [";
    const result = parseHookResult(input);
    // Falls back to default since JSON.parse fails
    assert.equal(result.pass, true);
  });
});

// --- Blocking vs Advisory behavior ---

describe("hook blocking vs advisory behavior", () => {
  it("getHooksForTrigger returns both blocking and advisory hooks", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_confidence_met", blocking: true }),
      makeHook({ trigger: "on_confidence_met", blocking: false }),
    ];
    const ctx = makeContext();
    const result = getHooksForTrigger("on_confidence_met", hooks, ctx);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.blocking, true);
    assert.equal(result[1]?.blocking, false);
  });

  it("blocking flag is preserved through filtering", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", blocking: true, conditions: { minConfidence: 50 } }),
      makeHook({ trigger: "on_review_complete", blocking: false, conditions: { minConfidence: 50 } }),
      makeHook({ trigger: "on_review_complete", blocking: true, conditions: { minConfidence: 99 } }),
    ];
    const ctx = makeContext({ confidence: 80 });
    const result = getHooksForTrigger("on_review_complete", hooks, ctx);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.blocking, true);
    assert.equal(result[1]?.blocking, false);
  });
});

// --- Cost logging integration ---

describe("hook cost tracking", () => {
  it("parseHookResult extracts data needed for cost logging", () => {
    // The costUsd comes from invokeClaude, not from parsing.
    // This test verifies parseHookResult doesn't interfere with the HookResult
    // construction in runHook (which sets costUsd from invoke result).
    const input = JSON.stringify({ pass: true, issues: [], remediationActions: [] });
    const parsed = parseHookResult(input);
    assert.equal(parsed.pass, true);
    // HookResult.costUsd is set separately in runHook from invoke result
  });
});

// --- buildHookSystemPrompt ---

describe("buildHookSystemPrompt", () => {
  it("includes task title and description", () => {
    const ctx = makeContext({ task: makeTask({ title: "Fix login bug", description: "Users cannot log in" }) });
    const prompt = buildHookSystemPrompt(ctx);
    assert.ok(prompt.includes("Fix login bug"));
    assert.ok(prompt.includes("Users cannot log in"));
  });

  it("includes confidence percentage", () => {
    const ctx = makeContext({ confidence: 92 });
    const prompt = buildHookSystemPrompt(ctx);
    assert.ok(prompt.includes("Confidence: 92%"));
  });

  it("includes branch info", () => {
    const ctx = makeContext({ branchName: "hootl/t5-feature", baseBranch: "develop" });
    const prompt = buildHookSystemPrompt(ctx);
    assert.ok(prompt.includes("Branch: hootl/t5-feature"));
    assert.ok(prompt.includes("Base branch: develop"));
  });

  it("shows 'none' when branchName is null", () => {
    const ctx = makeContext({ branchName: null });
    const prompt = buildHookSystemPrompt(ctx);
    assert.ok(prompt.includes("Branch: none"));
  });
});

// --- runHook (with injected deps) ---

function makeMockDeps(overrides: Partial<HookDeps> = {}): HookDeps & {
  invokeCalls: Array<{ prompt: string; systemPrompt?: string }>;
  logCalls: Array<{ taskId: string; phase: string; cost: number }>;
  warnCalls: string[];
} {
  const invokeCalls: Array<{ prompt: string; systemPrompt?: string }> = [];
  const logCalls: Array<{ taskId: string; phase: string; cost: number }> = [];
  const warnCalls: string[] = [];

  return {
    invokeCalls,
    logCalls,
    warnCalls,
    invoke: overrides.invoke ?? (async (opts) => {
      invokeCalls.push({ prompt: opts.prompt, systemPrompt: opts.systemPrompt });
      return { output: '{"pass": true, "issues": [], "remediationActions": []}', costUsd: 0.01, exitCode: 0, durationMs: 100 } as InvokeResult;
    }),
    log: overrides.log ?? (async (_dir, taskId, phase, cost) => {
      logCalls.push({ taskId, phase, cost });
    }),
    warn: overrides.warn ?? ((msg: string) => {
      warnCalls.push(msg);
    }),
  };
}

describe("runHook", () => {
  it("returns success: true when invoke returns pass: true", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: '{"pass": true, "issues": [], "remediationActions": []}',
        costUsd: 0.01,
        exitCode: 0,
        durationMs: 50,
      }),
    });
    const hook = makeHook({ prompt: "Check code quality" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true);
    assert.equal(result.costUsd, 0.01);
    assert.deepEqual(result.issues, []);
  });

  it("returns success: false with issues when invoke returns pass: false", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: '{"pass": false, "issues": ["bad code", "no tests"], "remediationActions": ["add tests"]}',
        costUsd: 0.02,
        exitCode: 0,
        durationMs: 200,
      }),
    });
    const hook = makeHook({ prompt: "Validate implementation" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, false);
    assert.equal(result.costUsd, 0.02);
    assert.deepEqual(result.issues, ["bad code", "no tests"]);
    assert.deepEqual(result.remediationActions, ["add tests"]);
  });

  it("passes correct system prompt to invokeClaude", async () => {
    const deps = makeMockDeps();
    const hook = makeHook({ prompt: "Check security" });
    const ctx = makeContext({
      task: makeTask({ title: "Auth fix", description: "Fix auth bug" }),
      confidence: 85,
      branchName: "hootl/t2-auth",
      baseBranch: "main",
    });

    await runHook(hook, ctx, deps);

    assert.equal(deps.invokeCalls.length, 1);
    const call = deps.invokeCalls[0]!;
    assert.equal(call.prompt, "Check security");
    assert.ok(call.systemPrompt?.includes("Auth fix"));
    assert.ok(call.systemPrompt?.includes("Fix auth bug"));
    assert.ok(call.systemPrompt?.includes("85%"));
    assert.ok(call.systemPrompt?.includes("hootl/t2-auth"));
  });

  it("gracefully handles non-JSON invoke output (defaults to pass)", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: "I could not evaluate this hook properly.",
        costUsd: 0.005,
        exitCode: 0,
        durationMs: 80,
      }),
    });
    const hook = makeHook({ prompt: "Check quality" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true); // graceful degradation
    assert.equal(result.costUsd, 0.005);
  });

  it("preserves raw output from invoke", async () => {
    const rawOutput = 'Some preamble\n{"pass": true, "issues": []}\nSome epilogue';
    const deps = makeMockDeps({
      invoke: async () => ({
        output: rawOutput,
        costUsd: 0.01,
        exitCode: 0,
        durationMs: 100,
      }),
    });
    const hook = makeHook({ prompt: "Review" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.output, rawOutput);
  });
});

// --- runHooks (with injected deps) ---

describe("runHooks", () => {
  it("returns allPassed: true when no hooks match", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const config = ConfigSchema.parse({ hooks: [] });

    const result = await runHooks("on_confidence_met", ctx, config, deps);
    assert.equal(result.allPassed, true);
    assert.equal(result.results.length, 0);
    assert.equal(deps.invokeCalls.length, 0);
  });

  it("short-circuits on blocking hook failure", async () => {
    let callCount = 0;
    const deps = makeMockDeps({
      invoke: async () => {
        callCount++;
        return {
          output: '{"pass": false, "issues": ["critical issue"]}',
          costUsd: 0.03,
          exitCode: 0,
          durationMs: 150,
        };
      },
    });
    const ctx = makeContext();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_confidence_met", prompt: "Hook 1", blocking: true },
        { trigger: "on_confidence_met", prompt: "Hook 2", blocking: true },
      ],
    });

    const result = await runHooks("on_confidence_met", ctx, config, deps);
    assert.equal(result.allPassed, false);
    assert.equal(result.results.length, 1); // second hook never ran
    assert.equal(callCount, 1);
  });

  it("continues past advisory hook failure", async () => {
    let callCount = 0;
    const deps = makeMockDeps({
      invoke: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            output: '{"pass": false, "issues": ["minor issue"]}',
            costUsd: 0.01,
            exitCode: 0,
            durationMs: 100,
          };
        }
        return {
          output: '{"pass": true, "issues": []}',
          costUsd: 0.02,
          exitCode: 0,
          durationMs: 100,
        };
      },
    });
    const ctx = makeContext();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_blocked", prompt: "Advisory hook", blocking: false },
        { trigger: "on_blocked", prompt: "Blocking hook", blocking: true },
      ],
    });

    const result = await runHooks("on_blocked", ctx, config, deps);
    assert.equal(result.allPassed, true); // advisory failure doesn't block
    assert.equal(result.results.length, 2); // both hooks ran
    assert.equal(callCount, 2);
    assert.equal(deps.warnCalls.length, 1);
    assert.ok(deps.warnCalls[0]?.includes("Advisory hook failed"));
  });

  it("logs cost for each hook execution", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext({ task: makeTask({ id: "task-42" }) });
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_review_complete", prompt: "Hook A", blocking: false },
        { trigger: "on_review_complete", prompt: "Hook B", blocking: false },
      ],
    });

    await runHooks("on_review_complete", ctx, config, deps);
    assert.equal(deps.logCalls.length, 2);
    assert.equal(deps.logCalls[0]?.taskId, "task-42");
    assert.equal(deps.logCalls[0]?.phase, "hook:on_review_complete");
    assert.equal(deps.logCalls[0]?.cost, 0.01);
    assert.equal(deps.logCalls[1]?.taskId, "task-42");
  });

  it("only runs hooks matching the trigger point", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_confidence_met", prompt: "Match", blocking: false },
        { trigger: "on_blocked", prompt: "No match", blocking: false },
        { trigger: "on_execute_start", prompt: "No match", blocking: false },
      ],
    });

    const result = await runHooks("on_confidence_met", ctx, config, deps);
    assert.equal(result.results.length, 1);
    assert.equal(deps.invokeCalls.length, 1);
  });

  it("returns allPassed: true when all blocking hooks pass", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_execute_start", prompt: "Hook 1", blocking: true },
        { trigger: "on_execute_start", prompt: "Hook 2", blocking: true },
      ],
    });

    const result = await runHooks("on_execute_start", ctx, config, deps);
    assert.equal(result.allPassed, true);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.success));
  });

  it("warns but does not short-circuit when advisory hook has no issues text", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: '{"pass": false, "issues": []}',
        costUsd: 0.01,
        exitCode: 0,
        durationMs: 50,
      }),
    });
    const ctx = makeContext();
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_blocked", prompt: "Advisory", blocking: false },
      ],
    });

    const result = await runHooks("on_blocked", ctx, config, deps);
    assert.equal(result.allPassed, true);
    assert.equal(deps.warnCalls.length, 1);
    assert.ok(deps.warnCalls[0]?.includes("no details"));
  });
});

// --- Skill registry ---

describe("resolveSkill", () => {
  it("returns a function for the built-in 'simplify' skill", () => {
    const skill = resolveSkill("simplify");
    assert.notEqual(skill, undefined);
    assert.equal(typeof skill, "function");
  });

  it("returns undefined for an unregistered skill name", () => {
    const skill = resolveSkill("nonexistent");
    assert.equal(skill, undefined);
  });

  it("simplify skill produces invoke options with expected fields", () => {
    const ctx = makeContext({
      task: makeTask({ title: "Refactor auth", description: "Clean up auth module" }),
      branchName: "hootl/t3-refactor",
      baseBranch: "main",
    });
    const skill = resolveSkill("simplify");
    assert.notEqual(skill, undefined);
    const opts = skill!(ctx);
    assert.ok(opts.prompt.includes("reuse"));
    assert.ok(opts.prompt.includes("quality"));
    assert.ok(opts.systemPrompt?.includes("Refactor auth"));
    assert.ok(opts.systemPrompt?.includes("hootl/t3-refactor"));
    assert.equal(opts.maxTurns, 5);
  });
});

// --- runSkillHook ---

describe("runSkillHook", () => {
  it("invokes Claude with the skill's prompt for a known skill", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();

    const result = await runSkillHook("simplify", ctx, deps);
    assert.equal(result.success, true);
    assert.equal(result.costUsd, 0.01);
    assert.equal(deps.invokeCalls.length, 1);
    assert.ok(deps.invokeCalls[0]?.prompt.includes("reuse"));
  });

  it("returns failure result for an unknown skill", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();

    const result = await runSkillHook("nonexistent_skill", ctx, deps);
    assert.equal(result.success, false);
    assert.equal(result.costUsd, 0);
    assert.ok(result.issues[0]?.includes("nonexistent_skill"));
    assert.equal(deps.invokeCalls.length, 0); // should not invoke Claude
  });

  it("parses invoke output and returns issues", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: '{"pass": false, "issues": ["duplicated logic"], "remediationActions": ["extract helper"]}',
        costUsd: 0.05,
        exitCode: 0,
        durationMs: 200,
      }),
    });
    const ctx = makeContext();

    const result = await runSkillHook("simplify", ctx, deps);
    assert.equal(result.success, false);
    assert.deepEqual(result.issues, ["duplicated logic"]);
    assert.deepEqual(result.remediationActions, ["extract helper"]);
    assert.equal(result.costUsd, 0.05);
  });
});

// --- Skill-vs-prompt precedence in runHook ---

describe("runHook skill-vs-prompt precedence", () => {
  it("uses skill when hook has skill only", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const hook: Hook = makeHook({ skill: "simplify", prompt: undefined });

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true);
    // Skill's prompt includes "reuse" — verify it was used
    assert.ok(deps.invokeCalls[0]?.prompt.includes("reuse"));
  });

  it("uses prompt when hook has prompt only", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const hook: Hook = makeHook({ prompt: "Check for bugs" });

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true);
    assert.equal(deps.invokeCalls[0]?.prompt, "Check for bugs");
  });

  it("skill takes precedence when hook has both skill and prompt", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const hook: Hook = makeHook({ skill: "simplify", prompt: "This should be ignored" });

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true);
    // Should use skill's prompt, not the hook's prompt field
    assert.ok(deps.invokeCalls[0]?.prompt.includes("reuse"));
    assert.ok(!deps.invokeCalls[0]?.prompt.includes("This should be ignored"));
  });

  it("returns failure when hook has unknown skill and no prompt", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();
    const hook: Hook = makeHook({ skill: "unknown_skill", prompt: undefined });

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, false);
    assert.ok(result.issues[0]?.includes("unknown_skill"));
    assert.equal(deps.invokeCalls.length, 0);
  });
});

// --- Hook schema validation with skill field ---

describe("HookSchema with skill field", () => {
  it("accepts hook with skill only", () => {
    const config = ConfigSchema.parse({
      hooks: [{ trigger: "on_confidence_met", skill: "simplify" }],
    });
    assert.equal(config.hooks.length, 1);
    assert.equal(config.hooks[0]?.skill, "simplify");
    assert.equal(config.hooks[0]?.prompt, undefined);
  });

  it("accepts hook with prompt only", () => {
    const config = ConfigSchema.parse({
      hooks: [{ trigger: "on_blocked", prompt: "Check quality" }],
    });
    assert.equal(config.hooks.length, 1);
    assert.equal(config.hooks[0]?.prompt, "Check quality");
    assert.equal(config.hooks[0]?.skill, undefined);
  });

  it("accepts hook with both skill and prompt", () => {
    const config = ConfigSchema.parse({
      hooks: [{ trigger: "on_review_complete", skill: "simplify", prompt: "Fallback prompt" }],
    });
    assert.equal(config.hooks.length, 1);
    assert.equal(config.hooks[0]?.skill, "simplify");
    assert.equal(config.hooks[0]?.prompt, "Fallback prompt");
  });

  it("rejects hook with neither skill nor prompt", () => {
    assert.throws(() => {
      ConfigSchema.parse({
        hooks: [{ trigger: "on_confidence_met" }],
      });
    });
  });
});
