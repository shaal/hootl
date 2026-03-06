import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskState } from "./tasks/types.js";

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

export async function writeStatusSummary(
  hootlDir: string,
  tasks: Task[],
  claimInfo?: ActiveInstanceInfo,
): Promise<void> {
  const grouped = new Map<TaskState, Task[]>();
  for (const task of tasks) {
    const existing = grouped.get(task.state);
    if (existing) {
      existing.push(task);
    } else {
      grouped.set(task.state, [task]);
    }
  }

  const lines: string[] = ["# hootl Status\n"];
  const now = new Date().toISOString();
  lines.push(`_Updated: ${now}_\n`);

  if (claimInfo !== undefined) {
    lines.push(`Active instances: ${claimInfo.count}\n`);
  }

  for (const state of STATE_ORDER) {
    const stateTasks = grouped.get(state);
    if (!stateTasks || stateTasks.length === 0) continue;

    lines.push(`## ${state.toUpperCase()} (${stateTasks.length})`);
    for (const task of stateTasks) {
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
      lines.push(detail);
    }
    lines.push("");
  }

  await writeFile(join(hootlDir, "status.md"), lines.join("\n") + "\n", "utf-8");
}
