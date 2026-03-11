import type { Task, TaskBackend } from "./tasks/types.js";

/**
 * Filter a task list to only those belonging to a specific goal.
 * Returns the full list unchanged when goalId is undefined (backward compat).
 */
export function filterTasksByGoal(tasks: Task[], goalId?: string): Task[] {
  if (!goalId) return tasks;
  return tasks.filter(t => t.goal === goalId);
}

/**
 * Check whether all tasks for a goal have reached a terminal state (done or blocked).
 * Returns false for an empty array (no tasks = goal not complete, it doesn't exist).
 */
export function isGoalComplete(goalTasks: Task[]): boolean {
  return goalTasks.length > 0 &&
    goalTasks.every(t => t.state === "done" || t.state === "blocked");
}

/**
 * Count how many tasks in a goal are in the blocked state.
 * Useful for distinguishing full success from partial completion.
 */
export function countBlockedInGoal(goalTasks: Task[]): number {
  return goalTasks.filter(t => t.state === "blocked").length;
}

/**
 * Find the first runnable task from a sorted list of candidates.
 * A task is runnable if all its dependencies are in 'done' or 'review' state.
 * Tasks with no dependencies are always runnable.
 */
export async function findRunnableTask(
  candidates: Task[],
  backend: TaskBackend,
): Promise<{ task: Task | undefined; skipped: Array<{ id: string; reason: string }> }> {
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.dependencies.length === 0) {
      return { task: candidate, skipped };
    }

    let allMet = true;
    for (const depId of candidate.dependencies) {
      try {
        const depTask = await backend.getTask(depId);
        if (depTask.state !== "done" && depTask.state !== "review") {
          skipped.push({
            id: candidate.id,
            reason: `depends on ${depId} which is still ${depTask.state}`,
          });
          allMet = false;
          break;
        }
      } catch {
        // Dependency task doesn't exist — treat as unmet
        skipped.push({
          id: candidate.id,
          reason: `depends on ${depId} which was not found`,
        });
        allMet = false;
        break;
      }
    }

    if (allMet) {
      return { task: candidate, skipped };
    }
  }

  return { task: undefined, skipped };
}

/**
 * Find the first runnable task and atomically claim it for this process.
 * If a task is runnable but already claimed by another live process, it is
 * skipped and the next candidate is tried.
 */
export async function findAndClaimTask(
  candidates: Task[],
  backend: TaskBackend,
): Promise<{ task: Task | undefined; skipped: Array<{ id: string; reason: string }> }> {
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const candidate of candidates) {
    // Check dependencies first (cheap, no file I/O for the claim)
    if (candidate.dependencies.length > 0) {
      let allMet = true;
      for (const depId of candidate.dependencies) {
        try {
          const depTask = await backend.getTask(depId);
          if (depTask.state !== "done" && depTask.state !== "review") {
            skipped.push({
              id: candidate.id,
              reason: `depends on ${depId} which is still ${depTask.state}`,
            });
            allMet = false;
            break;
          }
        } catch {
          skipped.push({
            id: candidate.id,
            reason: `depends on ${depId} which was not found`,
          });
          allMet = false;
          break;
        }
      }
      if (!allMet) continue;
    }

    // Dependencies met — attempt to claim
    const claimed = await backend.claimTask(candidate.id);
    if (!claimed) {
      skipped.push({
        id: candidate.id,
        reason: "claimed by another instance",
      });
      continue;
    }

    return { task: candidate, skipped };
  }

  return { task: undefined, skipped };
}
