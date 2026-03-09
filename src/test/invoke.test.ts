import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCostFromOutput,
  parseContextWindowPercent,
  extractTextOutput,
  buildArgs,
  getClaudeEnv,
  isClaudeEnvelope,
} from "../invoke.js";
import type { InvokeOptions } from "../invoke.js";

describe("parseCostFromOutput", () => {
  it("returns total_cost_usd when present", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.0042, result: "hello" });
    assert.equal(parseCostFromOutput(raw), 0.0042);
  });

  it("falls back to cost_usd when total_cost_usd is missing", () => {
    const raw = JSON.stringify({ cost_usd: 0.015, result: "hi" });
    assert.equal(parseCostFromOutput(raw), 0.015);
  });

  it("prefers total_cost_usd over cost_usd", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.01, cost_usd: 0.005 });
    assert.equal(parseCostFromOutput(raw), 0.01);
  });

  it("returns 0 when neither cost field is present", () => {
    const raw = JSON.stringify({ result: "some output" });
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("returns 0 for invalid JSON", () => {
    assert.equal(parseCostFromOutput("not json at all"), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(parseCostFromOutput(""), 0);
  });

  it("returns 0 when cost is null", () => {
    const raw = JSON.stringify({ total_cost_usd: null, cost_usd: null });
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("returns 0 when cost is NaN-producing string", () => {
    const raw = JSON.stringify({ total_cost_usd: "not-a-number" });
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("returns 0 when cost is Infinity", () => {
    const raw = JSON.stringify({ total_cost_usd: Infinity });
    // JSON.stringify converts Infinity to null, so this tests the null path
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("handles zero cost correctly", () => {
    const raw = JSON.stringify({ total_cost_usd: 0 });
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("returns 0 for JSON array (not an object)", () => {
    assert.equal(parseCostFromOutput("[1, 2, 3]"), 0);
  });

  it("returns 0 for JSON primitive", () => {
    assert.equal(parseCostFromOutput('"hello"'), 0);
  });
});

describe("parseContextWindowPercent", () => {
  it("returns context_window_percent when present", () => {
    const raw = JSON.stringify({ context_window_percent: 42, result: "hello" });
    assert.equal(parseContextWindowPercent(raw), 42);
  });

  it("returns 0 when context_window_percent is missing", () => {
    const raw = JSON.stringify({ result: "some output" });
    assert.equal(parseContextWindowPercent(raw), 0);
  });

  it("returns 0 for invalid JSON", () => {
    assert.equal(parseContextWindowPercent("not json at all"), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(parseContextWindowPercent(""), 0);
  });

  it("returns 0 when value is null", () => {
    const raw = JSON.stringify({ context_window_percent: null });
    assert.equal(parseContextWindowPercent(raw), 0);
  });

  it("returns 0 when value is NaN-producing string", () => {
    const raw = JSON.stringify({ context_window_percent: "not-a-number" });
    assert.equal(parseContextWindowPercent(raw), 0);
  });

  it("handles zero percent correctly", () => {
    const raw = JSON.stringify({ context_window_percent: 0 });
    assert.equal(parseContextWindowPercent(raw), 0);
  });

  it("handles decimal percentages", () => {
    const raw = JSON.stringify({ context_window_percent: 55.7 });
    assert.equal(parseContextWindowPercent(raw), 55.7);
  });
});

describe("extractTextOutput", () => {
  it("extracts result field from JSON format", () => {
    const raw = JSON.stringify({ result: "The answer is 42", total_cost_usd: 0.01 });
    assert.equal(extractTextOutput(raw, "json"), "The answer is 42");
  });

  it("returns empty string when result field is missing and envelope detected", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.01 });
    assert.equal(extractTextOutput(raw, "json"), "");
  });

  it("returns raw when result field is missing and not an envelope", () => {
    const raw = JSON.stringify({ someField: "hello" });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns empty string when result is non-string and envelope has cost fields", () => {
    assert.equal(extractTextOutput(JSON.stringify({ result: 42, total_cost_usd: 0.01 }), "json"), "");
    assert.equal(extractTextOutput(JSON.stringify({ result: null, total_cost_usd: 0.05 }), "json"), "");
    assert.equal(extractTextOutput(JSON.stringify({ result: false, cost_usd: 0.02 }), "json"), "");
    assert.equal(extractTextOutput(JSON.stringify({ result: { nested: true }, total_cost_usd: 0.1 }), "json"), "");
  });

  it("returns raw when result is non-string and no cost fields", () => {
    const raw1 = JSON.stringify({ result: { nested: true } });
    assert.equal(extractTextOutput(raw1, "json"), raw1);
    const raw2 = JSON.stringify({ result: null });
    assert.equal(extractTextOutput(raw2, "json"), raw2);
  });

  it("returns raw unchanged in text format", () => {
    const raw = "just plain text output";
    assert.equal(extractTextOutput(raw, "text"), "just plain text output");
  });

  it("returns raw unchanged in text format even if it looks like JSON", () => {
    const raw = JSON.stringify({ result: "hello" });
    assert.equal(extractTextOutput(raw, "text"), raw);
  });

  it("returns raw for invalid JSON in json mode", () => {
    const raw = "this is not json";
    assert.equal(extractTextOutput(raw, "json"), "this is not json");
  });

  it("returns empty string for empty input", () => {
    assert.equal(extractTextOutput("", "json"), "");
    assert.equal(extractTextOutput("", "text"), "");
  });

  it("handles result with empty string value", () => {
    const raw = JSON.stringify({ result: "" });
    assert.equal(extractTextOutput(raw, "json"), "");
  });
});

describe("buildArgs", () => {
  it("includes required flags for basic prompt", () => {
    const args = buildArgs({ prompt: "hello world" });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("hello world"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("json"));
    assert.ok(args.includes("--dangerously-skip-permissions"));
  });

  it("includes --system-prompt when systemPrompt is provided", () => {
    const args = buildArgs({ prompt: "hi", systemPrompt: "You are helpful" });
    const idx = args.indexOf("--system-prompt");
    assert.ok(idx >= 0, "should include --system-prompt flag");
    assert.equal(args[idx + 1], "You are helpful");
  });

  it("does not include --system-prompt when systemPrompt is undefined", () => {
    const args = buildArgs({ prompt: "hi" });
    assert.ok(!args.includes("--system-prompt"));
  });

  it("includes --max-turns when maxTurns is provided", () => {
    const args = buildArgs({ prompt: "hi", maxTurns: 5 });
    const idx = args.indexOf("--max-turns");
    assert.ok(idx >= 0, "should include --max-turns flag");
    assert.equal(args[idx + 1], "5");
  });

  it("does not include --max-turns when maxTurns is undefined", () => {
    const args = buildArgs({ prompt: "hi" });
    assert.ok(!args.includes("--max-turns"));
  });

  it("includes --allowedTools when allowedTools is provided", () => {
    const args = buildArgs({ prompt: "hi", allowedTools: ["Read", "Write", "Bash"] });
    const idx = args.indexOf("--allowedTools");
    assert.ok(idx >= 0, "should include --allowedTools flag");
    assert.equal(args[idx + 1], "Read,Write,Bash");
  });

  it("does not include --allowedTools when allowedTools is empty array", () => {
    const args = buildArgs({ prompt: "hi", allowedTools: [] });
    assert.ok(!args.includes("--allowedTools"));
  });

  it("does not include --allowedTools when allowedTools is undefined", () => {
    const args = buildArgs({ prompt: "hi" });
    assert.ok(!args.includes("--allowedTools"));
  });

  it("prompt is the second element after -p flag", () => {
    const args = buildArgs({ prompt: "do something" });
    const idx = args.indexOf("-p");
    assert.equal(args[idx + 1], "do something");
  });

  it("converts maxTurns to string", () => {
    const args = buildArgs({ prompt: "hi", maxTurns: 10 });
    const idx = args.indexOf("--max-turns");
    assert.equal(typeof args[idx + 1], "string");
    assert.equal(args[idx + 1], "10");
  });

  it("does not include cwd in CLI args", () => {
    const args = buildArgs({ prompt: "hi", cwd: "/tmp/worktree" });
    assert.ok(!args.includes("cwd"), "cwd should not appear as a CLI arg");
    assert.ok(!args.includes("--cwd"), "--cwd should not appear as a CLI flag");
    assert.ok(!args.includes("/tmp/worktree"), "cwd path should not appear in args");
  });
});

describe("getClaudeEnv", () => {
  it("removes CLAUDECODE from the returned env", (t) => {
    const original = process.env["CLAUDECODE"];
    process.env["CLAUDECODE"] = "1";
    t.after(() => {
      if (original === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = original;
    });

    const env = getClaudeEnv();
    assert.strictEqual(env["CLAUDECODE"], undefined);
  });

  it("removes CLAUDE_CODE_ENTRYPOINT from the returned env", (t) => {
    const original = process.env["CLAUDE_CODE_ENTRYPOINT"];
    process.env["CLAUDE_CODE_ENTRYPOINT"] = "cli";
    t.after(() => {
      if (original === undefined) delete process.env["CLAUDE_CODE_ENTRYPOINT"];
      else process.env["CLAUDE_CODE_ENTRYPOINT"] = original;
    });

    const env = getClaudeEnv();
    assert.strictEqual(env["CLAUDE_CODE_ENTRYPOINT"], undefined);
  });

  it("removes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS from the returned env", (t) => {
    const original = process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];
    process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"] = "true";
    t.after(() => {
      if (original === undefined) delete process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];
      else process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"] = original;
    });

    const env = getClaudeEnv();
    assert.strictEqual(env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], undefined);
  });

  it("preserves other environment variables", () => {
    const env = getClaudeEnv();
    // PATH and HOME are essentially always set
    assert.ok(env["PATH"] !== undefined, "PATH should be preserved");
    assert.ok(env["HOME"] !== undefined, "HOME should be preserved");
  });

  it("does not crash when nested-session vars are not set", (t) => {
    const originals = {
      CLAUDECODE: process.env["CLAUDECODE"],
      CLAUDE_CODE_ENTRYPOINT: process.env["CLAUDE_CODE_ENTRYPOINT"],
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"],
    };
    delete process.env["CLAUDECODE"];
    delete process.env["CLAUDE_CODE_ENTRYPOINT"];
    delete process.env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];
    t.after(() => {
      for (const [key, val] of Object.entries(originals)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    // Should not throw
    const env = getClaudeEnv();
    assert.strictEqual(env["CLAUDECODE"], undefined);
  });

  it("returns a copy, not the original process.env", () => {
    const env = getClaudeEnv();
    env["TEST_MUTATION"] = "mutated";
    assert.strictEqual(process.env["TEST_MUTATION"], undefined);
    delete env["TEST_MUTATION"];
  });
});

describe("isClaudeEnvelope", () => {
  it("detects old-style total_cost_usd", () => {
    assert.equal(isClaudeEnvelope({ total_cost_usd: 0.05 }), true);
  });

  it("detects old-style cost_usd", () => {
    assert.equal(isClaudeEnvelope({ cost_usd: 0.02 }), true);
  });

  it("detects new-style usage.costUSD", () => {
    assert.equal(isClaudeEnvelope({ usage: { costUSD: 0.7 } }), true);
  });

  it("detects structural markers (2+ required)", () => {
    assert.equal(isClaudeEnvelope({ uuid: "abc", permission_denials: [] }), true);
    assert.equal(isClaudeEnvelope({ uuid: "abc", errors: [] }), true);
    assert.equal(isClaudeEnvelope({ session_id: "x", fast_mode_state: "off" }), true);
  });

  it("rejects single structural marker", () => {
    assert.equal(isClaudeEnvelope({ uuid: "abc" }), false);
    assert.equal(isClaudeEnvelope({ errors: [] }), false);
  });

  it("rejects normal hook output", () => {
    assert.equal(isClaudeEnvelope({ pass: true, issues: [] }), false);
    assert.equal(isClaudeEnvelope({ passed: true, fixes_applied: [] }), false);
  });

  it("rejects empty object", () => {
    assert.equal(isClaudeEnvelope({}), false);
  });

  it("detects new-format envelope matching the real failure case", () => {
    // Reproduce the exact envelope shape from the task-080 hook failure
    const record = {
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
    };
    assert.equal(isClaudeEnvelope(record), true);
  });
});

describe("parseCostFromOutput — new format", () => {
  it("extracts cost from usage.costUSD when top-level fields missing", () => {
    const raw = JSON.stringify({
      result: null,
      usage: { inputTokens: 12, outputTokens: 5781, costUSD: 0.70895275 },
    });
    assert.equal(parseCostFromOutput(raw), 0.70895275);
  });

  it("prefers top-level total_cost_usd over usage.costUSD", () => {
    const raw = JSON.stringify({
      total_cost_usd: 0.05,
      usage: { costUSD: 0.06 },
    });
    assert.equal(parseCostFromOutput(raw), 0.05);
  });

  it("returns 0 when usage exists but has no costUSD", () => {
    const raw = JSON.stringify({
      result: "hello",
      usage: { inputTokens: 10 },
    });
    assert.equal(parseCostFromOutput(raw), 0);
  });
});

describe("extractTextOutput — new envelope format", () => {
  it("returns empty string for new-format envelope with null result", () => {
    const raw = JSON.stringify({
      result: null,
      usage: { costUSD: 0.7, inputTokens: 12 },
      uuid: "abc-123",
      permission_denials: [],
      errors: [],
    });
    assert.equal(extractTextOutput(raw, "json"), "");
  });

  it("returns empty string for new-format envelope with non-string result", () => {
    const raw = JSON.stringify({
      result: false,
      usage: { costUSD: 0.02 },
      uuid: "xyz",
      fast_mode_state: "off",
    });
    assert.equal(extractTextOutput(raw, "json"), "");
  });

  it("returns empty string for new-format envelope with no result field", () => {
    const raw = JSON.stringify({
      usage: { costUSD: 0.67, inputTokens: 12 },
      permission_denials: [],
      fast_mode_state: "off",
      uuid: "0204d2ab-9249-4de0-9c0d-0edfaab7bca8",
      errors: [],
    });
    assert.equal(extractTextOutput(raw, "json"), "");
  });

  it("extracts result string from new-format envelope", () => {
    const raw = JSON.stringify({
      result: "The code looks good",
      usage: { costUSD: 0.5 },
      uuid: "abc",
    });
    assert.equal(extractTextOutput(raw, "json"), "The code looks good");
  });
});

describe("InvokeOptions.cwd", () => {
  it("accepts cwd as an optional string field", () => {
    // Compile-time type check: cwd is accepted in InvokeOptions
    const opts: InvokeOptions = { prompt: "test", cwd: "/tmp/worktree" };
    assert.equal(opts.cwd, "/tmp/worktree");
  });

  it("allows omitting cwd", () => {
    const opts: InvokeOptions = { prompt: "test" };
    assert.equal(opts.cwd, undefined);
  });
});
