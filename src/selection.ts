import type { Task, TaskBackend } from "./tasks/types.js";

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
