import type { TaskBackend } from "./tasks/types.js";
import type { Config } from "./config.js";
import { isGitRepo, getBaseBranch, getMergedOrGoneBranches } from "./git.js";
import { uiSuccess } from "./ui.js";
import { notifyWebhook } from "./notify.js";

/**
 * Scan review-state tasks and promote to done if their branch has been
 * merged into (or deleted from) the base branch.
 * Runs at most 3 git subprocesses regardless of task count.
 */
export async function syncReviewTasks(backend: TaskBackend, config?: Config): Promise<number> {
  if (!(await isGitRepo())) return 0;

  const reviewTasks = await backend.listTasks({ state: "review" });
  if (reviewTasks.length === 0) return 0;

  let baseBranch: string;
  try {
    baseBranch = await getBaseBranch();
  } catch {
    return 0;
  }

  // Collect branch names for a single batch git query
  const branchNames = reviewTasks
    .map((t) => t.branch)
    .filter((b): b is string => b !== null);

  if (branchNames.length === 0) return 0;

  const { merged, gone } = await getMergedOrGoneBranches(branchNames, baseBranch);

  let promoted = 0;
  for (const task of reviewTasks) {
    if (task.branch === null) continue;
    if (merged.has(task.branch)) {
      await backend.updateTask(task.id, { state: "done" });
      uiSuccess(`Task ${task.id} branch merged — moved to done.`);
      if (config) {
        void notifyWebhook({
          taskId: task.id,
          title: task.title,
          oldState: "review",
          newState: "done",
          confidence: task.confidence,
          timestamp: new Date().toISOString(),
        }, config);
      }
      promoted++;
    } else if (gone.has(task.branch)) {
      await backend.updateTask(task.id, { state: "done" });
      uiSuccess(`Task ${task.id} branch removed — moved to done.`);
      if (config) {
        void notifyWebhook({
          taskId: task.id,
          title: task.title,
          oldState: "review",
          newState: "done",
          confidence: task.confidence,
          timestamp: new Date().toISOString(),
        }, config);
      }
      promoted++;
    }
  }
  return promoted;
}
