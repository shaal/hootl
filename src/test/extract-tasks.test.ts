import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTaskArray } from "../index.js";

describe("extractTaskArray", () => {
  const validJson = JSON.stringify([
    { title: "Task 1", description: "Do something", priority: "high" },
    { title: "Task 2", description: "Do another thing", priority: "medium", dependsOn: [0] },
  ]);

  it("parses a clean JSON array", () => {
    const result = extractTaskArray(validJson);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.title, "Task 1");
    assert.deepEqual(result[1]?.dependsOn, [0]);
  });

  it("extracts JSON from a markdown code block", () => {
    const output = "Here are the tasks:\n\n```json\n" + validJson + "\n```\n\nLet me know if you want changes.";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.title, "Task 1");
  });

  it("extracts JSON from a code block without json tag", () => {
    const output = "```\n" + validJson + "\n```";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
  });

  it("handles preamble text before JSON (no code block)", () => {
    const output = "I analyzed the codebase. Here is my plan:\n\n" + validJson;
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
  });

  it("handles [bracketed] prose after JSON — the original bug", () => {
    const output =
      "Here's the plan:\n\n```json\n" +
      validJson +
      "\n```\n\n" +
      "★ Insight\n" +
      "- The [task-XXX] prefix is preserved for traceability.\n" +
      "- Using [git diff --cached] keeps the message grounded.\n";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.title, "Task 1");
  });

  it("handles [bracketed] prose after JSON without code fences", () => {
    const output =
      "Plan:\n" +
      validJson +
      "\n\nNote: [task-001] and [task-002] will be worked on in order.";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
  });

  it("handles [bracketed] prose BEFORE the JSON array", () => {
    // Bracket-matching latches onto the first '[' which is in "[Note]", but that
    // won't parse as valid JSON. The greedy fallback or code block should still work.
    const output = "[Note: here are the tasks]\n\n```json\n" + validJson + "\n```";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 2);
  });

  it("handles descriptions containing brackets and escaped quotes", () => {
    const tasks = [
      { title: "Fix parser", description: 'Handle [edge] cases with \\"quotes\\" inside', priority: "high" },
    ];
    const output = JSON.stringify(tasks);
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.title, "Fix parser");
  });

  it("handles nested arrays in dependsOn", () => {
    const tasks = [
      { title: "A", description: "first", priority: "high" },
      { title: "B", description: "second", priority: "medium", dependsOn: [0] },
      { title: "C", description: "third", priority: "low", dependsOn: [0, 1] },
    ];
    const output = "Tasks:\n" + JSON.stringify(tasks, null, 2) + "\n\nDone.";
    const result = extractTaskArray(output);
    assert.ok(result);
    assert.equal(result.length, 3);
    assert.deepEqual(result[2]?.dependsOn, [0, 1]);
  });

  it("returns null for empty string", () => {
    assert.equal(extractTaskArray(""), null);
  });

  it("returns null for text with no JSON", () => {
    assert.equal(extractTaskArray("I could not generate tasks for this goal."), null);
  });

  it("returns null for an empty JSON array", () => {
    assert.equal(extractTaskArray("[]"), null);
  });

  it("returns null for a JSON object (not array)", () => {
    assert.equal(extractTaskArray('{"title": "not an array"}'), null);
  });
});
