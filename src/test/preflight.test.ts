import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(__dirname, "../../templates/preflight.md");

describe("templates/preflight.md", () => {
  it("exists and is non-empty", () => {
    assert.ok(existsSync(templatePath), "preflight.md should exist");
    const content = readFileSync(templatePath, "utf-8");
    assert.ok(content.length > 100, "preflight.md should have substantial content");
  });

  const content = readFileSync(templatePath, "utf-8");

  it("declares the preflight validation role", () => {
    assert.ok(content.includes("preflight validation agent"));
  });

  it("includes all four verdict values", () => {
    assert.ok(content.includes("proceed"));
    assert.ok(content.includes("too_broad"));
    assert.ok(content.includes("unclear"));
    assert.ok(content.includes("cannot_reproduce"));
  });

  it("includes the required JSON output fields", () => {
    assert.ok(content.includes('"verdict"'));
    assert.ok(content.includes('"understanding"'));
    assert.ok(content.includes('"subtasks"'));
    assert.ok(content.includes('"reproductionResult"'));
  });

  it("emphasizes no implementation work", () => {
    assert.ok(content.includes("DO NOT"), "should contain DO NOT constraints");
    assert.ok(
      content.includes("no code changes") || content.includes("NO implementation"),
      "should explicitly prohibit implementation"
    );
  });

  it("instructs bug reproduction for bug tasks", () => {
    assert.ok(content.includes("Reproduce Bugs"));
    assert.ok(content.includes("reproduced"));
  });

  it("instructs scope assessment", () => {
    assert.ok(content.includes("Assess Scope"));
    assert.ok(content.includes("subtasks"));
  });

  it("prohibits git commits", () => {
    assert.ok(content.includes("DO NOT") && content.includes("git commit"));
  });
});
