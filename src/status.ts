import { writeFile } from "node:fs/promises";
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

export async function writeStatusSummary(
  hootlDir: string,
  tasks: Task[],
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

  for (const state of STATE_ORDER) {
    const stateTasks = grouped.get(state);
    if (!stateTasks || stateTasks.length === 0) continue;

    lines.push(`## ${state.toUpperCase()} (${stateTasks.length})`);
    for (const task of stateTasks) {
      let detail = `- [${task.id}] ${task.title}`;
      if (task.state === "in_progress" || task.state === "review") {
        detail += ` — ${task.confidence}% confidence, attempt ${task.attempts}`;
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
