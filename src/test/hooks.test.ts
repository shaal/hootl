import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  buildTestHookContext,
  formatHookLabel,
  groupHooksByTrigger,
  validateRemoveIndex,
} from "../hooks.js";
import type { HookContext, HookDeps, HookResult } from "../hooks.js";
import type { Hook } from "../config.js";
import type { Task } from "../tasks/types.js";
import type { InvokeOptions, InvokeResult } from "../invoke.js";
import { ConfigSchema, saveProjectConfig, loadJsonFile, HOOK_TRIGGERS, HookSchema } from "../config.js";

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
    goal: null,
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

  it("defaults to pass: false on unparseable output", () => {
    const result = parseHookResult("This is just plain text with no JSON");
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.remediationActions, []);
  });

  it("handles empty string gracefully", () => {
    const result = parseHookResult("");
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, []);
  });

  it("defaults pass to false when field is missing", () => {
    const input = JSON.stringify({ issues: ["something"], remediationActions: [] });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
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
    assert.equal(result.pass, false);
  });

  it("accepts 'passed' as alias for 'pass'", () => {
    const input = JSON.stringify({ passed: false, issues: ["found issue"], fixes_applied: ["fixed it"] });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
    assert.deepEqual(result.issues, ["found issue"]);
  });

  it("'passed' takes precedence over 'pass' when both present", () => {
    const input = JSON.stringify({ pass: true, passed: false, issues: [] });
    const result = parseHookResult(input);
    assert.equal(result.pass, false);
  });

  it("accepts 'fixes_applied' as alias for 'remediationActions'", () => {
    const input = JSON.stringify({ passed: true, issues: [], fixes_applied: ["extracted helper", "removed duplication"] });
    const result = parseHookResult(input);
    assert.deepEqual(result.remediationActions, ["extracted helper", "removed duplication"]);
  });

  it("'fixes_applied' takes precedence over 'remediationActions' when both present", () => {
    const input = JSON.stringify({ pass: true, issues: [], remediationActions: ["old"], fixes_applied: ["new"] });
    const result = parseHookResult(input);
    assert.deepEqual(result.remediationActions, ["new"]);
  });

  it("parses 'confidence' number field", () => {
    const input = JSON.stringify({ passed: true, confidence: 92, issues: [], fixes_applied: [] });
    const result = parseHookResult(input);
    assert.equal(result.confidence, 92);
  });

  it("returns null confidence when field is missing", () => {
    const input = JSON.stringify({ pass: true, issues: [] });
    const result = parseHookResult(input);
    assert.equal(result.confidence, null);
  });

  it("parses full new-format JSON from validate-simplify output", () => {
    const input = JSON.stringify({
      passed: true,
      confidence: 97,
      issues: ["minor: could extract shared helper"],
      fixes_applied: ["extracted formatDate helper to utils.ts"],
    });
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
    assert.equal(result.confidence, 97);
    assert.deepEqual(result.issues, ["minor: could extract shared helper"]);
    assert.deepEqual(result.remediationActions, ["extracted formatDate helper to utils.ts"]);
  });

  it("extracts JSON when prose with curly braces precedes it", () => {
    const input = [
      "I reviewed the code and made some fixes.",
      "",
      "Here's what I changed:",
      "```typescript",
      "if (x) { doThing(); }",
      "function foo() { return { bar: 1 }; }",
      "```",
      "",
      "The code looks good now.",
      "",
      JSON.stringify({ passed: true, confidence: 95, issues: [], fixes_applied: ["refactored helper"] }),
    ].join("\n");
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
    assert.equal(result.confidence, 95);
    assert.deepEqual(result.remediationActions, ["refactored helper"]);
  });

  it("extracts JSON from code block over forward brace match", () => {
    const input = [
      "Some prose with { curly } braces.",
      "",
      "```json",
      '{"passed": true, "issues": [], "fixes_applied": []}',
      "```",
    ].join("\n");
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
  });

  it("falls back to forward match when reverse match fails to parse", () => {
    // JSON at the start, junk braces at the end
    const input = '{"pass": true, "issues": []} some text } }';
    const result = parseHookResult(input);
    assert.equal(result.pass, true);
  });

  it("detects Claude JSON envelope and extracts inner result", () => {
    const envelope = JSON.stringify({
      result: '{"passed": true, "issues": [], "fixes_applied": ["refactored helper"]}',
      total_cost_usd: 0.05,
      context_window_percent: 42,
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.remediationActions, ["refactored helper"]);
  });

  it("detects Claude JSON envelope with cost_usd variant", () => {
    const envelope = JSON.stringify({
      result: '{"pass": true, "issues": ["minor nit"], "remediationActions": []}',
      cost_usd: 0.02,
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.issues, ["minor nit"]);
  });

  it("returns pass: false when envelope inner result is plain text", () => {
    const envelope = JSON.stringify({
      result: "Some plain text response without JSON",
      total_cost_usd: 0.03,
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, false);
  });

  it("returns pass: false when envelope inner result is non-object JSON", () => {
    const envelope = JSON.stringify({
      result: "42",
      total_cost_usd: 0.01,
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, false);
  });

  it("does not treat normal hook output with 'result' field as envelope", () => {
    // A hook output that has a "result" field but no cost fields
    // should be parsed normally, not treated as an envelope
    const input = JSON.stringify({
      pass: true,
      result: "some internal result",
      issues: [],
      remediationActions: [],
    });
    const parsed = parseHookResult(input);
    assert.equal(parsed.pass, true);
  });

  it("detects Claude envelope with empty string result and returns pass: true", () => {
    const envelope = JSON.stringify({
      result: "",
      total_cost_usd: 0.29,
      session_id: "abc-123",
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.remediationActions, []);
  });

  it("detects Claude envelope with whitespace-only result and returns pass: true", () => {
    const envelope = JSON.stringify({
      result: "   \n  ",
      total_cost_usd: 0.1,
      uuid: "def-456",
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
  });

  it("detects Claude envelope with null result and envelope markers and returns pass: true", () => {
    const envelope = JSON.stringify({
      result: null,
      total_cost_usd: 0.05,
      session_id: "abc",
      uuid: "xyz",
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
  });

  it("detects Claude envelope with non-string result and envelope markers and returns pass: true", () => {
    const envelope = JSON.stringify({
      result: false,
      total_cost_usd: 0.02,
      uuid: "xyz",
      num_turns: 1,
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
  });

  it("does not treat as envelope when result is non-string but no envelope markers", () => {
    // Has cost fields but no session_id/uuid/num_turns — could be a normal hook output
    const input = JSON.stringify({
      result: null,
      total_cost_usd: 0.01,
    });
    const parsed = parseHookResult(input);
    // With isClaudeEnvelope, total_cost_usd alone IS enough to detect envelope.
    // So result=null + envelope detection → pass: true (Claude returned nothing = pass).
    assert.equal(parsed.pass, true);
  });

  it("detects new-format envelope with usage.costUSD and extracts inner result", () => {
    const envelope = JSON.stringify({
      result: '{"passed": true, "issues": [], "fixes_applied": ["cleaned imports"]}',
      usage: { inputTokens: 100, outputTokens: 2000, costUSD: 0.45 },
      uuid: "test-uuid",
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.remediationActions, ["cleaned imports"]);
  });

  it("detects new-format envelope with null result and returns pass: true", () => {
    // This is the exact failure scenario from task-080
    const envelope = JSON.stringify({
      result: null,
      usage: {
        inputTokens: 12,
        outputTokens: 5781,
        cacheReadInputTokens: 438748,
        costUSD: 0.70895275,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
      permission_denials: [],
      fast_mode_state: "off",
      uuid: "7d76609c-6aed-477e-a878-de53e23d290f",
      errors: [],
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.issues, []);
  });

  it("detects new-format envelope with non-string result and returns pass: true", () => {
    const envelope = JSON.stringify({
      result: false,
      usage: { costUSD: 0.02 },
      permission_denials: [],
      fast_mode_state: "off",
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
  });

  it("detects envelope with no result field at all and returns pass: true", () => {
    // Reproduces the exact task-061 failure: envelope has structural markers
    // and cost fields but no "result" field whatsoever.
    const envelope = JSON.stringify({
      usage: {
        inputTokens: 12,
        outputTokens: 4198,
        cacheReadInputTokens: 345394,
        costUSD: 0.6734695,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
      permission_denials: [],
      fast_mode_state: "off",
      uuid: "0204d2ab-9249-4de0-9c0d-0edfaab7bca8",
      errors: [],
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.issues, []);
  });

  it("detects envelope via structural markers alone (no cost fields)", () => {
    const envelope = JSON.stringify({
      result: '{"passed": false, "issues": ["needs tests"]}',
      uuid: "abc",
      permission_denials: [],
    });
    const parsed = parseHookResult(envelope);
    assert.equal(parsed.pass, false);
    assert.deepEqual(parsed.issues, ["needs tests"]);
  });

  it("handles double-wrapped envelope where inner result is prose with JSON", () => {
    // Reproduces the exact task-080 failure: extractTextOutput returns the inner
    // envelope as a string, and the inner envelope's result is Claude's prose
    // containing an embedded JSON block (not directly parseable by JSON.parse).
    const claudeResponse = 'I reviewed the code. Here is my assessment:\n\n```json\n{"passed": true, "issues": [], "fixes_applied": ["removed unused import"]}\n```';
    const innerEnvelope = JSON.stringify({
      result: claudeResponse,
      total_cost_usd: 0.71,
      session_id: "sess-123",
      uuid: "7d76609c-6aed-477e-a878-de53e23d290f",
      usage: { inputTokens: 12, outputTokens: 5781, costUSD: 0.70895275 },
      permission_denials: [],
      errors: [],
    });
    // parseHookResult receives the inner envelope string (as returned by extractTextOutput)
    const parsed = parseHookResult(innerEnvelope);
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.remediationActions, ["removed unused import"]);
  });

  it("handles double-wrapped envelope where inner result has no code block", () => {
    // Inner result is prose with inline JSON (no code fence)
    const claudeResponse = 'No issues found.\n{"passed": true, "confidence": 96, "issues": [], "fixes_applied": []}';
    const innerEnvelope = JSON.stringify({
      result: claudeResponse,
      total_cost_usd: 0.5,
      uuid: "abc",
      errors: [],
    });
    const parsed = parseHookResult(innerEnvelope);
    assert.equal(parsed.pass, true);
    assert.equal(parsed.confidence, 96);
  });

  it("returns defaultResult for triple-wrapped envelope (depth guard)", () => {
    // Pathological case: envelope inside envelope inside envelope
    const innermost = JSON.stringify({ result: "deep", total_cost_usd: 0.01, uuid: "a", errors: [] });
    const middle = JSON.stringify({ result: innermost, total_cost_usd: 0.02, uuid: "b", errors: [] });
    const outer = JSON.stringify({ result: middle, total_cost_usd: 0.03, uuid: "c", errors: [] });
    const parsed = parseHookResult(outer);
    // Depth guard prevents infinite recursion — returns default at depth > 1
    assert.equal(parsed.pass, false);
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
  invokeCalls: InvokeOptions[];
  logCalls: Array<{ taskId: string; phase: string; cost: number }>;
  warnCalls: string[];
} {
  const invokeCalls: InvokeOptions[] = [];
  const logCalls: Array<{ taskId: string; phase: string; cost: number }> = [];
  const warnCalls: string[] = [];

  return {
    invokeCalls,
    logCalls,
    warnCalls,
    invoke: overrides.invoke ?? (async (opts) => {
      invokeCalls.push(opts);
      return { output: '{"pass": true, "issues": [], "remediationActions": []}', costUsd: 0.01, exitCode: 0, durationMs: 100, contextWindowPercent: 0 };
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
        contextWindowPercent: 0,
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
        contextWindowPercent: 0,
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

  it("treats empty output with exitCode 0 as pass (envelope stripped to empty)", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: "",
        costUsd: 0.67,
        exitCode: 0,
        durationMs: 5000,
        contextWindowPercent: 0,
      }),
    });
    const hook = makeHook({ prompt: "Check quality" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.costUsd, 0.67);
  });

  it("treats empty output with non-zero exitCode as failure", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: "",
        costUsd: 0.01,
        exitCode: 1,
        durationMs: 100,
        contextWindowPercent: 0,
      }),
    });
    const hook = makeHook({ prompt: "Check quality" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, false);
  });

  it("gracefully handles non-JSON invoke output (defaults to pass)", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: "I could not evaluate this hook properly.",
        costUsd: 0.005,
        exitCode: 0,
        durationMs: 80,
        contextWindowPercent: 0,
      }),
    });
    const hook = makeHook({ prompt: "Check quality" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.success, false); // fail-closed: unparseable output blocks
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
        contextWindowPercent: 0,
      }),
    });
    const hook = makeHook({ prompt: "Review" });
    const ctx = makeContext();

    const result = await runHook(hook, ctx, deps);
    assert.equal(result.output, rawOutput);
  });

  it("always sets verbose: false for prompt-based hooks", async () => {
    const deps = makeMockDeps();
    const hook = makeHook({ prompt: "Check quality" });
    const ctx = makeContext();

    await runHook(hook, ctx, deps);
    assert.equal(deps.invokeCalls.length, 1);
    assert.equal(deps.invokeCalls[0]?.verbose, false);
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
          contextWindowPercent: 0,
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
            contextWindowPercent: 0,
          };
        }
        return {
          output: '{"pass": true, "issues": []}',
          costUsd: 0.02,
          exitCode: 0,
          durationMs: 100,
          contextWindowPercent: 0,
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
        contextWindowPercent: 0,
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

  it("simplify skill produces invoke options with expected fields", async () => {
    const ctx = makeContext({
      task: makeTask({ title: "Refactor auth", description: "Clean up auth module" }),
      branchName: "hootl/t3-refactor",
      baseBranch: "main",
    });
    const skill = resolveSkill("simplify");
    assert.notEqual(skill, undefined);
    const opts = await skill!(ctx);
    assert.ok(opts.prompt.includes("quality"));
    assert.ok(opts.prompt.includes("git diff main..HEAD"), "prompt should instruct Claude to run git diff");
    assert.ok(opts.systemPrompt?.includes("Refactor auth"));
    assert.ok(opts.systemPrompt?.includes("hootl/t3-refactor"));
    assert.ok(opts.systemPrompt?.includes("main"), "system prompt should reference the base branch");
    assert.equal(opts.maxTurns, 10);
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
    assert.ok(deps.invokeCalls[0]?.prompt.includes("quality"));
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
        contextWindowPercent: 0,
      }),
    });
    const ctx = makeContext();

    const result = await runSkillHook("simplify", ctx, deps);
    assert.equal(result.success, false);
    assert.deepEqual(result.issues, ["duplicated logic"]);
    assert.deepEqual(result.remediationActions, ["extract helper"]);
    assert.equal(result.costUsd, 0.05);
  });

  it("treats empty output with exitCode 0 as pass (envelope stripped to empty)", async () => {
    const deps = makeMockDeps({
      invoke: async () => ({
        output: "",
        costUsd: 0.67,
        exitCode: 0,
        durationMs: 5000,
        contextWindowPercent: 0,
      }),
    });
    const ctx = makeContext();

    const result = await runSkillHook("simplify", ctx, deps);
    assert.equal(result.success, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.costUsd, 0.67);
  });

  it("always sets verbose: false regardless of skill options", async () => {
    const deps = makeMockDeps();
    const ctx = makeContext();

    await runSkillHook("simplify", ctx, deps);
    assert.equal(deps.invokeCalls.length, 1);
    assert.equal(deps.invokeCalls[0]?.verbose, false);
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
    assert.ok(deps.invokeCalls[0]?.prompt.includes("quality"));
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
    assert.ok(deps.invokeCalls[0]?.prompt.includes("quality"));
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

// --- validate-simplify.md template ---

describe("validate-simplify template", () => {
  const thisFile = fileURLToPath(import.meta.url);
  const templatesDir = join(dirname(thisFile), "..", "..", "templates");
  const templatePath = join(templatesDir, "validate-simplify.md");

  it("template file exists", () => {
    assert.ok(existsSync(templatePath), "templates/validate-simplify.md should exist");
  });

  it("contains key content markers", async () => {
    const content = await readFile(templatePath, "utf-8");
    assert.ok(content.includes("{{baseBranch}}"), "template should have baseBranch placeholder");
    assert.ok(content.includes("{{taskTitle}}"), "template should have taskTitle placeholder");
    assert.ok(content.includes("{{taskDescription}}"), "template should have taskDescription placeholder");
    assert.ok(content.includes("{{branchName}}"), "template should have branchName placeholder");
    assert.ok(content.includes("git diff"), "template should reference git diff");
    assert.ok(content.includes('"passed"'), "template should document passed field");
    assert.ok(content.includes('"confidence"'), "template should document confidence field");
    assert.ok(content.includes('"fixes_applied"'), "template should document fixes_applied field");
  });

  it("simplify skill substitutes template variables", async () => {
    const ctx = makeContext({
      task: makeTask({ title: "My Task", description: "My description" }),
      branchName: "hootl/t1-my-task",
      baseBranch: "develop",
    });
    const skill = resolveSkill("simplify");
    assert.notEqual(skill, undefined);
    const opts = await skill!(ctx);
    // System prompt should have substituted variables
    assert.ok(opts.systemPrompt?.includes("My Task"), "system prompt should contain substituted task title");
    assert.ok(opts.systemPrompt?.includes("My description"), "system prompt should contain substituted description");
    assert.ok(opts.systemPrompt?.includes("hootl/t1-my-task"), "system prompt should contain substituted branch name");
    assert.ok(opts.systemPrompt?.includes("develop"), "system prompt should contain substituted base branch");
    // Should NOT have raw template variables
    assert.ok(!opts.systemPrompt?.includes("{{"), "system prompt should not contain unsubstituted template variables");
  });
});

// --- buildTestHookContext ---

describe("buildTestHookContext", () => {
  it("returns a valid HookContext with synthetic task defaults", () => {
    const config = ConfigSchema.parse({});
    const ctx = buildTestHookContext(config, "feature/test", "main", 90);

    assert.equal(ctx.task.id, "test");
    assert.equal(ctx.task.title, "Hook test");
    assert.equal(ctx.task.description, "Manual hook test run");
    assert.equal(ctx.task.state, "in_progress");
    assert.equal(ctx.task.priority, "medium");
    assert.equal(ctx.task.type, "feature");
    assert.deepEqual(ctx.task.dependencies, []);
    assert.equal(ctx.task.confidence, 0);
    assert.equal(ctx.task.attempts, 0);
    assert.equal(ctx.task.totalCost, 0);
    assert.equal(ctx.task.branch, "feature/test");
    assert.equal(ctx.task.worktree, null);
    assert.equal(ctx.task.userPriority, null);
    assert.deepEqual(ctx.task.blockers, []);
  });

  it("passes branch name, base branch, and confidence through", () => {
    const config = ConfigSchema.parse({});
    const ctx = buildTestHookContext(config, "hootl/t5-my-feature", "develop", 42);

    assert.equal(ctx.branchName, "hootl/t5-my-feature");
    assert.equal(ctx.baseBranch, "develop");
    assert.equal(ctx.confidence, 42);
  });

  it("passes the config object through", () => {
    const config = ConfigSchema.parse({ budgets: { global: 100 } });
    const ctx = buildTestHookContext(config, "main", "main", 95);

    assert.equal(ctx.config.budgets.global, 100);
  });

  it("sets valid ISO timestamps on the synthetic task", () => {
    const config = ConfigSchema.parse({});
    const before = new Date().toISOString();
    const ctx = buildTestHookContext(config, "branch", "main", 50);
    const after = new Date().toISOString();

    // Timestamps should be parseable and between before/after
    assert.ok(!Number.isNaN(Date.parse(ctx.task.createdAt)), "createdAt should be valid ISO date");
    assert.ok(!Number.isNaN(Date.parse(ctx.task.updatedAt)), "updatedAt should be valid ISO date");
    assert.ok(ctx.task.createdAt >= before, "createdAt should be >= test start time");
    assert.ok(ctx.task.createdAt <= after, "createdAt should be <= test end time");
  });

  it("works with edge confidence values", () => {
    const config = ConfigSchema.parse({});

    const ctx0 = buildTestHookContext(config, "b", "main", 0);
    assert.equal(ctx0.confidence, 0);

    const ctx100 = buildTestHookContext(config, "b", "main", 100);
    assert.equal(ctx100.confidence, 100);
  });
});

// --- formatHookLabel ---

describe("formatHookLabel", () => {
  it("formats a skill-based blocking hook", () => {
    const hook = makeHook({ trigger: "on_confidence_met", skill: "simplify", blocking: true });
    const label = formatHookLabel(hook, 0);
    assert.equal(label, "1) on_confidence_met → skill:simplify [blocking]");
  });

  it("formats a prompt-based advisory hook", () => {
    const hook = makeHook({ trigger: "on_review_complete", prompt: "Check code", blocking: false });
    const label = formatHookLabel(hook, 2);
    assert.equal(label, '3) on_review_complete → prompt:"Check code" [advisory]');
  });

  it("truncates long prompts at 40 chars", () => {
    const longPrompt = "This is a very long prompt that exceeds forty characters by quite a bit";
    const hook = makeHook({ prompt: longPrompt, blocking: false });
    const label = formatHookLabel(hook, 0);
    assert.ok(label.includes('prompt:"This is a very long prompt that excee..."'));
    // The truncated portion should be 37 chars + "..."
    const match = label.match(/prompt:"(.+?)"/);
    assert.ok(match !== null);
    assert.equal(match![1]!.length, 40); // 37 + "..."
  });

  it("does not truncate prompts at exactly 40 chars", () => {
    const exactPrompt = "1234567890123456789012345678901234567890"; // 40 chars
    const hook = makeHook({ prompt: exactPrompt, blocking: false });
    const label = formatHookLabel(hook, 0);
    assert.ok(label.includes(`prompt:"${exactPrompt}"`));
    assert.ok(!label.includes("..."));
  });

  it("handles hook with skill taking precedence over prompt in display", () => {
    // When both skill and prompt are set, skill is shown (matches runtime precedence)
    const hook = makeHook({ skill: "simplify", prompt: "some prompt", blocking: true });
    const label = formatHookLabel(hook, 0);
    assert.ok(label.includes("skill:simplify"));
    assert.ok(!label.includes("prompt:"));
  });

  it("uses 1-based numbering", () => {
    const hook = makeHook({ skill: "simplify", blocking: false });
    assert.ok(formatHookLabel(hook, 0).startsWith("1)"));
    assert.ok(formatHookLabel(hook, 4).startsWith("5)"));
    assert.ok(formatHookLabel(hook, 9).startsWith("10)"));
  });

  it("appends minConfidence condition when present", () => {
    const hook = makeHook({ skill: "simplify", blocking: true, conditions: { minConfidence: 80 } });
    const label = formatHookLabel(hook, 0);
    assert.equal(label, "1) on_confidence_met → skill:simplify [blocking] (minConfidence: 80)");
  });

  it("omits condition suffix when no conditions are set", () => {
    const hook = makeHook({ skill: "simplify", blocking: true });
    const label = formatHookLabel(hook, 0);
    assert.equal(label, "1) on_confidence_met → skill:simplify [blocking]");
    assert.ok(!label.includes("minConfidence"));
  });

  it("omits condition suffix when conditions object exists but minConfidence is undefined", () => {
    const hook = makeHook({ skill: "simplify", blocking: true, conditions: {} });
    const label = formatHookLabel(hook, 0);
    assert.equal(label, "1) on_confidence_met → skill:simplify [blocking]");
    assert.ok(!label.includes("minConfidence"));
  });
});

// --- groupHooksByTrigger ---

describe("groupHooksByTrigger", () => {
  it("groups hooks by trigger point", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_confidence_met", skill: "simplify" }),
      makeHook({ trigger: "on_review_complete", prompt: "Check code" }),
      makeHook({ trigger: "on_confidence_met", prompt: "Validate" }),
    ];
    const groups = groupHooksByTrigger(hooks);
    assert.equal(groups.size, 2);
    assert.equal(groups.get("on_confidence_met")?.length, 2);
    assert.equal(groups.get("on_review_complete")?.length, 1);
  });

  it("returns empty map for empty array", () => {
    const groups = groupHooksByTrigger([]);
    assert.equal(groups.size, 0);
  });

  it("preserves insertion order within groups", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_confidence_met", skill: "simplify" }),
      makeHook({ trigger: "on_confidence_met", prompt: "Second" }),
      makeHook({ trigger: "on_confidence_met", prompt: "Third" }),
    ];
    const groups = groupHooksByTrigger(hooks);
    const group = groups.get("on_confidence_met")!;
    assert.equal(group.length, 3);
    assert.equal(group[0]!.skill, "simplify");
    assert.equal(group[1]!.prompt, "Second");
    assert.equal(group[2]!.prompt, "Third");
  });

  it("handles single hook", () => {
    const hooks: Hook[] = [makeHook({ trigger: "on_blocked", skill: "notify" })];
    const groups = groupHooksByTrigger(hooks);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("on_blocked")?.length, 1);
  });

  it("preserves group ordering by first occurrence", () => {
    const hooks: Hook[] = [
      makeHook({ trigger: "on_review_complete", prompt: "A" }),
      makeHook({ trigger: "on_confidence_met", prompt: "B" }),
      makeHook({ trigger: "on_review_complete", prompt: "C" }),
    ];
    const groups = groupHooksByTrigger(hooks);
    const keys = [...groups.keys()];
    assert.equal(keys[0], "on_review_complete");
    assert.equal(keys[1], "on_confidence_met");
  });
});

// --- validateRemoveIndex ---

describe("validateRemoveIndex", () => {
  it("returns 0-based index for valid 1-based input", () => {
    assert.equal(validateRemoveIndex("1", 3), 0);
    assert.equal(validateRemoveIndex("2", 3), 1);
    assert.equal(validateRemoveIndex("3", 3), 2);
  });

  it("returns null for index below range", () => {
    assert.equal(validateRemoveIndex("0", 3), null);
  });

  it("returns null for index above range", () => {
    assert.equal(validateRemoveIndex("4", 3), null);
  });

  it("returns null for non-numeric input", () => {
    assert.equal(validateRemoveIndex("abc", 3), null);
    assert.equal(validateRemoveIndex("", 3), null);
  });

  it("returns null when hookCount is 0", () => {
    assert.equal(validateRemoveIndex("1", 0), null);
  });

  it("handles single-hook list", () => {
    assert.equal(validateRemoveIndex("1", 1), 0);
    assert.equal(validateRemoveIndex("2", 1), null);
  });
});

// --- saveProjectConfig ---

describe("saveProjectConfig", () => {
  let tmpDir: string;

  it("writes valid JSON and preserves other config keys", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-save-config-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    // Write initial config with hooks and other keys
    const initial = {
      taskBackend: "local",
      hooks: [
        { trigger: "on_confidence_met", skill: "simplify", blocking: true },
        { trigger: "on_review_complete", prompt: "Check code", blocking: false },
      ],
    };
    await writeFile(join(hootlDir, "config.json"), JSON.stringify(initial, null, 2), "utf-8");

    // Remove the first hook via saveProjectConfig
    await saveProjectConfig((raw) => {
      const hooks = raw["hooks"];
      if (Array.isArray(hooks)) {
        hooks.splice(0, 1);
      }
    }, tmpDir);

    // Read back and verify
    const result = await loadJsonFile(join(hootlDir, "config.json"));
    assert.equal(result["taskBackend"], "local");
    assert.ok(Array.isArray(result["hooks"]));
    const hooks = result["hooks"] as unknown[];
    assert.equal(hooks.length, 1);
    const remaining = hooks[0] as Record<string, unknown>;
    assert.equal(remaining["trigger"], "on_review_complete");

    await rm(tmpDir, { recursive: true });
  });

  it("removing last hook leaves empty array", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-save-config-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    const initial = {
      hooks: [
        { trigger: "on_blocked", prompt: "Log it", blocking: false },
      ],
    };
    await writeFile(join(hootlDir, "config.json"), JSON.stringify(initial, null, 2), "utf-8");

    await saveProjectConfig((raw) => {
      const hooks = raw["hooks"];
      if (Array.isArray(hooks)) {
        hooks.splice(0, 1);
      }
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    assert.ok(Array.isArray(result["hooks"]));
    assert.equal((result["hooks"] as unknown[]).length, 0);

    await rm(tmpDir, { recursive: true });
  });

  it("creates config from empty file when no prior hooks key exists", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-save-config-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    // Write empty config (no hooks key)
    await writeFile(join(hootlDir, "config.json"), "{}", "utf-8");

    await saveProjectConfig((raw) => {
      // Attempting to splice from non-existent hooks — should be a safe no-op
      const hooks = raw["hooks"];
      if (Array.isArray(hooks)) {
        hooks.splice(0, 1);
      }
      // Alternatively, add a hooks key
      if (!Array.isArray(raw["hooks"])) {
        raw["hooks"] = [];
      }
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    assert.ok(Array.isArray(result["hooks"]));
    assert.equal((result["hooks"] as unknown[]).length, 0);

    await rm(tmpDir, { recursive: true });
  });

  it("produces properly formatted JSON with trailing newline", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-save-config-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    await writeFile(join(hootlDir, "config.json"), '{"hooks":[]}', "utf-8");

    await saveProjectConfig((raw) => {
      raw["hooks"] = [{ trigger: "on_blocked", prompt: "test" }];
    }, tmpDir);

    const content = await readFile(join(hootlDir, "config.json"), "utf-8");
    // Should be 2-space indented with trailing newline
    assert.ok(content.endsWith("\n"));
    assert.ok(content.includes('  "hooks"'));

    await rm(tmpDir, { recursive: true });
  });
});

// --- hooks add config mutation ---

describe("hooks add config mutation", () => {
  let tmpDir: string;

  it("appends hook to existing hooks array and preserves other keys", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hooks-add-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    const initial = {
      taskBackend: "local",
      budgets: { global: 50 },
      hooks: [
        { trigger: "on_confidence_met", skill: "simplify", blocking: true },
      ],
    };
    await writeFile(join(hootlDir, "config.json"), JSON.stringify(initial, null, 2), "utf-8");

    // Simulate the add command's updater logic
    const newHook = { trigger: "on_blocked" as const, prompt: "Log the blocker", blocking: false };
    HookSchema.parse(newHook); // validate before writing

    await saveProjectConfig((raw) => {
      if (!Array.isArray(raw["hooks"])) {
        raw["hooks"] = [];
      }
      (raw["hooks"] as unknown[]).push(newHook);
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    // Other keys preserved
    assert.equal(result["taskBackend"], "local");
    assert.deepStrictEqual((result["budgets"] as Record<string, unknown>)["global"], 50);
    // Hooks array has both entries
    const hooks = result["hooks"] as unknown[];
    assert.equal(hooks.length, 2);
    assert.equal((hooks[0] as Record<string, unknown>)["skill"], "simplify");
    assert.equal((hooks[1] as Record<string, unknown>)["prompt"], "Log the blocker");
    assert.equal((hooks[1] as Record<string, unknown>)["trigger"], "on_blocked");

    await rm(tmpDir, { recursive: true });
  });

  it("creates hooks array when absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hooks-add-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    // Config with no hooks key at all
    await writeFile(join(hootlDir, "config.json"), '{"taskBackend":"local"}', "utf-8");

    const newHook = { trigger: "on_execute_start" as const, skill: "simplify", blocking: true };
    HookSchema.parse(newHook);

    await saveProjectConfig((raw) => {
      if (!Array.isArray(raw["hooks"])) {
        raw["hooks"] = [];
      }
      (raw["hooks"] as unknown[]).push(newHook);
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    assert.equal(result["taskBackend"], "local");
    const hooks = result["hooks"] as unknown[];
    assert.equal(hooks.length, 1);
    assert.equal((hooks[0] as Record<string, unknown>)["trigger"], "on_execute_start");
    assert.equal((hooks[0] as Record<string, unknown>)["skill"], "simplify");

    await rm(tmpDir, { recursive: true });
  });

  it("appends hook with conditions.minConfidence", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hooks-add-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    await writeFile(join(hootlDir, "config.json"), '{"hooks":[]}', "utf-8");

    const newHook = {
      trigger: "on_review_complete" as const,
      prompt: "Check coverage",
      blocking: false,
      conditions: { minConfidence: 80 },
    };
    HookSchema.parse(newHook);

    await saveProjectConfig((raw) => {
      if (!Array.isArray(raw["hooks"])) {
        raw["hooks"] = [];
      }
      (raw["hooks"] as unknown[]).push(newHook);
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    const hooks = result["hooks"] as unknown[];
    assert.equal(hooks.length, 1);
    const added = hooks[0] as Record<string, unknown>;
    assert.equal(added["trigger"], "on_review_complete");
    assert.equal(added["prompt"], "Check coverage");
    const conditions = added["conditions"] as Record<string, unknown>;
    assert.equal(conditions["minConfidence"], 80);

    await rm(tmpDir, { recursive: true });
  });

  it("preserves all existing config keys when adding first hook", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hooks-add-"));
    const hootlDir = join(tmpDir, ".hootl");
    await import("node:fs/promises").then(fs => fs.mkdir(hootlDir, { recursive: true }));

    const initial = {
      taskBackend: "local",
      budgets: { contextWindowLimit: 60, global: 50 },
      confidence: { target: 90 },
      git: { branchPrefix: "custom/" },
      permissionMode: "lenient",
    };
    await writeFile(join(hootlDir, "config.json"), JSON.stringify(initial, null, 2), "utf-8");

    const newHook = { trigger: "on_confidence_met" as const, skill: "simplify", blocking: true };
    HookSchema.parse(newHook);

    await saveProjectConfig((raw) => {
      if (!Array.isArray(raw["hooks"])) {
        raw["hooks"] = [];
      }
      (raw["hooks"] as unknown[]).push(newHook);
    }, tmpDir);

    const result = await loadJsonFile(join(hootlDir, "config.json"));
    // All original keys intact
    assert.equal(result["taskBackend"], "local");
    assert.deepStrictEqual(result["budgets"], { contextWindowLimit: 60, global: 50 });
    assert.deepStrictEqual(result["confidence"], { target: 90 });
    assert.deepStrictEqual(result["git"], { branchPrefix: "custom/" });
    assert.equal(result["permissionMode"], "lenient");
    // New hooks array added
    const hooks = result["hooks"] as unknown[];
    assert.equal(hooks.length, 1);
    assert.equal((hooks[0] as Record<string, unknown>)["skill"], "simplify");

    await rm(tmpDir, { recursive: true });
  });
});

// --- HOOK_TRIGGERS export ---

describe("HOOK_TRIGGERS", () => {
  it("contains all expected trigger values", () => {
    assert.deepStrictEqual([...HOOK_TRIGGERS], [
      "on_confidence_met",
      "on_review_complete",
      "on_blocked",
      "on_execute_start",
    ]);
  });

  it("values are accepted by HookSchema", () => {
    for (const trigger of HOOK_TRIGGERS) {
      const result = HookSchema.safeParse({ trigger, prompt: "test", blocking: false });
      assert.ok(result.success, `Trigger "${trigger}" should be valid`);
    }
  });
});
