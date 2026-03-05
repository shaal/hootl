#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, ConfigSchema, type Config } from "./config.js";
import { LocalTaskBackend } from "./tasks/local.js";
import type { TaskBackend, Task, TaskState } from "./tasks/types.js";
import { writeStatusSummary } from "./status.js";
import { invokeClaude } from "./invoke.js";
import {
  uiChoose,
  uiInput,
  uiInfo,
  uiError,
  uiWarn,
  uiSuccess,
  uiSpinner,
} from "./ui.js";

function getBackend(config: Config): TaskBackend {
  const tasksDir = join(process.cwd(), ".hootl", "tasks");
  const hootlDir = join(process.cwd(), ".hootl");
  if (config.notifications.summaryFile) {
    return new LocalTaskBackend(tasksDir, async (tasks) => {
      await writeStatusSummary(hootlDir, tasks);
    });
  }
  return new LocalTaskBackend(tasksDir);
}

function ensureInitialized(): void {
  const hootlDir = join(process.cwd(), ".hootl");
  if (!existsSync(hootlDir)) {
    throw new Error(
      "This project has not been initialized. Run `hootl init` first.",
    );
  }
}

const program = new Command();

program
  .name("hootl")
  .version("0.1.0")
  .description("hootl — a task orchestrator powered by Claude")
  .action(async () => {
    try {
      const choice = await uiChoose("What would you like to do?", [
        "Plan tasks",
        "Run next task",
        "View status",
        "Resolve blockers",
        "Exit",
      ]);

      switch (choice) {
        case "Plan tasks":
          await planCommand();
          break;
        case "Run next task":
          await runCommand();
          break;
        case "View status":
          await statusCommand();
          break;
        case "Resolve blockers":
          await clarifyCommand();
          break;
        case "Exit":
          break;
      }
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description("Initialize a .hootl/ directory in the current project")
  .option("--template <name>", "Template name (reserved for future use)")
  .action(async () => {
    try {
      const hootlDir = join(process.cwd(), ".hootl");

      if (existsSync(hootlDir)) {
        uiWarn(".hootl/ already exists — skipping initialization.");
        return;
      }

      await mkdir(join(hootlDir, "tasks"), { recursive: true });
      await mkdir(join(hootlDir, "logs"), { recursive: true });

      const defaultConfig = ConfigSchema.parse({});
      await writeFile(
        join(hootlDir, "config.json"),
        JSON.stringify(defaultConfig, null, 2) + "\n",
        "utf-8",
      );

      await writeFile(
        join(hootlDir, ".gitignore"),
        "tasks/\nlogs/\nstatus.md\n",
        "utf-8",
      );

      uiSuccess("Initialized .hootl/ directory.");
      uiInfo("Created: .hootl/config.json, .hootl/tasks/, .hootl/logs/");
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function planCommand(): Promise<void> {
  ensureInitialized();
  const config = await loadConfig();
  const backend = getBackend(config);

  const mode = await uiChoose("Planning mode:", [
    "Analyze codebase",
    "Break down a goal",
    "Suggest what's next",
  ]);

  let prompt: string;

  switch (mode) {
    case "Break down a goal": {
      const goal = await uiInput("Describe the goal:");
      prompt =
        `You are a task planner. Break down the following goal into concrete, ` +
        `actionable coding tasks. For each task provide a title and description. ` +
        `Return ONLY a JSON array of objects with "title" and "description" fields.\n\n` +
        `Goal: ${goal}`;
      break;
    }
    case "Analyze codebase":
      prompt =
        `You are a task planner. Analyze the current codebase and suggest tasks ` +
        `for improvements, refactors, or missing features. ` +
        `Return ONLY a JSON array of objects with "title" and "description" fields.`;
      break;
    case "Suggest what's next": {
      const existingTasks = await backend.listTasks();
      const taskSummary = existingTasks
        .map((t) => `- [${t.state}] ${t.title}`)
        .join("\n");
      prompt =
        `You are a task planner. Given the current tasks:\n${taskSummary}\n\n` +
        `Suggest what should be worked on next. ` +
        `Return ONLY a JSON array of objects with "title" and "description" fields.`;
      break;
    }
    default:
      return;
  }

  const result = await uiSpinner("Thinking...", () =>
    invokeClaude({ prompt, outputFormat: "text" }),
  );

  if (result.exitCode !== 0) {
    uiError(`Claude returned exit code ${result.exitCode}`);
    return;
  }

  let tasks: Array<{ title: string; description: string }>;
  try {
    // Try to extract JSON array from the response (may be wrapped in markdown)
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (jsonMatch === null) {
      throw new Error("No JSON array found in response");
    }
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      throw new Error("Response is not an array");
    }
    tasks = parsed as Array<{ title: string; description: string }>;
  } catch {
    uiError("Could not parse task suggestions from Claude response.");
    uiInfo("Raw response:\n" + result.output);
    return;
  }

  for (const task of tasks) {
    const created = await backend.createTask({
      title: task.title,
      description: task.description,
    });
    uiInfo(`Created task ${created.id}: ${created.title}`);
  }

  uiSuccess(`Created ${tasks.length} task(s).`);
}

program
  .command("plan")
  .description("Plan tasks using Claude")
  .action(async () => {
    try {
      await planCommand();
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function runCommand(taskId?: string): Promise<void> {
  ensureInitialized();
  const config = await loadConfig();
  const backend = getBackend(config);

  let targetTask: Task | undefined;

  if (taskId !== undefined) {
    targetTask = await backend.getTask(taskId);
  } else {
    const readyTasks = await backend.listTasks({ state: "ready" });
    if (readyTasks.length > 0) {
      targetTask = readyTasks[0];
    } else {
      const inProgressTasks = await backend.listTasks({ state: "in_progress" });
      if (inProgressTasks.length > 0) {
        targetTask = inProgressTasks[0];
        if (targetTask) uiInfo(`Resuming in-progress task: ${targetTask.id}`);
      }
    }
  }

  if (targetTask === undefined) {
    uiWarn("No tasks available to run. Try `hootl plan` to create some.");
    return;
  }

  uiInfo(`Running task ${targetTask.id}: ${targetTask.title}`);

  const { runCompletionLoop } = await import("./loop.js");
  await runCompletionLoop(targetTask, backend, config);
}

program
  .command("run [taskId]")
  .description("Run a task (or the next ready task)")
  .action(async (taskId?: string) => {
    try {
      await runCommand(taskId);
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function statusCommand(): Promise<void> {
  ensureInitialized();
  const config = await loadConfig();
  const backend = getBackend(config);

  const allTasks = await backend.listTasks();

  if (allTasks.length === 0) {
    uiInfo("No tasks found. Run `hootl plan` to create some.");
    return;
  }

  const grouped = new Map<TaskState, Task[]>();
  for (const task of allTasks) {
    const existing = grouped.get(task.state);
    if (existing !== undefined) {
      existing.push(task);
    } else {
      grouped.set(task.state, [task]);
    }
  }

  const stateOrder: TaskState[] = [
    "in_progress",
    "ready",
    "blocked",
    "review",
    "proposed",
    "done",
  ];

  const lines: string[] = [];
  lines.push("# Task Status\n");

  for (const state of stateOrder) {
    const tasks = grouped.get(state);
    if (tasks === undefined || tasks.length === 0) continue;

    const header = `## ${state.toUpperCase()} (${tasks.length})`;
    lines.push(header);
    uiInfo(header);

    for (const task of tasks) {
      const line =
        `  ${task.id}: ${task.title} ` +
        `[confidence: ${task.confidence}, attempts: ${task.attempts}]`;
      lines.push(line);
      uiInfo(line);
    }

    lines.push("");
    uiInfo("");
  }

  if (config.notifications.summaryFile) {
    const summaryPath = join(process.cwd(), ".hootl", "status.md");
    await writeFile(summaryPath, lines.join("\n") + "\n", "utf-8");
    uiInfo(`Summary written to .hootl/status.md`);
  }
}

program
  .command("status")
  .description("View task status grouped by state")
  .action(async () => {
    try {
      await statusCommand();
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function clarifyCommand(): Promise<void> {
  ensureInitialized();
  const config = await loadConfig();
  const backend = getBackend(config);

  const blockedTasks = await backend.listTasks({ state: "blocked" });

  if (blockedTasks.length === 0) {
    uiInfo("No blocked tasks found.");
    return;
  }

  for (const task of blockedTasks) {
    uiInfo(`\nBlocked task ${task.id}: ${task.title}`);

    const blockersPath = join(
      process.cwd(),
      ".hootl",
      "tasks",
      task.id,
      "blockers.md",
    );

    let blockersContent: string;
    try {
      blockersContent = await readFile(blockersPath, "utf-8");
    } catch {
      blockersContent = "";
    }

    if (blockersContent.trim() === "") {
      uiInfo("  No blockers documented.");
      if (task.blockers.length > 0) {
        uiInfo("  Blockers from task metadata:");
        for (const blocker of task.blockers) {
          uiInfo(`    - ${blocker}`);
        }
      }
    } else {
      uiInfo("  Blockers:\n" + blockersContent);
    }

    const action = await uiChoose(`What to do with ${task.id}?`, [
      "Provide answers",
      "Skip for now",
      "Mark as ready (blockers resolved)",
    ]);

    switch (action) {
      case "Provide answers": {
        const answer = await uiInput("Your answer/resolution:");
        const timestamp = new Date().toISOString();
        const updatedContent =
          blockersContent +
          `\n---\n## Resolution (${timestamp})\n${answer}\n`;
        await writeFile(blockersPath, updatedContent, "utf-8");
        await backend.updateTask(task.id, {
          state: "ready",
          blockers: [],
        });
        uiSuccess(`Task ${task.id} moved back to ready.`);
        break;
      }
      case "Mark as ready (blockers resolved)":
        await backend.updateTask(task.id, {
          state: "ready",
          blockers: [],
        });
        uiSuccess(`Task ${task.id} moved back to ready.`);
        break;
      case "Skip for now":
        break;
    }
  }
}

program
  .command("clarify")
  .description("Resolve blockers on blocked tasks")
  .action(async () => {
    try {
      await clarifyCommand();
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.parse();
