import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskState } from "./tasks/types.js";
import type { Goal } from "./goals.js";

const STATE_ORDER: TaskState[] = [
  "in_progress",
  "ready",
  "blocked",
  "review",
  "proposed",
  "done",
];

export interface ClaimData {
  pid: number;
  startedAt: string;
}

export interface ActiveInstanceInfo {
  count: number;
  pids: Map<string, number>;
}

/**
 * Read and parse a `.claim` file from a task directory.
 * Returns null on missing, corrupt, or unreadable files.
 */
export async function readClaimFile(taskDir: string): Promise<ClaimData | null> {
  try {
    const raw = await readFile(join(taskDir, ".claim"), "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data !== null &&
      "pid" in data &&
      typeof (data as Record<string, unknown>).pid === "number" &&
      "startedAt" in data &&
      typeof (data as Record<string, unknown>).startedAt === "string"
    ) {
      return { pid: (data as ClaimData).pid, startedAt: (data as ClaimData).startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether a process is still alive via kill(pid, 0).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan all task directories for `.claim` files with live PIDs.
 * Returns the count of active instances and a map of taskId -> PID.
 */
export async function getActiveInstances(tasksDir: string): Promise<ActiveInstanceInfo> {
  const pids = new Map<string, number>();
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return { count: 0, pids };
  }

  for (const entry of entries) {
    const taskDir = join(tasksDir, entry);
    const claim = await readClaimFile(taskDir);
    if (claim !== null && isProcessAlive(claim.pid)) {
      pids.set(entry, claim.pid);
    }
  }

  return { count: pids.size, pids };
}

/**
 * Check whether parallel execution is safe.
 * Returns blocked=true when other instances are active and worktrees are disabled.
 */
export async function checkParallelGate(
  tasksDir: string,
  useWorktrees: boolean,
  deps?: { getActiveInstances?: (dir: string) => Promise<ActiveInstanceInfo> },
): Promise<{ blocked: boolean; activeCount: number }> {
  const getInstances = deps?.getActiveInstances ?? getActiveInstances;
  const { count } = await getInstances(tasksDir);
  if (count > 0 && !useWorktrees) {
    return { blocked: true, activeCount: count };
  }
  return { blocked: false, activeCount: count };
}

/**
 * Format a single task line for status output.
 */
function formatTaskLine(task: Task, claimInfo?: ActiveInstanceInfo): string {
  const upTag = task.userPriority !== null ? ` [#${task.userPriority}]` : "";
  let detail = `- [${task.id}]${upTag} ${task.title}`;
  if (task.state === "in_progress" || task.state === "review") {
    detail += ` — ${task.confidence}% confidence, attempt ${task.attempts}`;
    if (task.state === "in_progress" && claimInfo !== undefined && claimInfo.pids.has(task.id)) {
      detail += ` (PID: ${claimInfo.pids.get(task.id)})`;
    }
  }
  if (task.state === "blocked" && task.blockers.length > 0) {
    detail += ` — ${task.blockers[0]}`;
  }
  if (task.state === "done") {
    detail += ` — completed ${task.updatedAt.split("T")[0]}`;
  }
  return detail;
}

/**
 * Render tasks grouped by state into lines (flat mode, no goal grouping).
 */
function renderFlat(tasks: Task[], claimInfo?: ActiveInstanceInfo): string[] {
  const grouped = new Map<TaskState, Task[]>();
  for (const task of tasks) {
    const existing = grouped.get(task.state);
    if (existing) {
      existing.push(task);
    } else {
      grouped.set(task.state, [task]);
    }
  }

  const lines: string[] = [];
  for (const state of STATE_ORDER) {
    const stateTasks = grouped.get(state);
    if (!stateTasks || stateTasks.length === 0) continue;

    lines.push(`## ${state.toUpperCase()} (${stateTasks.length})`);
    for (const task of stateTasks) {
      lines.push(formatTaskLine(task, claimInfo));
    }
    lines.push("");
  }
  return lines;
}

/**
 * Render tasks grouped by goal, with sub-groups by state within each goal.
 */
function renderByGoal(tasks: Task[], goals: Goal[], claimInfo?: ActiveInstanceInfo): string[] {
  // Build a map of goalId -> Goal for lookup
  const goalMap = new Map<string, Goal>();
  for (const goal of goals) {
    goalMap.set(goal.id, goal);
  }

  // Partition tasks by goal
  const goalTasks = new Map<string, Task[]>();
  const ungrouped: Task[] = [];

  for (const task of tasks) {
    if (task.goal !== null && goalMap.has(task.goal)) {
      const existing = goalTasks.get(task.goal);
      if (existing) {
        existing.push(task);
      } else {
        goalTasks.set(task.goal, [task]);
      }
    } else {
      ungrouped.push(task);
    }
  }

  const lines: string[] = [];

  // Render each goal in the order they appear in the goals registry
  for (const goal of goals) {
    const tasksForGoal = goalTasks.get(goal.id);
    if (!tasksForGoal || tasksForGoal.length === 0) continue;

    const doneCount = tasksForGoal.filter((t) => t.state === "done").length;
    lines.push(`## ${goal.title} (${doneCount}/${tasksForGoal.length} done)`);

    // Sub-group by state within this goal
    const stateGrouped = new Map<TaskState, Task[]>();
    for (const task of tasksForGoal) {
      const existing = stateGrouped.get(task.state);
      if (existing) {
        existing.push(task);
      } else {
        stateGrouped.set(task.state, [task]);
      }
    }

    for (const state of STATE_ORDER) {
      const stateTasks = stateGrouped.get(state);
      if (!stateTasks || stateTasks.length === 0) continue;

      lines.push(`### ${state.toUpperCase()} (${stateTasks.length})`);
      for (const task of stateTasks) {
        lines.push(formatTaskLine(task, claimInfo));
      }
    }
    lines.push("");
  }

  // Render ungrouped tasks at the bottom
  if (ungrouped.length > 0) {
    const doneCount = ungrouped.filter((t) => t.state === "done").length;
    lines.push(`## Ungrouped (${doneCount}/${ungrouped.length} done)`);

    const stateGrouped = new Map<TaskState, Task[]>();
    for (const task of ungrouped) {
      const existing = stateGrouped.get(task.state);
      if (existing) {
        existing.push(task);
      } else {
        stateGrouped.set(task.state, [task]);
      }
    }

    for (const state of STATE_ORDER) {
      const stateTasks = stateGrouped.get(state);
      if (!stateTasks || stateTasks.length === 0) continue;

      lines.push(`### ${state.toUpperCase()} (${stateTasks.length})`);
      for (const task of stateTasks) {
        lines.push(formatTaskLine(task, claimInfo));
      }
    }
    lines.push("");
  }

  return lines;
}

export async function writeStatusSummary(
  hootlDir: string,
  tasks: Task[],
  claimInfo?: ActiveInstanceInfo,
  goals?: Goal[],
): Promise<void> {
  const lines: string[] = ["# hootl Status\n"];
  const now = new Date().toISOString();
  lines.push(`_Updated: ${now}_\n`);

  if (claimInfo !== undefined) {
    lines.push(`Active instances: ${claimInfo.count}\n`);
  }

  if (goals !== undefined && goals.length > 0) {
    lines.push(...renderByGoal(tasks, goals, claimInfo));
  } else {
    lines.push(...renderFlat(tasks, claimInfo));
  }

  await writeFile(join(hootlDir, "status.md"), lines.join("\n") + "\n", "utf-8");
}
