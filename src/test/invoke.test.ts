import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCostFromOutput,
  extractTextOutput,
  buildArgs,
  getClaudeEnv,
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

describe("extractTextOutput", () => {
  it("extracts result field from JSON format", () => {
    const raw = JSON.stringify({ result: "The answer is 42", total_cost_usd: 0.01 });
    assert.equal(extractTextOutput(raw, "json"), "The answer is 42");
  });

  it("returns raw when result field is missing in JSON format", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.01 });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns raw when result is not a string", () => {
    const raw = JSON.stringify({ result: 42, total_cost_usd: 0.01 });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns raw when result is an object", () => {
    const raw = JSON.stringify({ result: { nested: true } });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns raw when result is null", () => {
    const raw = JSON.stringify({ result: null });
    assert.equal(extractTextOutput(raw, "json"), raw);
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
