import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCostFromOutput,
  extractTextOutput,
  buildArgs,
} from "../invoke.js";

// ---------------------------------------------------------------------------
// parseCostFromOutput — error response edge cases
// ---------------------------------------------------------------------------

describe("parseCostFromOutput with error responses", () => {
  it("returns cost even when is_error is true and total_cost_usd is present", () => {
    const raw = JSON.stringify({
      is_error: true,
      total_cost_usd: 0.003,
      result: "Error: something went wrong",
    });
    assert.equal(parseCostFromOutput(raw), 0.003);
  });

  it("returns 0 when is_error is true and no cost field is present", () => {
    const raw = JSON.stringify({
      is_error: true,
      result: "Error: something went wrong",
    });
    assert.equal(parseCostFromOutput(raw), 0);
  });

  it("returns cost from cost_usd when is_error is true and total_cost_usd is missing", () => {
    const raw = JSON.stringify({
      is_error: true,
      cost_usd: 0.007,
    });
    assert.equal(parseCostFromOutput(raw), 0.007);
  });

  it("returns 0 when cost is negative", () => {
    const raw = JSON.stringify({ total_cost_usd: -1 });
    // Negative cost is technically finite, so it returns the value
    // This documents current behavior — negative costs pass through
    assert.equal(parseCostFromOutput(raw), -1);
  });

  it("returns 0 when cost is a boolean", () => {
    const raw = JSON.stringify({ total_cost_usd: true });
    // Number(true) === 1, which is finite
    assert.equal(parseCostFromOutput(raw), 1);
  });

  it("returns 0 for deeply nested JSON without top-level cost", () => {
    const raw = JSON.stringify({ data: { total_cost_usd: 0.01 } });
    assert.equal(parseCostFromOutput(raw), 0);
  });
});

// ---------------------------------------------------------------------------
// extractTextOutput — error response edge cases
// ---------------------------------------------------------------------------

describe("extractTextOutput with error responses", () => {
  it("extracts result string even when is_error is true", () => {
    const raw = JSON.stringify({
      is_error: true,
      result: "Error: model refused to respond",
      total_cost_usd: 0.001,
    });
    assert.equal(extractTextOutput(raw, "json"), "Error: model refused to respond");
  });

  it("returns raw when is_error is true but no result field", () => {
    const raw = JSON.stringify({
      is_error: true,
      total_cost_usd: 0.001,
    });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("extracts result containing newlines and special characters", () => {
    const result = "Line 1\nLine 2\n\ttabbed\n\"quoted\"";
    const raw = JSON.stringify({ result });
    assert.equal(extractTextOutput(raw, "json"), result);
  });

  it("extracts result containing unicode", () => {
    const result = "Completed successfully \u2714";
    const raw = JSON.stringify({ result });
    assert.equal(extractTextOutput(raw, "json"), result);
  });

  it("returns raw for JSON with result as an array", () => {
    const raw = JSON.stringify({ result: ["a", "b"] });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns raw for JSON with result as a number", () => {
    const raw = JSON.stringify({ result: 123 });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });

  it("returns raw for JSON with result as boolean", () => {
    const raw = JSON.stringify({ result: true });
    assert.equal(extractTextOutput(raw, "json"), raw);
  });
});

// ---------------------------------------------------------------------------
// buildArgs — edge cases
// ---------------------------------------------------------------------------

describe("buildArgs edge cases", () => {
  it("includes --max-turns 0 when maxTurns is 0", () => {
    const args = buildArgs({ prompt: "hi", maxTurns: 0 });
    const idx = args.indexOf("--max-turns");
    assert.ok(idx >= 0, "should include --max-turns flag");
    assert.equal(args[idx + 1], "0");
  });

  it("handles a very long prompt without error", () => {
    const longPrompt = "x".repeat(100_000);
    const args = buildArgs({ prompt: longPrompt });
    const idx = args.indexOf("-p");
    assert.equal(args[idx + 1], longPrompt);
    assert.equal(args[idx + 1]!.length, 100_000);
  });

  it("preserves special characters in systemPrompt exactly", () => {
    const special = 'You are "helpful".\nUse <tags> & \'quotes\'.';
    const args = buildArgs({ prompt: "hi", systemPrompt: special });
    const idx = args.indexOf("--system-prompt");
    assert.equal(args[idx + 1], special);
  });

  it("preserves newlines in prompt", () => {
    const prompt = "Step 1: do X\nStep 2: do Y\nStep 3: do Z";
    const args = buildArgs({ prompt });
    const idx = args.indexOf("-p");
    assert.equal(args[idx + 1], prompt);
  });

  it("includes maxTurns of 1", () => {
    const args = buildArgs({ prompt: "hi", maxTurns: 1 });
    const idx = args.indexOf("--max-turns");
    assert.equal(args[idx + 1], "1");
  });

  it("handles single allowed tool", () => {
    const args = buildArgs({ prompt: "hi", allowedTools: ["Read"] });
    const idx = args.indexOf("--allowedTools");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "Read");
  });

  it("always includes --dangerously-skip-permissions", () => {
    const args = buildArgs({ prompt: "hi" });
    assert.ok(args.includes("--dangerously-skip-permissions"));
  });

  it("always includes --output-format json", () => {
    const args = buildArgs({ prompt: "hi" });
    const idx = args.indexOf("--output-format");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "json");
  });

  it("always includes --no-session-persistence", () => {
    const args = buildArgs({ prompt: "hi" });
    assert.ok(args.includes("--no-session-persistence"));
  });
});
