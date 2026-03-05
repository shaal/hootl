import { execa } from "execa";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { LocalTaskBackend } from "./tasks/local.js";
import { getClaudeEnv } from "./invoke.js";
import { uiInfo, uiWarn } from "./ui.js";

export interface DiscussTaskContext {
  title: string;
  description: string;
  plan?: string;
  progress?: string;
  blockers?: string;
}

export function buildDiscussArgs(taskContext?: DiscussTaskContext): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  if (taskContext !== undefined) {
    const sections: string[] = [
      `# Task: ${taskContext.title}`,
      "",
      `## Description`,
      taskContext.description,
    ];

    if (taskContext.plan !== undefined && taskContext.plan.trim() !== "") {
      sections.push("", "## Current Plan", taskContext.plan.trim());
    }

    if (taskContext.progress !== undefined && taskContext.progress.trim() !== "") {
      sections.push("", "## Progress So Far", taskContext.progress.trim());
    }

    if (taskContext.blockers !== undefined && taskContext.blockers.trim() !== "") {
      sections.push("", "## Blockers", taskContext.blockers.trim());
    }

    args.push("--system-prompt", sections.join("\n"));
  }

  return args;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

export async function discussCommand(taskId?: string): Promise<void> {
  let taskContext: DiscussTaskContext | undefined;

  if (taskId !== undefined) {
    const config = await loadConfig();
    const tasksDir = join(process.cwd(), ".hootl", "tasks");
    const backend = new LocalTaskBackend(tasksDir);

    const task = await backend.getTask(taskId);
    if (task === undefined) {
      uiWarn(`Task ${taskId} not found.`);
      return;
    }

    const taskDir = join(tasksDir, taskId);
    const [plan, progress, blockers] = await Promise.all([
      readFileOrEmpty(join(taskDir, "plan.md")),
      readFileOrEmpty(join(taskDir, "progress.md")),
      readFileOrEmpty(join(taskDir, "blockers.md")),
    ]);

    taskContext = {
      title: task.title,
      description: task.description,
      plan: plan || undefined,
      progress: progress || undefined,
      blockers: blockers || undefined,
    };

    uiInfo(`Launching Claude session with context from task ${taskId}: ${task.title}`);
  } else {
    uiInfo("Launching interactive Claude session...");
  }

  const args = buildDiscussArgs(taskContext);

  const result = await execa("claude", args, {
    stdio: "inherit",
    reject: false,
    env: getClaudeEnv(),
  });

  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    uiWarn(`Claude exited with code ${result.exitCode}`);
  }
}
