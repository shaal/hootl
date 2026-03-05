import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatContextForPrompt } from "../context.js";
import type { ProjectContext } from "../context.js";

function makeFullContext(): ProjectContext {
  return {
    spec: "Build a CLI tool for task automation.",
    readme: "# My Project\nA cool project.",
    claudeMd: "Use strict mode. No any.",
    structure: "src/\n  index.ts\n  config.ts",
    existingTasks: "- task-001: Add feature X (done)\n- task-002: Fix bug Y (ready)",
    recentGitLog: "abc1234 Add feature X\ndef5678 Initial commit",
  };
}

describe("formatContextForPrompt", () => {
  it("includes all sections when all fields are populated", () => {
    const ctx = makeFullContext();
    const output = formatContextForPrompt(ctx);

    assert.ok(output.includes("Project Specification"), "should include spec section");
    assert.ok(output.includes("Build a CLI tool for task automation."), "should include spec content");
    assert.ok(output.includes("README"), "should include readme section");
    assert.ok(output.includes("A cool project."), "should include readme content");
    assert.ok(output.includes("CLAUDE.md"), "should include claudeMd section");
    assert.ok(output.includes("Use strict mode. No any."), "should include claudeMd content");
    assert.ok(output.includes("Project Structure"), "should include structure section");
    assert.ok(output.includes("src/"), "should include structure content");
    assert.ok(output.includes("Existing Tasks"), "should include tasks section");
    assert.ok(output.includes("task-001"), "should include tasks content");
    assert.ok(output.includes("Recent Git History"), "should include git history section");
    assert.ok(output.includes("abc1234"), "should include git log content");
  });

  it("omits Project Specification section when spec is null", () => {
    const ctx = makeFullContext();
    ctx.spec = null;
    const output = formatContextForPrompt(ctx);

    assert.ok(!output.includes("Project Specification"), "should not include spec section");
    assert.ok(output.includes("Project Structure"), "should still include structure section");
    assert.ok(output.includes("Existing Tasks"), "should still include tasks section");
  });

  it("omits Existing Tasks section when existingTasks is empty string", () => {
    const ctx = makeFullContext();
    ctx.existingTasks = "";
    const output = formatContextForPrompt(ctx);

    assert.ok(!output.includes("Existing Tasks"), "should not include tasks section");
    assert.ok(output.includes("Project Specification"), "should still include spec section");
    assert.ok(output.includes("Project Structure"), "should still include structure section");
  });

  it("omits Recent Git History section when recentGitLog is empty string", () => {
    const ctx = makeFullContext();
    ctx.recentGitLog = "";
    const output = formatContextForPrompt(ctx);

    assert.ok(!output.includes("Recent Git History"), "should not include git history section");
    assert.ok(output.includes("Project Specification"), "should still include spec section");
    assert.ok(output.includes("Project Structure"), "should still include structure section");
  });

  it("produces minimal output when all optional fields are null/empty", () => {
    const ctx: ProjectContext = {
      spec: null,
      readme: null,
      claudeMd: null,
      structure: "src/\n  index.ts",
      existingTasks: "",
      recentGitLog: "",
    };
    const output = formatContextForPrompt(ctx);

    assert.ok(output.includes("Project Structure"), "should include structure section");
    assert.ok(output.includes("src/"), "should include structure content");
    assert.ok(!output.includes("Project Specification"), "should not include spec section");
    assert.ok(!output.includes("README"), "should not include readme section");
    assert.ok(!output.includes("CLAUDE.md"), "should not include claudeMd section");
    assert.ok(!output.includes("Existing Tasks"), "should not include tasks section");
    assert.ok(!output.includes("Recent Git History"), "should not include git history section");
  });

  it("preserves correct section ordering", () => {
    const ctx = makeFullContext();
    const output = formatContextForPrompt(ctx);

    const specIdx = output.indexOf("Project Specification");
    const structureIdx = output.indexOf("Project Structure");
    const tasksIdx = output.indexOf("Existing Tasks");
    const gitIdx = output.indexOf("Recent Git History");

    assert.ok(specIdx >= 0, "spec section should be present");
    assert.ok(structureIdx >= 0, "structure section should be present");
    assert.ok(tasksIdx >= 0, "tasks section should be present");
    assert.ok(gitIdx >= 0, "git history section should be present");

    assert.ok(specIdx < structureIdx, "spec should come before structure");
    assert.ok(structureIdx < tasksIdx, "structure should come before tasks");
    assert.ok(tasksIdx < gitIdx, "tasks should come before git history");
  });
});
