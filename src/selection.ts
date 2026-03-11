import type { Task, TaskBackend, TaskState } from "./tasks/types.js";
import type { OrderingStrategy, Config } from "./config.js";

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

/**
 * Priority tier key for grouping tasks that should be treated as equals
 * when applying within-tier effort-based tiebreaking. Two tasks share a tier
 * when they have the same (userPriority, priority) combination.
 */
function tierKey(t: Task): string {
  return `${t.userPriority ?? "null"}:${t.priority}`;
}

/**
 * Re-sort an already priority-sorted task list using a configurable
 * ordering strategy. The strategy only affects tiebreaking within the
 * same priority tier (userPriority + priority). Cross-tier ordering is
 * always preserved.
 *
 * Strategies:
 * - "fifo": keep existing order (createdAt ascending) — no-op
 * - "quick-wins-first": lower effort first within tier (nulls last)
 * - "big-items-first": higher effort first within tier (nulls last)
 */
export function sortByStrategy(tasks: Task[], strategy: OrderingStrategy): Task[] {
  if (strategy === "fifo") return tasks;

  const result = [...tasks];
  result.sort((a, b) => {
    // Preserve cross-tier ordering: only re-sort within the same tier
    const aTier = tierKey(a);
    const bTier = tierKey(b);
    if (aTier !== bTier) {
      // Maintain original relative order for different tiers.
      // Since the input is already sorted by priority, we preserve that
      // by returning 0 (stable sort keeps original positions).
      return 0;
    }

    // Within the same tier, sort by effort according to strategy.
    // Null effort always sorts last (tasks without estimates yield to those with).
    const aEffort = a.effort;
    const bEffort = b.effort;

    if (aEffort === null && bEffort === null) return 0;
    if (aEffort === null) return 1;
    if (bEffort === null) return -1;

    if (strategy === "quick-wins-first") {
      return aEffort - bEffort;
    }
    // strategy === "big-items-first"
    return bEffort - aEffort;
  });

  return result;
}

export interface GetNextTaskOpts {
  state?: TaskState;
  goalId?: string;
}

/**
 * Consolidated task selection: lists tasks from the backend, filters by goal,
 * applies the configured ordering strategy, then finds and claims the first
 * runnable task (respecting dependencies and cross-process claiming).
 */
export async function getNextTask(
  backend: TaskBackend,
  config: Config,
  opts?: GetNextTaskOpts,
): Promise<{ task: Task | undefined; skipped: Array<{ id: string; reason: string }> }> {
  const state = opts?.state ?? "ready";
  const tasks = await backend.listTasks({ state });
  const goalFiltered = filterTasksByGoal(tasks, opts?.goalId);
  const sorted = sortByStrategy(goalFiltered, config.auto.orderingStrategy);
  return findAndClaimTask(sorted, backend);
}
