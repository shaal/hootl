/**
 * Goal-aware prioritization helpers.
 *
 * `prioritizeGoal`  — set contiguous userPriority on every active task in a
 *                     single goal, respecting internal dependency order.
 * `prioritizeGoals` — reorder multiple goals relative to each other (all
 *                     goal-a tasks first, then goal-b, etc.) with ungrouped
 *                     tasks appended at the end.
 *
 * Both functions accept a `TaskBackend` so the caller (CLI action handler)
 * owns initialisation and config, while the core logic remains independently
 * testable.
 */

import type { TaskBackend, Task } from "./tasks/types.js";
import { topoSortTasks } from "./selection.js";

export interface PrioritizeResult {
  /** Number of tasks that received a userPriority update. */
  updated: number;
  /** Ordered list of [taskId, assignedPriority] pairs. */
  assignments: Array<[string, number]>;
}

/**
 * Set contiguous `userPriority` on all active (non-done) tasks belonging to
 * the given goal.  Tasks are topologically sorted by internal dependencies so
 * that a dependency always receives a lower priority number than its
 * dependents.
 *
 * Returns the number of tasks updated and the full assignment list.
 * Throws if no active tasks match the goal.
 */
export async function prioritizeGoal(
  backend: TaskBackend,
  goalId: string,
): Promise<PrioritizeResult> {
  const allTasks = await backend.listTasks();
  const goalTasks = allTasks.filter(
    (t) => t.goal === goalId && t.state !== "done",
  );

  if (goalTasks.length === 0) {
    throw new Error(`No active tasks found for goal "${goalId}".`);
  }

  const sorted = topoSortTasks(goalTasks);
  const assignments: Array<[string, number]> = [];

  for (let i = 0; i < sorted.length; i++) {
    const task = sorted[i]!;
    await backend.updateTask(task.id, { userPriority: i + 1 });
    assignments.push([task.id, i + 1]);
  }

  return { updated: sorted.length, assignments };
}

/**
 * Reorder multiple goals relative to each other.
 *
 * Tasks in each goal are topologically sorted internally.  The combined order
 * is: all tasks from goalIds[0], then goalIds[1], etc., with ungrouped tasks
 * (goal === null or goal not in the specified list) appended at the end.
 *
 * Every active task receives a sequential `userPriority` (1, 2, 3, …).
 */
export async function prioritizeGoals(
  backend: TaskBackend,
  goalIds: string[],
): Promise<PrioritizeResult> {
  const allTasks = await backend.listTasks();
  const activeTasks = allTasks.filter((t) => t.state !== "done");

  const ordered: Task[] = [];
  const assigned = new Set<string>();

  // Add tasks per goal in specified order, topologically sorted within each
  for (const goalId of goalIds) {
    const goalTasks = activeTasks.filter(
      (t) => t.goal === goalId && !assigned.has(t.id),
    );
    const sorted = topoSortTasks(goalTasks);
    for (const task of sorted) {
      ordered.push(task);
      assigned.add(task.id);
    }
  }

  // Append ungrouped tasks (goal is null or not in the specified list)
  const ungrouped = activeTasks.filter((t) => !assigned.has(t.id));
  ordered.push(...ungrouped);

  const assignments: Array<[string, number]> = [];
  for (let i = 0; i < ordered.length; i++) {
    const task = ordered[i]!;
    await backend.updateTask(task.id, { userPriority: i + 1 });
    assignments.push([task.id, i + 1]);
  }

  return { updated: ordered.length, assignments };
}
