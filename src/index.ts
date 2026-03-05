#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, type Config } from "./config.js";
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
import { gatherProjectContext, formatContextForPrompt } from "./context.js";
import { autoInit } from "./init.js";

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

const program = new Command();

function isVerbose(): boolean {
  return program.opts()["verbose"] === true;
}

program
  .name("hootl")
  .version("0.1.0")
  .description("hootl — a task orchestrator powered by Claude")
  .option("-v, --verbose", "Show Claude's output in real-time")
  .action(async () => {
    try {
      await autoInit();
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

      await autoInit();

      uiSuccess("Initialized .hootl/ directory.");
      uiInfo("Created: .hootl/config.json, .hootl/tasks/, .hootl/logs/");
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function planCommand(cliMode?: { fromSpec?: boolean; goal?: string; analyze?: boolean; next?: boolean }): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  const ctx = await uiSpinner("Gathering project context...", () =>
    gatherProjectContext(backend),
  );
  const formattedContext = formatContextForPrompt(ctx);

  let mode: string | undefined;

  if (cliMode?.fromSpec) {
    mode = "From spec (auto-detect gaps)";
  } else if (cliMode?.goal !== undefined) {
    mode = "Break down a goal";
  } else if (cliMode?.analyze) {
    mode = "Analyze codebase";
  } else if (cliMode?.next) {
    mode = "Suggest what's next";
  } else {
    mode = await uiChoose("Planning mode:", [
      "From spec (auto-detect gaps)",
      "Break down a goal",
      "Analyze codebase",
      "Suggest what's next",
    ]);
  }

  let prompt: string;

  switch (mode) {
    case "From spec (auto-detect gaps)":
      prompt =
        `You are a task planner for a software project. You have access to the project specification, current codebase structure, and existing tasks.\n\n` +
        `Your job: Compare the spec against what's already built and create tasks for the GAPS — features, commands, or behaviors described in the spec that are not yet implemented.\n\n` +
        `Rules:\n` +
        `- Do NOT create tasks for things that already exist and work\n` +
        `- Each task should be independently implementable\n` +
        `- Include enough detail in the description for an AI to implement it without further guidance\n` +
        `- Order tasks from highest to lowest priority (most foundational first)\n` +
        `- If a task depends on another, note it in the description\n\n` +
        `Return ONLY a JSON array of objects with "title", "description", and "priority" fields.\n` +
        `Priority must be one of: "critical", "high", "medium", "low".\n\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    case "Break down a goal": {
      const goal = cliMode?.goal ?? await uiInput("Describe the goal:");
      prompt =
        `You are a task planner. Break down the following goal into concrete, ` +
        `actionable coding tasks. For each task provide a title, description, and priority. ` +
        `Return ONLY a JSON array of objects with "title", "description", and "priority" fields.\n` +
        `Priority must be one of: "critical", "high", "medium", "low".\n\n` +
        `Goal: ${goal}\n\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    }
    case "Analyze codebase":
      prompt =
        `You are a task planner. Analyze the current codebase and suggest tasks ` +
        `for improvements, refactors, or missing features. ` +
        `Return ONLY a JSON array of objects with "title", "description", and "priority" fields.\n` +
        `Priority must be one of: "critical", "high", "medium", "low".\n\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    case "Suggest what's next":
      prompt =
        `You are a task planner. Given the project context below, ` +
        `suggest what should be worked on next. ` +
        `Return ONLY a JSON array of objects with "title", "description", and "priority" fields.\n` +
        `Priority must be one of: "critical", "high", "medium", "low".\n\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    default:
      return;
  }

  const verbose = isVerbose();
  const result = await uiSpinner("Thinking...", () =>
    invokeClaude({ prompt, verbose }),
  );

  if (result.exitCode !== 0) {
    uiError(`Claude returned exit code ${result.exitCode}`);
    return;
  }

  let tasks: Array<{ title: string; description: string; priority?: string }>;
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
    tasks = parsed as Array<{ title: string; description: string; priority?: string }>;
  } catch {
    uiError("Could not parse task suggestions from Claude response.");
    uiInfo("Raw response:\n" + result.output);
    return;
  }

  const validPriorities = new Set(["critical", "high", "medium", "low"]);
  const priorityCounts = new Map<string, number>();

  for (const task of tasks) {
    const priority =
      typeof task.priority === "string" && validPriorities.has(task.priority)
        ? (task.priority as "critical" | "high" | "medium" | "low")
        : undefined;

    const created = await backend.createTask({
      title: task.title,
      description: task.description,
      priority,
    });

    const label = priority ?? "medium";
    priorityCounts.set(label, (priorityCounts.get(label) ?? 0) + 1);

    uiInfo(`Created task ${created.id}: ${created.title} [${label}]`);
  }

  uiSuccess(`Created ${tasks.length} task(s).`);

  const summaryParts: string[] = [];
  for (const level of ["critical", "high", "medium", "low"]) {
    const count = priorityCounts.get(level);
    if (count !== undefined && count > 0) {
      summaryParts.push(`${level}: ${count}`);
    }
  }
  if (summaryParts.length > 0) {
    uiInfo(`Priority breakdown: ${summaryParts.join(", ")}`);
  }
}

program
  .command("plan")
  .description("Plan tasks using Claude")
  .option("--from-spec", "Auto-detect gaps from project spec")
  .option("--goal <goal>", "Break down a specific goal into tasks")
  .option("--analyze", "Analyze codebase for improvements")
  .option("--next", "Suggest what to work on next")
  .action(async (options: { fromSpec?: boolean; goal?: string; analyze?: boolean; next?: boolean }) => {
    try {
      await planCommand(options);
    } catch (err: unknown) {
      uiError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

async function runCommand(taskId?: string): Promise<void> {
  await autoInit();
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
  await runCompletionLoop(targetTask, backend, config, isVerbose());
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
  await autoInit();
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
  await autoInit();
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
