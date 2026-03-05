import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewResult } from "../loop.js";

describe("parseReviewResult", () => {
  it("extracts fields from clean JSON", () => {
    const input = JSON.stringify({
      confidence: 85,
      summary: "All tests pass",
      issues: ["minor lint warning"],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 85);
    assert.equal(result.summary, "All tests pass");
    assert.deepEqual(result.issues, ["minor lint warning"]);
    assert.deepEqual(result.blockers, []);
  });

  it("extracts JSON wrapped in markdown json code block", () => {
    const input = `Here is my review:

\`\`\`json
{
  "confidence": 92,
  "summary": "Implementation looks solid",
  "issues": [],
  "blockers": []
}
\`\`\`

That's my assessment.`;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 92);
    assert.equal(result.summary, "Implementation looks solid");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("extracts JSON wrapped in plain code block", () => {
    const input = `\`\`\`
{
  "confidence": 70,
  "summary": "Needs more tests",
  "issues": ["no edge case coverage"],
  "blockers": ["missing test framework"]
}
\`\`\``;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 70);
    assert.equal(result.summary, "Needs more tests");
    assert.deepEqual(result.issues, ["no edge case coverage"]);
    assert.deepEqual(result.blockers, ["missing test framework"]);
  });

  it("finds JSON embedded in surrounding text", () => {
    const input = `I reviewed the code carefully.

The result is: {"confidence": 60, "summary": "Partial implementation", "issues": ["incomplete API"], "blockers": []}

Please address the issues above.`;

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 60);
    assert.equal(result.summary, "Partial implementation");
    assert.deepEqual(result.issues, ["incomplete API"]);
  });

  it("returns default for invalid JSON", () => {
    const result = parseReviewResult("this is not json at all {broken");
    assert.equal(result.confidence, 0);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("returns default for empty string", () => {
    const result = parseReviewResult("");
    assert.equal(result.confidence, 0);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("defaults missing optional fields to empty arrays/strings", () => {
    const input = JSON.stringify({ confidence: 50 });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 50);
    assert.equal(result.summary, "");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.blockers, []);
  });

  it("returns 0 confidence when confidence is a string", () => {
    const input = JSON.stringify({
      confidence: "85",
      summary: "Looks good",
      issues: [],
      blockers: [],
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 0);
  });

  it("extracts fields from nested JSON with extra fields", () => {
    const input = JSON.stringify({
      confidence: 88,
      summary: "Good progress",
      issues: ["minor typo"],
      blockers: [],
      extraField: "should be ignored",
      metadata: { timestamp: "2024-01-01" },
    });

    const result = parseReviewResult(input);
    assert.equal(result.confidence, 88);
    assert.equal(result.summary, "Good progress");
    assert.deepEqual(result.issues, ["minor typo"]);
    assert.deepEqual(result.blockers, []);
  });
});
