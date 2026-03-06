#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, loadJsonFile, saveProjectConfig, HOOK_TRIGGERS, HookSchema, type Config } from "./config.js";
import { LocalTaskBackend } from "./tasks/local.js";
import type { TaskBackend, Task, TaskState } from "./tasks/types.js";
import { writeStatusSummary } from "./status.js";
import { invokeClaude } from "./invoke.js";
import {
  uiChoose,
  uiChooseMultiple,
  uiInput,
  uiInfo,
  uiError,
  uiWarn,
  uiSuccess,
  uiSpinner,
  errorMsg,
} from "./ui.js";
import { gatherProjectContext, formatContextForPrompt } from "./context.js";
import { autoInit } from "./init.js";
import { checkGlobalBudget } from "./budget.js";
import { discussCommand } from "./discuss.js";
import { findRunnableTask } from "./selection.js";
import { syncReviewTasks } from "./sync.js";
import { inferDependencies, resolveIndicesToIds } from "./dependencies.js";
import {
  generateClarifyingQuestions,
  collectAnswers,
  formatConstraints,
} from "./guided.js";
import { critiquePlan } from "./plan-review.js";
import { generatePlanSummary, confirmPlan } from "./plan-summary.js";
import { formatPlanningMemoryContext } from "./plan-memory.js";
import { extractTaskArray } from "./parse-tasks.js";

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
        "Auto mode",
        "Prioritize tasks",
        "View status",
        "Resolve blockers",
        "Discuss with Claude",
        "Exit",
      ]);

      switch (choice) {
        case "Plan tasks":
          await planCommand();
          break;
        case "Run next task":
          await runCommand();
          break;
        case "Auto mode":
          await autoCommand();
          break;
        case "Prioritize tasks":
          await prioritizeCommand();
          break;
        case "View status":
          await statusCommand();
          break;
        case "Resolve blockers":
          await clarifyCommand();
          break;
        case "Discuss with Claude":
          await discussCommand();
          break;
        case "Exit":
          break;
      }
    } catch (err: unknown) {
      uiError(errorMsg(err));
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

      await autoInit({ interactive: true });

      uiSuccess("Initialized .hootl/ directory.");
      uiInfo("Created: .hootl/config.json, .hootl/tasks/, .hootl/logs/");
      uiInfo("See .hootl/hooks-example.json for hook configuration reference.");
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

async function planCommand(cliMode?: { fromSpec?: boolean; goal?: string; analyze?: boolean; next?: boolean; guided?: boolean; noCritique?: boolean; yes?: boolean }): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  const ctx = await uiSpinner("Gathering project context...", () =>
    gatherProjectContext(backend),
  );
  let formattedContext = formatContextForPrompt(ctx);

  // Inject planning memory (lessons from previous tasks) into context
  try {
    const memoryContext = await formatPlanningMemoryContext(join(process.cwd(), ".hootl"));
    if (memoryContext !== "") {
      formattedContext += "\n\n" + memoryContext;
    }
  } catch {
    // Planning memory is best-effort — never block planning
  }

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

  const jsonSchemaInstruction =
    `Return ONLY a JSON array of objects with "title", "description", "priority", and optionally "dependsOn" fields.\n` +
    `Priority must be one of: "critical", "high", "medium", "low".\n` +
    `If a task depends on another task in this list being completed first, include a "dependsOn" array with the 0-based indices of those prerequisite tasks (e.g. "dependsOn": [0, 2] means this task depends on the 1st and 3rd tasks). Tasks with no dependencies should omit this field or use an empty array.\n`;

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
        `- Order tasks from highest to lowest priority (most foundational first)\n\n` +
        jsonSchemaInstruction + `\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    case "Break down a goal": {
      const goal = cliMode?.goal ?? await uiInput("Describe the goal:");

      let constraintsBlock = "";
      if (cliMode?.guided) {
        const questions = await uiSpinner("Analyzing goal...", () =>
          generateClarifyingQuestions(goal, formattedContext, isVerbose()),
        );
        if (questions.length > 0) {
          const answers = await collectAnswers(questions);
          constraintsBlock = formatConstraints(questions, answers);
        } else {
          uiWarn("No clarifying questions generated — proceeding with unguided planning.");
        }
      }

      prompt =
        `You are a task planner. Break down the following goal into concrete, ` +
        `actionable coding tasks. For each task provide a title, description, priority, and dependencies on other tasks in this batch. ` +
        jsonSchemaInstruction + `\n` +
        `Goal: ${goal}\n\n` +
        (constraintsBlock !== "" ? constraintsBlock + `\n\n` : "") +
        `<context>\n${formattedContext}\n</context>`;
      break;
    }
    case "Analyze codebase":
      prompt =
        `You are a task planner. Analyze the current codebase and suggest tasks ` +
        `for improvements, refactors, or missing features. ` +
        jsonSchemaInstruction + `\n` +
        `<context>\n${formattedContext}\n</context>`;
      break;
    case "Suggest what's next":
      prompt =
        `You are a task planner. Given the project context below, ` +
        `suggest what should be worked on next. ` +
        jsonSchemaInstruction + `\n` +
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

  let tasks: Array<{ title: string; description: string; priority?: string; type?: string; dependsOn?: number[] }>;
  try {
    const parsed = extractTaskArray(result.output);
    if (!parsed) {
      throw new Error("No valid JSON array found in response");
    }
    tasks = parsed;
  } catch {
    uiError("Could not parse task suggestions from Claude response.");
    uiInfo("Raw response:\n" + result.output);
    return;
  }

  // Critique pass: have Claude review the plan against the original goal
  if (cliMode?.noCritique !== true) {
    let goalDescription: string;
    switch (mode) {
      case "Break down a goal":
        goalDescription = cliMode?.goal ?? "User-provided goal (interactive)";
        break;
      case "From spec (auto-detect gaps)":
        goalDescription = "Find gaps between the project spec and current implementation, and create tasks to fill them.";
        break;
      case "Analyze codebase":
        goalDescription = "Analyze the current codebase and suggest tasks for improvements, refactors, or missing features.";
        break;
      case "Suggest what's next":
        goalDescription = "Suggest what should be worked on next given the project's current state.";
        break;
      default:
        goalDescription = "Plan tasks for the project.";
        break;
    }

    tasks = await uiSpinner("Reviewing plan...", () =>
      critiquePlan(goalDescription, tasks, verbose),
    );
  }

  // TL;DR summary + Accept/Revise/Cancel (skip with --yes)
  if (cliMode?.yes !== true) {
    let confirmed = false;
    while (!confirmed) {
      const summary = generatePlanSummary(tasks);
      const decision = await confirmPlan(summary);

      if (decision === "cancel") {
        uiWarn("Plan cancelled.");
        return;
      }

      if (decision === "accept") {
        confirmed = true;
      } else {
        // Revise: collect feedback and re-generate
        const feedback = await uiInput("What would you like to change?");
        if (feedback.trim() === "") {
          uiWarn("No feedback provided — showing summary again.");
          continue;
        }

        const revisedResult = await uiSpinner("Re-thinking...", () =>
          invokeClaude({
            prompt: prompt + `\n\nUser revision feedback: ${feedback}`,
            verbose,
          }),
        );

        if (revisedResult.exitCode !== 0) {
          uiError(`Claude returned exit code ${revisedResult.exitCode} during revision.`);
          return;
        }

        try {
          const jsonMatch = revisedResult.output.match(/\[[\s\S]*\]/);
          if (jsonMatch === null) {
            throw new Error("No JSON array found in revision response");
          }
          const parsed: unknown = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(parsed)) {
            throw new Error("Revision response is not an array");
          }
          tasks = parsed as Array<{ title: string; description: string; priority?: string; type?: string; dependsOn?: number[] }>;
        } catch {
          uiError("Could not parse revised tasks from Claude response.");
          uiWarn("Keeping the original plan.");
          confirmed = true;
        }

        // Optionally re-critique the revised plan
        if (!confirmed && cliMode?.noCritique !== true) {
          let goalDescription: string;
          switch (mode) {
            case "Break down a goal":
              goalDescription = cliMode?.goal ?? "User-provided goal (interactive)";
              break;
            case "From spec (auto-detect gaps)":
              goalDescription = "Find gaps between the project spec and current implementation, and create tasks to fill them.";
              break;
            case "Analyze codebase":
              goalDescription = "Analyze the current codebase and suggest tasks for improvements, refactors, or missing features.";
              break;
            case "Suggest what's next":
              goalDescription = "Suggest what should be worked on next given the project's current state.";
              break;
            default:
              goalDescription = "Plan tasks for the project.";
              break;
          }

          tasks = await uiSpinner("Reviewing revised plan...", () =>
            critiquePlan(goalDescription, tasks, verbose),
          );
        }
      }
    }
  }

  // Infer dependencies (uses Claude's dependsOn if provided, heuristic fallback otherwise)
  const depMap = inferDependencies(tasks);

  const validPriorities = new Set(["critical", "high", "medium", "low"]);
  const validTypes = new Set(["bug", "feature", "improvement", "chore"]);
  const priorityCounts = new Map<string, number>();
  const indexToId = new Map<number, string>();

  // Pass 1: Create all tasks (without dependencies)
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const priority =
      typeof task.priority === "string" && validPriorities.has(task.priority)
        ? (task.priority as "critical" | "high" | "medium" | "low")
        : undefined;
    const type =
      typeof task.type === "string" && validTypes.has(task.type)
        ? (task.type as "bug" | "feature" | "improvement" | "chore")
        : undefined;

    const created = await backend.createTask({
      title: task.title,
      description: task.description,
      priority,
      type,
    });

    indexToId.set(i, created.id);

    const label = priority ?? "medium";
    priorityCounts.set(label, (priorityCounts.get(label) ?? 0) + 1);

    uiInfo(`Created task ${created.id}: ${created.title} [${label}]`);
  }

  // Pass 2: Wire up dependencies now that all IDs are known
  const resolvedDeps = resolveIndicesToIds(depMap, indexToId);
  let depCount = 0;
  for (const [taskIdx, depIds] of resolvedDeps) {
    const taskId = indexToId.get(taskIdx);
    if (taskId !== undefined) {
      await backend.updateTask(taskId, { dependencies: depIds });
      depCount += depIds.length;
      uiInfo(`  ${taskId} depends on: ${depIds.join(", ")}`);
    }
  }

  uiSuccess(`Created ${tasks.length} task(s)${depCount > 0 ? ` with ${depCount} dependency link(s)` : ""}.`);

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
  .option("--guided", "Interactive clarification before planning (use with --goal)")
  .option("--no-critique", "Skip the plan self-review pass")
  .option("-y, --yes", "Auto-accept the plan without confirmation")
  .action(async (options: { fromSpec?: boolean; goal?: string; analyze?: boolean; next?: boolean; guided?: boolean; noCritique?: boolean; yes?: boolean }) => {
    try {
      await planCommand(options);
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

async function selectFromState(state: TaskState, backend: TaskBackend): Promise<Task | undefined> {
  const tasks = await backend.listTasks({ state });
  if (tasks.length === 0) return undefined;
  const { task, skipped } = await findRunnableTask(tasks, backend);
  for (const s of skipped) {
    uiWarn(`Skipping ${s.id} (${s.reason})`);
  }
  return task;
}

export async function autoCommand(
  cliLevel?: string,
  cliFlags?: { merge?: boolean; noMerge?: boolean },
): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  const level = cliLevel ?? config.auto.defaultLevel;
  if (level !== "conservative") {
    uiWarn(
      `Level "${level}" is not yet implemented — falling back to conservative.`,
    );
  }

  const costLogDir = join(process.cwd(), ".hootl", "logs");
  let tasksCompleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Sync externally merged branches before each iteration
    await syncReviewTasks(backend);

    // Check global budget before picking a task
    const { exceeded, todayCost } = await checkGlobalBudget(
      costLogDir,
      config.budgets.global,
    );
    if (exceeded) {
      uiError(
        `Global daily budget exceeded ($${todayCost.toFixed(2)} >= $${config.budgets.global.toFixed(2)}). Stopping auto mode.`,
      );
      break;
    }

    // Pick next task: prefer in-progress (resume), then ready
    let targetTask = await selectFromState("in_progress", backend);
    if (targetTask !== undefined) {
      uiInfo(`Resuming in-progress task: ${targetTask.id}`);
    } else {
      targetTask = await selectFromState("ready", backend);
    }

    if (targetTask === undefined) {
      uiSuccess("No more runnable tasks. Auto mode complete.");
      break;
    }

    uiInfo(`[auto] Running task ${targetTask.id}: ${targetTask.title}`);

    const { runCompletionLoop } = await import("./loop.js");
    await runCompletionLoop(
      targetTask,
      backend,
      config,
      isVerbose(),
      cliFlags,
    );
    tasksCompleted++;
  }

  uiInfo(`Auto mode finished. Tasks processed: ${tasksCompleted}.`);
}

async function runCommand(taskId?: string, cliFlags?: { merge?: boolean; noMerge?: boolean }): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  // Auto-promote review tasks whose branches have been merged or deleted
  await syncReviewTasks(backend);

  let targetTask: Task | undefined;

  if (taskId !== undefined) {
    targetTask = await backend.getTask(taskId);
  } else {
    // Prioritize in-progress tasks: finish started work before picking up new work
    targetTask = await selectFromState("in_progress", backend);
    if (targetTask) uiInfo(`Resuming in-progress task: ${targetTask.id}`);
    if (targetTask === undefined) {
      targetTask = await selectFromState("ready", backend);
    }
  }

  // Check global daily budget before starting any work
  const costLogDir = join(process.cwd(), ".hootl", "logs");
  const { exceeded, todayCost } = await checkGlobalBudget(
    costLogDir,
    config.budgets.global,
  );
  if (exceeded) {
    uiError(
      `Global daily budget exceeded ($${todayCost.toFixed(2)} >= $${config.budgets.global.toFixed(2)}). All work stopped. Adjust budgets.global or wait until tomorrow.`,
    );
    return;
  }

  if (targetTask === undefined) {
    uiWarn("No tasks available to run. Try `hootl plan` to create some.");
    return;
  }

  uiInfo(`Running task ${targetTask.id}: ${targetTask.title}`);

  const { runCompletionLoop } = await import("./loop.js");
  await runCompletionLoop(targetTask, backend, config, isVerbose(), cliFlags);
}

program
  .command("run [taskId]")
  .description("Run a task (or the next ready task)")
  .option("--merge", "Force auto-merge on confidence met")
  .option("--no-merge", "Disable auto-merge/PR on confidence met")
  .action(async (taskId: string | undefined, options: { merge?: boolean; noMerge?: boolean }) => {
    try {
      // Commander sets merge=false for --no-merge, so detect that case
      const cliFlags: { merge?: boolean; noMerge?: boolean } = {};
      if (options.merge === true) {
        cliFlags.merge = true;
      } else if (options.merge === false) {
        // Commander's --no-merge sets merge to false
        cliFlags.noMerge = true;
      }
      await runCommand(taskId, cliFlags);
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

program
  .command("auto")
  .description(
    "Autonomous mode — run tasks until queue is empty or budget exhausted",
  )
  .option(
    "--level <level>",
    "Automation level (conservative|moderate|proactive|full)",
  )
  .option("--merge", "Force auto-merge on confidence met")
  .option("--no-merge", "Disable auto-merge/PR on confidence met")
  .action(
    async (options: {
      level?: string;
      merge?: boolean;
      noMerge?: boolean;
    }) => {
      try {
        const cliFlags: { merge?: boolean; noMerge?: boolean } = {};
        if (options.merge === true) {
          cliFlags.merge = true;
        } else if (options.merge === false) {
          cliFlags.noMerge = true;
        }
        await autoCommand(options.level, cliFlags);
      } catch (err: unknown) {
        uiError(errorMsg(err));
        process.exitCode = 1;
      }
    },
  );

async function statusCommand(): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  // Auto-promote review tasks whose branches have been merged or deleted
  await syncReviewTasks(backend);

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
      const upTag = task.userPriority !== null ? ` [#${task.userPriority}]` : "";
      const line =
        `  ${task.id}: ${task.title} [${task.priority}]${upTag} ` +
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
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

async function prioritizeCommand(taskIds?: string[], clear?: boolean): Promise<void> {
  await autoInit();
  const config = await loadConfig();
  const backend = getBackend(config);

  if (clear) {
    const allTasks = await backend.listTasks();
    let cleared = 0;
    for (const task of allTasks) {
      if (task.userPriority !== null) {
        await backend.updateTask(task.id, { userPriority: null });
        cleared++;
      }
    }
    uiSuccess(`Cleared userPriority from ${cleared} task(s).`);
    return;
  }

  if (taskIds !== undefined && taskIds.length > 0) {
    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i]!;
      await backend.updateTask(id, { userPriority: i + 1 });
      uiInfo(`${id} → userPriority #${i + 1}`);
    }
    uiSuccess(`Set userPriority on ${taskIds.length} task(s).`);
    return;
  }

  // Interactive mode
  const readyTasks = await backend.listTasks({ state: "ready" });
  const inProgressTasks = await backend.listTasks({ state: "in_progress" });
  const candidates = [...inProgressTasks, ...readyTasks];

  if (candidates.length === 0) {
    uiWarn("No ready or in-progress tasks to prioritize.");
    return;
  }

  // Build display labels with dependency info
  const labels: string[] = [];
  for (const task of candidates) {
    let label = `${task.id} [${task.priority}] ${task.title}`;
    if (task.dependencies.length > 0) {
      const depDetails: string[] = [];
      for (const depId of task.dependencies) {
        try {
          const depTask = await backend.getTask(depId);
          depDetails.push(`${depId} (${depTask.state})`);
        } catch {
          depDetails.push(`${depId} (not found)`);
        }
      }
      label += ` — depends on: ${depDetails.join(", ")}`;
    }
    if (task.userPriority !== null) {
      label += ` [current: #${task.userPriority}]`;
    }
    labels.push(label);
  }

  const selected = await uiChooseMultiple(
    "Select tasks in priority order (first selected = highest priority):",
    labels,
  );

  if (selected.length === 0) {
    uiInfo("No tasks selected.");
    return;
  }

  for (let i = 0; i < selected.length; i++) {
    const label = selected[i]!;
    // Extract task ID from the label (first token)
    const id = label.split(" ")[0]!;
    await backend.updateTask(id, { userPriority: i + 1 });
    uiInfo(`${id} → userPriority #${i + 1}`);
  }
  uiSuccess(`Set userPriority on ${selected.length} task(s).`);
}

program
  .command("prioritize [taskIds...]")
  .description("Set user priority override on tasks")
  .option("--clear", "Remove all user priority overrides")
  .action(async (taskIds: string[], options: { clear?: boolean }) => {
    try {
      await prioritizeCommand(
        taskIds.length > 0 ? taskIds : undefined,
        options.clear,
      );
    } catch (err: unknown) {
      uiError(errorMsg(err));
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
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

program
  .command("discuss [taskId]")
  .description("Launch an interactive Claude session, optionally with task context")
  .action(async (taskId?: string) => {
    try {
      await discussCommand(taskId);
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

// --- hooks command group ---

const hooksCmd = program
  .command("hooks")
  .description("Hook management commands");

hooksCmd
  .command("test")
  .description("Test a hook against the current branch")
  .option("--skill <name>", "Skill name to test (e.g. simplify)")
  .option("--prompt <text>", "Inline prompt or file path")
  .option("--confidence <n>", "Confidence value for hook context", "95")
  .option("--dry-run", "Show resolved prompt without invoking Claude")
  .action(async (options: { skill?: string; prompt?: string; confidence: string; dryRun?: boolean }) => {
    try {
      const { getCurrentBranch, getBaseBranch } = await import("./git.js");
      const {
        buildTestHookContext,
        runHook,
        resolveSkill,
        buildHookPrompt,
        buildHookSystemPrompt,
      } = await import("./hooks.js");

      // Validate: exactly one of --skill or --prompt
      if (options.skill !== undefined && options.prompt !== undefined) {
        uiError("Specify either --skill or --prompt, not both.");
        process.exitCode = 1;
        return;
      }
      if (options.skill === undefined && options.prompt === undefined) {
        uiError("Specify --skill <name> or --prompt <text>.");
        process.exitCode = 1;
        return;
      }

      const confidence = parseInt(options.confidence, 10);
      if (Number.isNaN(confidence) || confidence < 0 || confidence > 100) {
        uiError("--confidence must be a number between 0 and 100.");
        process.exitCode = 1;
        return;
      }

      let branchName: string;
      let baseBranch: string;
      try {
        branchName = await getCurrentBranch();
        baseBranch = await getBaseBranch();
      } catch {
        uiError("Must be in a git repository to test hooks.");
        process.exitCode = 1;
        return;
      }

      const config = await loadConfig();
      const context = buildTestHookContext(config, branchName, baseBranch, confidence);

      const hook: import("./config.js").Hook = {
        trigger: "on_confidence_met",
        skill: options.skill,
        prompt: options.prompt,
        blocking: true,
      };

      if (options.dryRun) {
        // Dry-run: resolve the prompt and display it without invoking Claude
        if (options.skill !== undefined) {
          const skill = resolveSkill(options.skill);
          if (skill === undefined) {
            uiError(`Unknown skill: "${options.skill}"`);
            process.exitCode = 1;
            return;
          }
          const invokeOpts = await skill(context);
          uiInfo("=== System Prompt ===");
          uiInfo(invokeOpts.systemPrompt ?? "(none)");
          uiInfo("\n=== Prompt ===");
          uiInfo(invokeOpts.prompt);
        } else {
          const prompt = await buildHookPrompt(hook);
          const systemPrompt = buildHookSystemPrompt(context);
          uiInfo("=== System Prompt ===");
          uiInfo(systemPrompt);
          uiInfo("\n=== Prompt ===");
          uiInfo(prompt);
        }
        uiSuccess("Dry run complete — no Claude invocation.");
        return;
      }

      // Real invocation
      uiWarn("This will invoke Claude and incur API costs.");
      uiInfo(`Testing hook with confidence=${confidence}, branch=${branchName}, base=${baseBranch}`);

      const result = await runHook(hook, context);

      // Display result
      uiInfo("\n=== Hook Result ===");
      if (result.success) {
        uiSuccess("Result: PASS");
      } else {
        uiError("Result: FAIL");
      }

      if (result.issues.length > 0) {
        uiInfo("Issues:");
        for (const issue of result.issues) {
          uiInfo(`  - ${issue}`);
        }
      }

      if (result.remediationActions.length > 0) {
        uiInfo("Remediation actions:");
        for (const action of result.remediationActions) {
          uiInfo(`  - ${action}`);
        }
      }

      uiInfo(`Cost: $${result.costUsd.toFixed(4)}`);
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

hooksCmd
  .command("add")
  .description("Interactively add a new hook to the project config")
  .action(async () => {
    try {
      const { formatHookLabel } = await import("./hooks.js");

      // 1. Prompt for trigger
      const trigger = await uiChoose("Trigger point:", [...HOOK_TRIGGERS]);

      // 2. Prompt for skill vs prompt
      const hookType = await uiChoose("Hook type:", ["skill", "prompt"]);
      let skill: string | undefined;
      let prompt: string | undefined;
      if (hookType === "skill") {
        skill = await uiInput("Skill name:");
        if (skill.trim() === "") {
          uiError("Skill name cannot be empty.");
          process.exitCode = 1;
          return;
        }
      } else {
        prompt = await uiInput("Prompt text or file path:");
        if (prompt.trim() === "") {
          uiError("Prompt cannot be empty.");
          process.exitCode = 1;
          return;
        }
      }

      // 3. Prompt for blocking mode
      const modeChoice = await uiChoose("Mode:", ["blocking", "advisory"]);
      const blocking = modeChoice === "blocking";

      // 4. Prompt for optional minConfidence
      const minConfInput = await uiInput("Min confidence (leave empty to skip):");
      let conditions: { minConfidence: number } | undefined;
      if (minConfInput.trim() !== "") {
        const minConf = parseInt(minConfInput.trim(), 10);
        if (Number.isNaN(minConf) || minConf < 0 || minConf > 100) {
          uiError("Min confidence must be a number between 0 and 100.");
          process.exitCode = 1;
          return;
        }
        conditions = { minConfidence: minConf };
      }

      // 5. Assemble and validate
      const hookObj = { trigger, skill, prompt, blocking, conditions };
      const parsed = HookSchema.parse(hookObj);

      // 6. Append to project config
      await saveProjectConfig((raw) => {
        if (!Array.isArray(raw["hooks"])) {
          raw["hooks"] = [];
        }
        // Write the raw object (without Zod defaults bloating it)
        const entry: Record<string, unknown> = { trigger: parsed.trigger, blocking: parsed.blocking };
        if (parsed.skill !== undefined) entry["skill"] = parsed.skill;
        if (parsed.prompt !== undefined) entry["prompt"] = parsed.prompt;
        if (parsed.conditions !== undefined) entry["conditions"] = parsed.conditions;
        (raw["hooks"] as unknown[]).push(entry);
      });

      // 7. Confirm
      const config = await loadConfig();
      const addedIndex = config.hooks.length - 1;
      const addedHook = config.hooks[addedIndex];
      if (addedHook !== undefined) {
        uiSuccess(`Hook added: ${formatHookLabel(addedHook, addedIndex)}`);
      } else {
        uiSuccess("Hook added.");
      }
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

hooksCmd
  .command("list")
  .description("List all configured hooks")
  .action(async () => {
    try {
      const { formatHookLabel } = await import("./hooks.js");
      const config = await loadConfig();

      if (config.hooks.length === 0) {
        uiInfo("No hooks configured.");
        return;
      }

      for (let i = 0; i < config.hooks.length; i++) {
        const hook = config.hooks[i]!;
        uiInfo(formatHookLabel(hook, i));
      }
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

hooksCmd
  .command("remove [index]")
  .description("Remove a hook from the project config")
  .action(async (indexArg?: string) => {
    try {
      const { formatHookLabel, validateRemoveIndex } = await import("./hooks.js");
      const config = await loadConfig();

      // Load the raw project config to check which hooks are actually in it
      const projectPath = join(process.cwd(), ".hootl", "config.json");
      const rawConfig = await loadJsonFile(projectPath);
      const rawHooks = Array.isArray(rawConfig["hooks"]) ? rawConfig["hooks"] as unknown[] : [];

      if (config.hooks.length === 0) {
        uiInfo("No hooks configured.");
        return;
      }

      // If the project config has no hooks array but merged config does,
      // those hooks come from global config and can't be removed here
      if (rawHooks.length === 0) {
        uiWarn("All configured hooks come from global config (~/.hootl/config.json).");
        uiWarn("Edit the global config directly to remove them.");
        return;
      }

      let selectedIndex: number;

      if (indexArg !== undefined) {
        // CLI argument: 1-based index
        const validated = validateRemoveIndex(indexArg, rawHooks.length);
        if (validated === null) {
          uiError(`Invalid index: ${indexArg}. Must be between 1 and ${rawHooks.length}.`);
          process.exitCode = 1;
          return;
        }
        selectedIndex = validated;
      } else {
        // Interactive: show numbered hooks and let user pick
        const labels = rawHooks.map((_, i) => {
          // Use the parsed config hooks for display (they have Zod defaults applied)
          const hook = config.hooks[i];
          return hook !== undefined ? formatHookLabel(hook, i) : `${i + 1}) (unknown hook)`;
        });

        const choice = await uiChoose("Select hook to remove:", labels);
        // Extract index from "N) ..." label
        const match = choice.match(/^(\d+)\)/);
        if (match === null) {
          uiError("Could not parse selection.");
          process.exitCode = 1;
          return;
        }
        selectedIndex = parseInt(match[1]!, 10) - 1;
      }

      // Show what's being removed
      const hookToRemove = config.hooks[selectedIndex];
      if (hookToRemove !== undefined) {
        uiInfo(`Removing: ${formatHookLabel(hookToRemove, selectedIndex)}`);
      }

      // Splice the hook from the raw project config and write back
      await saveProjectConfig((raw) => {
        const hooks = raw["hooks"];
        if (Array.isArray(hooks)) {
          hooks.splice(selectedIndex, 1);
        }
      });

      uiSuccess("Hook removed.");
    } catch (err: unknown) {
      uiError(errorMsg(err));
      process.exitCode = 1;
    }
  });

program.parse();
