import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { TaskBackend } from "./tasks/types.js";
import { isGitRepo, getBaseBranch, removeWorktree as defaultRemoveWorktree } from "./git.js";
import { uiInfo, uiSuccess, uiWarn } from "./ui.js";

export interface ReconcileAction {
  id: string;
  title: string;
  action: string;
}

export interface ReconcileResult {
  reconciled: ReconcileAction[];
  orphanedCleaned: number;
}

/**
 * Injectable dependencies for reconcileTasks.
 * Follows the same DI pattern as CommitMessageDeps, HookDeps, etc.
 */
export interface ReconcileDeps {
  removeWorktree: (path: string) => Promise<void>;
}

const defaultDeps: ReconcileDeps = {
  removeWorktree: defaultRemoveWorktree,
};

/**
 * Extract subtask IDs from a decomposition blocker message.
 * Matches both "Decomposed into subtasks: ..." and "Decomposed remediation into subtasks: ...".
 */
const DECOMPOSED_PATTERN = /^Decomposed(?:\s+\w+)?\s+into subtasks:\s*(.+)$/;

export function extractDecomposedSubtaskIds(blocker: string): string[] {
  const match = DECOMPOSED_PATTERN.exec(blocker);
  if (!match?.[1]) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Mark a task done and clean up its branch/worktree. Returns the action description string.
 * Shared by Phase 1 (commit-based) and Phase 2 (subtask-based) reconciliation.
 */
async function markDoneAndCleanup(
  task: { id: string; branch: string | null; worktree: string | null },
  actionLabel: string,
  backend: TaskBackend,
  deps: ReconcileDeps,
  dryRun: boolean,
): Promise<string> {
  const actions: string[] = [actionLabel];
  if (task.branch !== null) actions.push("branch cleaned");
  if (task.worktree !== null) actions.push("worktree cleaned");

  if (!dryRun) {
    await backend.updateTask(task.id, { state: "done" });

    if (task.branch !== null) {
      try {
        await execa("git", ["branch", "-D", task.branch]);
      } catch {
        // Branch may not exist locally — that's fine
      }
    }

    if (task.worktree !== null) {
      try {
        await deps.removeWorktree(task.worktree);
        await backend.updateTask(task.id, { worktree: null });
      } catch {
        // Best-effort: worktree cleanup should never block state transitions
      }
    }
  }

  return actions.join(" + ");
}

/**
 * Scan all non-done tasks and check whether their work has already landed on main
 * via `git log --grep=<taskId>`. For each match, mark the task done, clean up its
 * stale branch and worktree. Also auto-promote decomposed parent tasks whose subtasks
 * are all done. Also detect orphaned worktree directories whose tasks are already done
 * or no longer exist in the backend.
 */
export async function reconcileTasks(
  backend: TaskBackend,
  options?: { dryRun?: boolean; deps?: ReconcileDeps },
): Promise<ReconcileResult> {
  const dryRun = options?.dryRun === true;
  const deps = options?.deps ?? defaultDeps;
  const result: ReconcileResult = { reconciled: [], orphanedCleaned: 0 };

  if (!(await isGitRepo())) return result;

  let baseBranch: string;
  try {
    baseBranch = await getBaseBranch();
  } catch {
    return result;
  }

  const allTasks = await backend.listTasks();
  const nonDoneTasks = allTasks.filter((t) => t.state !== "done");
  const doneTasks = allTasks.filter((t) => t.state === "done");
  const doneIds = new Set(doneTasks.map((t) => t.id));

  // Phase 1: Check each non-done task for commits on the base branch
  for (const task of nonDoneTasks) {
    let hasCommits = false;
    try {
      const gitResult = await execa("git", [
        "log",
        baseBranch,
        `--grep=${task.id}`,
        "--oneline",
        "--max-count=1",
      ]);
      hasCommits = gitResult.stdout.trim().length > 0;
    } catch {
      // git log failure — skip this task
      continue;
    }

    if (!hasCommits) continue;

    const actionStr = await markDoneAndCleanup(task, "marked done", backend, deps, dryRun);
    result.reconciled.push({ id: task.id, title: task.title, action: actionStr });
    doneIds.add(task.id);
  }

  // Phase 2: Auto-promote decomposed parent tasks whose subtasks are all done.
  // Loop until no more promotions happen (handles cascading decompositions).
  // Terminates because each iteration promotes at least one task into doneIds, and the set is finite.
  // Note: Phases 1 and 2 operate on disjoint populations (Phase 1: tasks with commits on main,
  // Phase 2: blocked decomposed parents with no commits), so stale in-memory task objects are safe.
  let promoted = true;
  while (promoted) {
    promoted = false;
    for (const task of nonDoneTasks) {
      if (doneIds.has(task.id)) continue;
      if (task.state !== "blocked") continue;

      // Collect subtask IDs from all decomposition blocker messages
      const subtaskIds: string[] = [];
      for (const blocker of task.blockers) {
        subtaskIds.push(...extractDecomposedSubtaskIds(blocker));
      }
      if (subtaskIds.length === 0) continue;

      // All referenced subtasks must be done
      if (!subtaskIds.every((id) => doneIds.has(id))) continue;

      const actionStr = await markDoneAndCleanup(task, "marked done (subtasks complete)", backend, deps, dryRun);
      result.reconciled.push({ id: task.id, title: task.title, action: actionStr });
      doneIds.add(task.id);
      promoted = true;
    }
  }

  // Phase 3: Detect orphaned worktree directories
  const hootlDir = join(process.cwd(), ".hootl");
  const worktreesDir = join(hootlDir, "worktrees");

  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Worktree directory names follow the task ID pattern (e.g., "task-042")
      const dirName = entry.name;

      // Check if this directory's task is done (or doesn't exist at all)
      const isDone = doneIds.has(dirName);
      let taskExists = false;
      try {
        await backend.getTask(dirName);
        taskExists = true;
      } catch {
        // Task doesn't exist
      }

      if (isDone || !taskExists) {
        if (!dryRun) {
          const worktreePath = join(worktreesDir, dirName);
          try {
            await deps.removeWorktree(worktreePath);
          } catch {
            // Best-effort cleanup
          }
        }
        result.orphanedCleaned++;
      }
    }
  } catch {
    // worktrees directory may not exist — that's normal
  }

  return result;
}

/**
 * Print a human-readable summary of reconciliation results.
 */
export function printReconcileReport(result: ReconcileResult, dryRun: boolean): void {
  const prefix = dryRun ? "[DRY RUN] " : "";

  if (result.reconciled.length === 0 && result.orphanedCleaned === 0) {
    uiInfo(`${prefix}Nothing to reconcile — all tasks are consistent.`);
    return;
  }

  if (result.reconciled.length > 0) {
    uiInfo(`\n${prefix}Reconciled tasks:`);
    uiInfo("  ID            Title                                    Action");
    uiInfo("  ─────────────────────────────────────────────────────────────────");
    for (const entry of result.reconciled) {
      const id = entry.id.padEnd(12);
      const title = entry.title.length > 40 ? entry.title.slice(0, 37) + "..." : entry.title.padEnd(40);
      uiInfo(`  ${id}  ${title} ${entry.action}`);
    }
    uiSuccess(`${prefix}${result.reconciled.length} task(s) reconciled.`);
  }

  if (result.orphanedCleaned > 0) {
    uiWarn(`${prefix}${result.orphanedCleaned} orphaned worktree(s) cleaned up.`);
  }
}
