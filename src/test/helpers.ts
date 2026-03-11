import type { Task } from "../tasks/types.js";

/**
 * Shared test factory for Task objects. Provides sensible defaults for every
 * field so tests only need to specify the fields they care about.
 *
 * When a new field is added to the Task type, add its default here — this is
 * the single place that needs updating instead of 19 scattered definitions.
 */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-001",
    title: "Test task",
    description: "A test task description",
    priority: "medium",
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
    effort: null,
    goal: null,
    blockers: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
