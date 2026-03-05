import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generatePlanSummary, type PlannedTask } from "../plan-summary.js";

describe("generatePlanSummary", () => {
  it("handles a single task", () => {
    const tasks: PlannedTask[] = [
      { title: "Add health check", description: "Create /health endpoint", priority: "high" },
    ];
    const result = generatePlanSummary(tasks);
    assert.ok(result.includes("1 task(s)"));
    assert.ok(result.includes("Add health check"));
    assert.ok(result.includes("1 high"));
  });

  it("includes all titles for 3 tasks", () => {
    const tasks: PlannedTask[] = [
      { title: "Task A", description: "Do A", priority: "critical" },
      { title: "Task B", description: "Do B", priority: "high" },
      { title: "Task C", description: "Do C", priority: "medium" },
    ];
    const result = generatePlanSummary(tasks);
    assert.ok(result.includes("3 task(s)"));
    assert.ok(result.includes("Task A"));
    assert.ok(result.includes("Task B"));
    assert.ok(result.includes("Task C"));
    assert.ok(!result.includes("more"));
  });

  it("truncates with '...and N more' for many tasks", () => {
    const tasks: PlannedTask[] = Array.from({ length: 8 }, (_, i) => ({
      title: `Task ${i + 1}`,
      description: `Do ${i + 1}`,
      priority: "medium" as const,
    }));
    const result = generatePlanSummary(tasks);
    assert.ok(result.includes("8 task(s)"));
    assert.ok(result.includes("Task 1"));
    assert.ok(result.includes("Task 2"));
    assert.ok(result.includes("Task 3"));
    assert.ok(result.includes("...and 5 more"));
    // Task 4 through 8 should not appear in the title line
    assert.ok(!result.includes("Task 4"));
  });

  it("counts priorities correctly for mixed tasks", () => {
    const tasks: PlannedTask[] = [
      { title: "A", description: "a", priority: "critical" },
      { title: "B", description: "b", priority: "critical" },
      { title: "C", description: "c", priority: "high" },
      { title: "D", description: "d", priority: "medium" },
      { title: "E", description: "e", priority: "low" },
      { title: "F", description: "f", priority: "low" },
    ];
    const result = generatePlanSummary(tasks);
    assert.ok(result.includes("2 critical"));
    assert.ok(result.includes("1 high"));
    assert.ok(result.includes("1 medium"));
    assert.ok(result.includes("2 low"));
  });

  it("defaults to medium when priority is undefined", () => {
    const tasks: PlannedTask[] = [
      { title: "No priority", description: "test" },
      { title: "Has priority", description: "test", priority: "high" },
    ];
    const result = generatePlanSummary(tasks);
    assert.ok(result.includes("1 high"));
    assert.ok(result.includes("1 medium"));
  });

  it("handles empty task array gracefully", () => {
    const result = generatePlanSummary([]);
    assert.equal(result, "No tasks to create.");
  });

  it("preserves ordering (critical before low) in priority breakdown", () => {
    const tasks: PlannedTask[] = [
      { title: "A", description: "a", priority: "low" },
      { title: "B", description: "b", priority: "critical" },
    ];
    const result = generatePlanSummary(tasks);
    const critIdx = result.indexOf("critical");
    const lowIdx = result.indexOf("low");
    assert.ok(critIdx < lowIdx, "critical should appear before low in the summary");
  });
});
