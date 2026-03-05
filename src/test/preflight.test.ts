import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parsePreflightResult, buildPreflightPrompt, buildExecutePrompt } from "../loop.js";
import type { Task } from "../tasks/types.js";

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

describe("buildPreflightPrompt", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
    title: "Fix login bug",
    description: "Users cannot log in when using SSO",
    priority: "high",
    type: "feature",
    state: "ready",
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
  });

  it("includes task title and description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      const prompt = await buildPreflightPrompt(makeTask(), dir);
      assert.ok(prompt.includes("# Task: Fix login bug"));
      assert.ok(prompt.includes("Users cannot log in when using SSO"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes task priority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      const prompt = await buildPreflightPrompt(makeTask({ priority: "critical" }), dir);
      assert.ok(prompt.includes("**Priority:** critical"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes blockers when blockers.md exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      await writeFile(join(dir, "blockers.md"), "SSO provider is down", "utf-8");
      const prompt = await buildPreflightPrompt(makeTask(), dir);
      assert.ok(prompt.includes("## Previous Blockers"));
      assert.ok(prompt.includes("SSO provider is down"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits blockers section when blockers.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      const prompt = await buildPreflightPrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Previous Blockers"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits blockers section when blockers.md is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      await writeFile(join(dir, "blockers.md"), "   \n  ", "utf-8");
      const prompt = await buildPreflightPrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Previous Blockers"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ends with validation instruction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-preflight-"));
    try {
      const prompt = await buildPreflightPrompt(makeTask(), dir);
      assert.ok(prompt.includes("Validate this task and produce a JSON preflight assessment"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("parsePreflightResult", () => {
  it("extracts all fields from clean JSON", () => {
    const input = JSON.stringify({
      verdict: "proceed",
      understanding: "The task is clear",
      subtasks: [{ title: "Step 1", description: "Do the thing" }],
      reproductionResult: "Bug reproduced successfully",
    });

    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "proceed");
    assert.equal(result.understanding, "The task is clear");
    assert.deepEqual(result.subtasks, [{ title: "Step 1", description: "Do the thing" }]);
    assert.equal(result.reproductionResult, "Bug reproduced successfully");
  });

  it("parses all four verdict values", () => {
    for (const verdict of ["proceed", "too_broad", "unclear", "cannot_reproduce"] as const) {
      const input = JSON.stringify({ verdict, understanding: "test" });
      const result = parsePreflightResult(input);
      assert.equal(result.verdict, verdict);
    }
  });

  it("extracts JSON wrapped in markdown code block", () => {
    const input = `Here is the preflight result:

\`\`\`json
{
  "verdict": "too_broad",
  "understanding": "Task covers multiple concerns",
  "subtasks": [
    {"title": "Part A", "description": "First part"},
    {"title": "Part B", "description": "Second part"}
  ],
  "reproductionResult": ""
}
\`\`\`

That's my assessment.`;

    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "too_broad");
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.title, "Part A");
    assert.equal(result.subtasks[1]?.title, "Part B");
  });

  it("uses brace-matching fallback when code block extraction fails", () => {
    // Simulate nested code fences that break the code block regex
    const json = JSON.stringify({
      verdict: "proceed",
      understanding: "All clear",
      subtasks: [],
      reproductionResult: "Includes ```bash\necho hello\n``` in output",
    });
    const input = "Analysis:\n\n```json\n" + json + "\n```\n\nDone.";

    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "proceed");
    assert.equal(result.understanding, "All clear");
  });

  it("returns defaults for invalid JSON", () => {
    const result = parsePreflightResult("this is not json at all {broken");
    assert.equal(result.verdict, "unclear");
    assert.equal(result.understanding, "");
    assert.deepEqual(result.subtasks, []);
    assert.equal(result.reproductionResult, "");
  });

  it("returns defaults for empty string", () => {
    const result = parsePreflightResult("");
    assert.equal(result.verdict, "unclear");
    assert.equal(result.understanding, "");
    assert.deepEqual(result.subtasks, []);
    assert.equal(result.reproductionResult, "");
  });

  it("defaults missing optional fields", () => {
    const input = JSON.stringify({ verdict: "proceed" });
    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "proceed");
    assert.equal(result.understanding, "");
    assert.deepEqual(result.subtasks, []);
    assert.equal(result.reproductionResult, "");
  });

  it("falls back to 'unclear' for invalid verdict values", () => {
    const input = JSON.stringify({
      verdict: "invalid_verdict",
      understanding: "Some text",
    });
    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "unclear");
    assert.equal(result.understanding, "Some text");
  });

  it("falls back to 'unclear' when verdict is a number", () => {
    const input = JSON.stringify({ verdict: 42 });
    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "unclear");
  });

  it("filters out invalid subtask entries", () => {
    const input = JSON.stringify({
      verdict: "too_broad",
      understanding: "Needs splitting",
      subtasks: [
        { title: "Valid", description: "A valid subtask" },
        "not an object",
        { title: "Missing description" },
        { description: "Missing title" },
        null,
        42,
        { title: "Also valid", description: "Another valid one" },
      ],
    });
    const result = parsePreflightResult(input);
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.subtasks[0]?.title, "Valid");
    assert.equal(result.subtasks[1]?.title, "Also valid");
  });

  it("defaults subtasks to empty array when not an array", () => {
    const input = JSON.stringify({
      verdict: "proceed",
      subtasks: "not an array",
    });
    const result = parsePreflightResult(input);
    assert.deepEqual(result.subtasks, []);
  });

  it("handles JSON embedded in surrounding text", () => {
    const input = `I analyzed the task.

The result: {"verdict": "cannot_reproduce", "understanding": "Could not trigger the bug", "subtasks": [], "reproductionResult": "Tried 5 times, no failure"}

Please review.`;

    const result = parsePreflightResult(input);
    assert.equal(result.verdict, "cannot_reproduce");
    assert.equal(result.reproductionResult, "Tried 5 times, no failure");
  });
});

describe("preflight integration — buildExecutePrompt", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-001",
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
  });

  it("includes understanding.md content in execute prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-exec-"));
    try {
      await writeFile(join(dir, "understanding.md"), "The task requires fixing the auth flow for SSO users.", "utf-8");
      const prompt = await buildExecutePrompt(makeTask(), dir);
      assert.ok(prompt.includes("## Task Understanding"));
      assert.ok(prompt.includes("fixing the auth flow for SSO users"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits understanding section when understanding.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-exec-"));
    try {
      const prompt = await buildExecutePrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Task Understanding"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("omits understanding section when understanding.md is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-exec-"));
    try {
      await writeFile(join(dir, "understanding.md"), "   \n  ", "utf-8");
      const prompt = await buildExecutePrompt(makeTask(), dir);
      assert.ok(!prompt.includes("Task Understanding"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("places understanding before plan in execute prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hootl-exec-"));
    try {
      await writeFile(join(dir, "understanding.md"), "Understanding content here", "utf-8");
      await writeFile(join(dir, "plan.md"), "Plan content here", "utf-8");
      const prompt = await buildExecutePrompt(makeTask(), dir);
      const understandingIdx = prompt.indexOf("## Task Understanding");
      const planIdx = prompt.indexOf("## Plan");
      assert.ok(understandingIdx >= 0, "Understanding section should exist");
      assert.ok(planIdx >= 0, "Plan section should exist");
      assert.ok(understandingIdx < planIdx, "Understanding should come before Plan");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
