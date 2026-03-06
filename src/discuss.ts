import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { LocalTaskBackend } from "./tasks/local.js";
import { getClaudeEnv } from "./invoke.js";
import { readFileOrEmpty } from "./loop.js";
import type { Task } from "./tasks/types.js";
import { uiChoose, uiInfo, uiWarn } from "./ui.js";

export interface DiscussTaskContext {
  title: string;
  description: string;
  state: string;
  taskBlockers: string[];
  plan?: string;
  progress?: string;
  testResults?: string;
  blockers?: string;
}

export function buildDiscussArgs(
  taskContext?: DiscussTaskContext,
  claudeMdPath?: string,
): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  if (taskContext !== undefined) {
    const sections: string[] = [
      `# Task: ${taskContext.title}`,
      "",
      `## Description`,
      taskContext.description,
      "",
      `## State`,
      taskContext.state,
    ];

    if (taskContext.plan !== undefined && taskContext.plan.trim() !== "") {
      sections.push("", "## Current Plan", taskContext.plan.trim());
    }

    if (taskContext.progress !== undefined && taskContext.progress.trim() !== "") {
      sections.push("", "## Progress So Far", taskContext.progress.trim());
    }

    if (
      taskContext.testResults !== undefined &&
      taskContext.testResults.trim() !== ""
    ) {
      sections.push("", "## Test Results", taskContext.testResults.trim());
    }

    if (taskContext.blockers !== undefined && taskContext.blockers.trim() !== "") {
      sections.push("", "## Blockers", taskContext.blockers.trim());
    }

    if (taskContext.taskBlockers.length > 0) {
      sections.push(
        "",
        "## Task Blockers",
        ...taskContext.taskBlockers.map((b) => `- ${b}`),
      );
    }

    if (claudeMdPath !== undefined) {
      sections.push(
        "",
        "## Project Context",
        `Read ${claudeMdPath} for codebase context and project conventions.`,
      );
    }

    args.push("--system-prompt", sections.join("\n"));
  } else if (claudeMdPath !== undefined) {
    const sections: string[] = [
      "# Project Context",
      "",
      `Read ${claudeMdPath} for codebase context and project conventions.`,
    ];
    args.push("--system-prompt", sections.join("\n"));
  }

  return args;
}

const GENERAL_DISCUSSION_CHOICE = "General discussion (no task context)";

export function formatTaskChoice(task: Task): string {
  return `[${task.id}] ${task.title} (${task.state}, ${task.confidence}%)`;
}

export function parseTaskIdFromChoice(choice: string): string | undefined {
  const match = /^\[([^\]]+)\]/.exec(choice);
  return match?.[1];
}

async function loadTaskContext(
  taskId: string,
  tasksDir: string,
  backend: LocalTaskBackend,
): Promise<{ context: DiscussTaskContext; task: Task } | undefined> {
  const task = await backend.getTask(taskId);
  if (task === undefined) {
    return undefined;
  }

  const taskDir = join(tasksDir, taskId);
  const [plan, progress, testResults, blockers] = await Promise.all([
    readFileOrEmpty(join(taskDir, "plan.md")),
    readFileOrEmpty(join(taskDir, "progress.md")),
    readFileOrEmpty(join(taskDir, "test_results.md")),
    readFileOrEmpty(join(taskDir, "blockers.md")),
  ]);

  return {
    context: {
      title: task.title,
      description: task.description,
      state: task.state,
      taskBlockers: task.blockers,
      plan,
      progress,
      testResults,
      blockers,
    },
    task,
  };
}

export async function discussCommand(taskId?: string): Promise<void> {
  let taskContext: DiscussTaskContext | undefined;

  const claudeMdFile = join(process.cwd(), "CLAUDE.md");
  const claudeMdPath = existsSync(claudeMdFile) ? claudeMdFile : undefined;

  if (taskId !== undefined) {
    const tasksDir = join(process.cwd(), ".hootl", "tasks");
    const backend = new LocalTaskBackend(tasksDir);

    const result = await loadTaskContext(taskId, tasksDir, backend);
    if (result === undefined) {
      uiWarn(`Task ${taskId} not found.`);
      return;
    }

    taskContext = result.context;
    uiInfo(`Launching Claude session with context from task ${taskId}: ${result.task.title}`);
  } else {
    // No task ID provided — offer interactive picker
    const tasksDir = join(process.cwd(), ".hootl", "tasks");
    const backend = new LocalTaskBackend(tasksDir);

    const allTasks = await backend.listTasks();

    if (allTasks.length > 0) {
      const choices = [
        GENERAL_DISCUSSION_CHOICE,
        ...allTasks.map(formatTaskChoice),
      ];
      const selected = await uiChoose("Select a task to discuss:", choices);

      if (selected !== GENERAL_DISCUSSION_CHOICE) {
        const selectedId = parseTaskIdFromChoice(selected);
        if (selectedId !== undefined) {
          const result = await loadTaskContext(selectedId, tasksDir, backend);
          if (result !== undefined) {
            taskContext = result.context;
            uiInfo(`Launching Claude session with context from task ${selectedId}: ${result.task.title}`);
          }
        }
      }
    }

    if (taskContext === undefined) {
      uiInfo("Launching interactive Claude session...");
    }
  }

  const args = buildDiscussArgs(taskContext, claudeMdPath);

  const result = await execa("claude", args, {
    stdio: "inherit",
    reject: false,
    env: getClaudeEnv(),
  });

  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    uiWarn(`Claude exited with code ${result.exitCode}`);
  }
}
