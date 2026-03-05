import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getHooksForTrigger, buildHookPrompt, parseHookResult } from "../hooks.js";
import type { HookContext } from "../hooks.js";
import type { Hook } from "../config.js";
import type { Task } from "../tasks/types.js";
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
