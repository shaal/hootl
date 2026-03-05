import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCritiquePrompt,
  parseCritiqueTasks,
  type PlannedTask,
} from "../plan-review.js";

describe("buildCritiquePrompt", () => {
  it("includes the goal description", () => {
    const tasks: PlannedTask[] = [
      { title: "Add /simplify command", description: "Create a simplify command", priority: "high" },
    ];
    const result = buildCritiquePrompt("add a /simplify command", tasks);
    assert.ok(result.includes("add a /simplify command"));
    assert.ok(result.includes("## Original Goal"));
  });

  it("includes the task list as JSON", () => {
    const tasks: PlannedTask[] = [
      { title: "Task A", description: "Do A", priority: "high" },
      { title: "Task B", description: "Do B", priority: "medium" },
    ];
    const result = buildCritiquePrompt("some goal", tasks);
    assert.ok(result.includes("## Proposed Task List"));
    assert.ok(result.includes('"Task A"'));
    assert.ok(result.includes('"Task B"'));
  });

  it("includes task indices in the JSON output", () => {
    const tasks: PlannedTask[] = [
      { title: "First", description: "1st", priority: "high" },
      { title: "Second", description: "2nd", priority: "low" },
    ];
    const result = buildCritiquePrompt("goal", tasks);
    assert.ok(result.includes('"index": 0'));
    assert.ok(result.includes('"index": 1'));
  });

  it("includes dependsOn when present", () => {
    const tasks: PlannedTask[] = [
      { title: "Base", description: "base task" },
      { title: "Dependent", description: "depends on base", dependsOn: [0] },
    ];
    const result = buildCritiquePrompt("goal", tasks);
    assert.ok(result.includes('"dependsOn"'));
  });

  it("omits dependsOn when empty or absent", () => {
    const tasks: PlannedTask[] = [
      { title: "No deps", description: "standalone", dependsOn: [] },
      { title: "Also no deps", description: "also standalone" },
    ];
    const result = buildCritiquePrompt("goal", tasks);
    assert.ok(!result.includes('"dependsOn"'));
  });

  it("defaults priority to medium when not specified", () => {
    const tasks: PlannedTask[] = [
      { title: "No priority", description: "task without priority" },
    ];
    const result = buildCritiquePrompt("goal", tasks);
    assert.ok(result.includes('"priority": "medium"'));
  });

  it("asks for review in the trailing instruction", () => {
    const tasks: PlannedTask[] = [
      { title: "T", description: "d" },
    ];
    const result = buildCritiquePrompt("goal", tasks);
    assert.ok(result.includes("Review this task list"));
  });
});

describe("parseCritiqueTasks", () => {
  it("parses a valid revised task list", () => {
    const input = JSON.stringify([
      { title: "Revised A", description: "New desc A", priority: "high" },
      { title: "Revised B", description: "New desc B", priority: "low", dependsOn: [0] },
    ]);

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.title, "Revised A");
    assert.equal(result[1]!.priority, "low");
    assert.deepEqual(result[1]!.dependsOn, [0]);
  });

  it("parses JSON wrapped in markdown code blocks", () => {
    const input = "Here is the revised plan:\n```json\n" +
      JSON.stringify([{ title: "T1", description: "D1", priority: "medium" }]) +
      "\n```\n";

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.title, "T1");
  });

  it("returns null for non-JSON output", () => {
    const result = parseCritiqueTasks("The plan looks good, no changes needed.");
    assert.equal(result, null);
  });

  it("returns null for malformed JSON", () => {
    const result = parseCritiqueTasks("[{bad json}]");
    assert.equal(result, null);
  });

  it("returns null when parsed value is not an array", () => {
    const result = parseCritiqueTasks('{"title": "test", "description": "test"}');
    assert.equal(result, null);
  });

  it("skips items missing title", () => {
    const input = JSON.stringify([
      { description: "No title here", priority: "high" },
      { title: "Has title", description: "Valid", priority: "medium" },
    ]);

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.title, "Has title");
  });

  it("skips items missing description", () => {
    const input = JSON.stringify([
      { title: "No desc", priority: "high" },
      { title: "Has desc", description: "Valid", priority: "medium" },
    ]);

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.title, "Has desc");
  });

  it("returns null when all items are invalid", () => {
    const input = JSON.stringify([
      { noTitle: true, noDesc: true },
      { title: 42, description: false },
    ]);

    const result = parseCritiqueTasks(input);
    assert.equal(result, null);
  });

  it("filters non-integer dependsOn values", () => {
    const input = JSON.stringify([
      { title: "T", description: "D", dependsOn: [0, "bad", 1.5, 2, null] },
    ]);

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.deepEqual(result[0]!.dependsOn, [0, 2]);
  });

  it("handles tasks without priority or dependsOn", () => {
    const input = JSON.stringify([
      { title: "Minimal", description: "Just title and desc" },
    ]);

    const result = parseCritiqueTasks(input);
    assert.ok(result !== null);
    assert.equal(result[0]!.priority, undefined);
    assert.equal(result[0]!.dependsOn, undefined);
  });
});
