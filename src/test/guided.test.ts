import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildClarificationPrompt,
  parseClarifyingQuestions,
  formatConstraints,
  type ClarifyingQuestion,
} from "../guided.js";

describe("buildClarificationPrompt", () => {
  it("includes goal and context", () => {
    const result = buildClarificationPrompt("add caching", "src files here");
    assert.ok(result.includes("Goal: add caching"));
    assert.ok(result.includes("<context>"));
    assert.ok(result.includes("src files here"));
  });
});

describe("parseClarifyingQuestions", () => {
  it("parses a valid JSON array of questions", () => {
    const input = JSON.stringify([
      {
        question: "Should caching be in-memory or Redis?",
        options: ["In-memory", "Redis", "Custom answer"],
      },
      {
        question: "What TTL for cached entries?",
        options: ["5 minutes", "1 hour", "No expiry", "Custom answer"],
      },
    ]);

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 2);
    assert.equal(questions[0]!.question, "Should caching be in-memory or Redis?");
    assert.deepEqual(questions[0]!.options, ["In-memory", "Redis", "Custom answer"]);
    assert.equal(questions[1]!.options.length, 4);
  });

  it("handles JSON wrapped in markdown code blocks", () => {
    const input = "Here are the questions:\n```json\n" +
      JSON.stringify([{ question: "Scope?", options: ["A", "B", "Custom answer"] }]) +
      "\n```\n";

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.question, "Scope?");
  });

  it("returns empty array for non-JSON output", () => {
    const questions = parseClarifyingQuestions("I couldn't understand the goal.");
    assert.deepEqual(questions, []);
  });

  it("returns empty array for malformed JSON", () => {
    const questions = parseClarifyingQuestions("[{bad json}]");
    assert.deepEqual(questions, []);
  });

  it("returns empty array when parsed value is not an array", () => {
    const questions = parseClarifyingQuestions('{"question": "test"}');
    assert.deepEqual(questions, []);
  });

  it("skips items with missing question field", () => {
    const input = JSON.stringify([
      { options: ["A", "B"] },
      { question: "Valid?", options: ["Yes", "No"] },
    ]);

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.question, "Valid?");
  });

  it("skips items with fewer than 2 options", () => {
    const input = JSON.stringify([
      { question: "One option?", options: ["Only one"] },
      { question: "Two options?", options: ["A", "B"] },
    ]);

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.question, "Two options?");
  });

  it("caps at 4 questions maximum", () => {
    const input = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        question: `Question ${i + 1}?`,
        options: ["A", "B"],
      })),
    );

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 4);
  });

  it("filters non-string options", () => {
    const input = JSON.stringify([
      { question: "Mixed?", options: ["Valid", 42, "Also valid", null] },
    ]);

    const questions = parseClarifyingQuestions(input);
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0]!.options, ["Valid", "Also valid"]);
  });
});

describe("formatConstraints", () => {
  it("formats Q&A pairs into a constraints block", () => {
    const questions: ClarifyingQuestion[] = [
      { question: "In-memory or Redis?", options: ["In-memory", "Redis", "Custom answer"] },
      { question: "TTL?", options: ["5min", "1hr", "Custom answer"] },
    ];
    const answers = ["In-memory", "5min"];

    const result = formatConstraints(questions, answers);
    assert.ok(result.includes("Clarified constraints:"));
    assert.ok(result.includes("Q: In-memory or Redis?"));
    assert.ok(result.includes("A: In-memory"));
    assert.ok(result.includes("Q: TTL?"));
    assert.ok(result.includes("A: 5min"));
  });

  it("handles mismatched lengths (more questions than answers)", () => {
    const questions: ClarifyingQuestion[] = [
      { question: "Q1?", options: ["A", "B"] },
      { question: "Q2?", options: ["C", "D"] },
    ];
    const answers = ["A"];

    const result = formatConstraints(questions, answers);
    assert.ok(result.includes("Q: Q1?"));
    assert.ok(result.includes("A: A"));
    assert.ok(!result.includes("Q: Q2?"));
  });

  it("handles empty arrays", () => {
    const result = formatConstraints([], []);
    assert.ok(result.includes("Clarified constraints:"));
    // Should contain only the header (possibly with a leading newline)
    assert.ok(!result.includes("Q:"));
    assert.ok(!result.includes("A:"));
  });
});
