import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeClaude, logCost } from "./invoke.js";
import { type Config, getProjectDir } from "./config.js";
import { type Task, type TaskBackend } from "./tasks/types.js";
import { uiInfo, uiWarn, uiError, uiSuccess, uiSpinner } from "./ui.js";

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
}

export async function loadTemplate(name: string): Promise<string> {
  const thisFile = fileURLToPath(import.meta.url);
  const templatesDir = join(dirname(thisFile), "..", "templates");
  const templatePath = join(templatesDir, `${name}.md`);
  return readFile(templatePath, "utf-8");
}

export async function buildPlanPrompt(
  task: Task,
  taskDir: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  parts.push(task.description);

  const blockers = await readFileOrEmpty(join(taskDir, "blockers.md"));
  if (blockers.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Blockers");
    parts.push(blockers);
  }

  const progress = await readFileOrEmpty(join(taskDir, "progress.md"));
  if (progress.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Progress");
    parts.push(progress);
  }

  parts.push("");
  parts.push(
    "Please produce an execution plan in markdown following your system prompt instructions.",
  );

  return parts.join("\n");
}

export async function buildExecutePrompt(
  task: Task,
  taskDir: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  parts.push(task.description);

  const plan = await readFileOrEmpty(join(taskDir, "plan.md"));
  if (plan.trim().length > 0) {
    parts.push("");
    parts.push("## Plan");
    parts.push(plan);
  }

  const progress = await readFileOrEmpty(join(taskDir, "progress.md"));
  if (progress.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Progress");
    parts.push(progress);
  }

  parts.push("");
  parts.push(
    "Implement the plan and report your progress following your system prompt instructions.",
  );

  return parts.join("\n");
}

export async function buildReviewPrompt(
  task: Task,
  taskDir: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  parts.push(task.description);

  parts.push("");
  parts.push(
    "Run tests, examine code changes (use `git diff`), and produce a JSON confidence assessment following your system prompt instructions.",
  );

  const testResults = await readFileOrEmpty(join(taskDir, "test_results.md"));
  if (testResults.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Test Results");
    parts.push(testResults);
  }

  return parts.join("\n");
}

interface ReviewResult {
  confidence: number;
  summary: string;
  issues: string[];
  blockers: string[];
}

export function parseReviewResult(output: string): ReviewResult {
  const defaultResult: ReviewResult = {
    confidence: 0,
    summary: "",
    issues: [],
    blockers: [],
  };

  // Try to extract JSON from the output — it may be wrapped in markdown code blocks
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  const jsonCandidate = codeBlockMatch ? codeBlockMatch[1] : output;

  // Try parsing the candidate directly, or scan for a JSON object
  const candidates: string[] = [jsonCandidate ?? ""];
  if (!codeBlockMatch) {
    // Try to find a JSON object in the raw output
    const braceMatch = /\{[\s\S]*\}/.exec(output);
    if (braceMatch) {
      candidates.push(braceMatch[0]);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      const record = parsed as Record<string, unknown>;

      const confidence =
        typeof record["confidence"] === "number" ? record["confidence"] : 0;
      const summary =
        typeof record["summary"] === "string" ? record["summary"] : "";
      const issues = Array.isArray(record["issues"])
        ? (record["issues"] as unknown[])
            .filter((v): v is string => typeof v === "string")
        : [];
      const blockers = Array.isArray(record["blockers"])
        ? (record["blockers"] as unknown[])
            .filter((v): v is string => typeof v === "string")
        : [];

      return { confidence, summary, issues, blockers };
    } catch {
      continue;
    }
  }

  return defaultResult;
}

export async function runCompletionLoop(
  task: Task,
  backend: TaskBackend,
  config: Config,
): Promise<void> {
  const taskDir = join(getProjectDir(), "tasks", task.id);
  const costLogDir = getProjectDir();

  await mkdir(taskDir, { recursive: true });

  // Mark task as in_progress
  let currentTask = await backend.updateTask(task.id, { state: "in_progress" });

  while (true) {
    // Check budget
    if (currentTask.totalCost >= config.budgets.perTask) {
      uiWarn(
        `Task ${task.id} exceeded per-task budget ($${currentTask.totalCost.toFixed(2)} >= $${config.budgets.perTask.toFixed(2)}). Moving to blocked.`,
      );
      await backend.updateTask(task.id, {
        state: "blocked",
        blockers: [...currentTask.blockers, "Per-task budget exhausted"],
      });
      break;
    }

    // Check attempts
    if (currentTask.attempts >= config.budgets.maxAttemptsPerTask) {
      uiWarn(
        `Task ${task.id} reached max attempts (${currentTask.attempts}/${config.budgets.maxAttemptsPerTask}). Moving to blocked.`,
      );
      await backend.updateTask(task.id, {
        state: "blocked",
        blockers: [...currentTask.blockers, "Max attempts exhausted"],
      });
      break;
    }

    // Increment attempts
    const attempt = currentTask.attempts + 1;
    currentTask = await backend.updateTask(task.id, { attempts: attempt });

    uiInfo(
      `--- Attempt ${attempt}/${config.budgets.maxAttemptsPerTask} for task ${task.id} ---`,
    );

    let phaseCost = 0;

    try {
      // Phase 1: PLAN
      const planSystemPrompt = await loadTemplate("plan");
      const planUserPrompt = await buildPlanPrompt(currentTask, taskDir);

      uiInfo(`Phase 1: PLAN [${new Date().toLocaleTimeString()}]`);
      const planResult = await uiSpinner("Planning...", () =>
        invokeClaude({
          prompt: planUserPrompt,
          systemPrompt: planSystemPrompt,
          outputFormat: "text",
          permissionMode: "default",
        }),
      );

      if (planResult.exitCode !== 0) {
        uiError(`Plan phase failed (exit code ${planResult.exitCode})`);
        throw new Error(`Plan phase failed: ${planResult.output}`);
      }

      uiInfo(`Phase 1 done [${new Date().toLocaleTimeString()}] (${planResult.durationMs}ms, $${planResult.costUsd.toFixed(4)}, exit=${planResult.exitCode})`);
      await writeFile(join(taskDir, "plan.md"), planResult.output, "utf-8");
      await logCost(costLogDir, task.id, "plan", planResult.costUsd);
      phaseCost += planResult.costUsd;

      // Phase 2: EXECUTE
      const executeSystemPrompt = await loadTemplate("execute");
      const executeUserPrompt = await buildExecutePrompt(currentTask, taskDir);

      uiInfo(`Phase 2: EXECUTE [${new Date().toLocaleTimeString()}]`);
      const executeResult = await uiSpinner("Executing...", () =>
        invokeClaude({
          prompt: executeUserPrompt,
          systemPrompt: executeSystemPrompt,
          outputFormat: "text",
          permissionMode: config.permissionMode === "default" ? "bypassPermissions" : config.permissionMode,
        }),
      );

      if (executeResult.exitCode !== 0) {
        uiError(`Execute phase failed (exit code ${executeResult.exitCode})`);
        throw new Error(`Execute phase failed: ${executeResult.output}`);
      }

      // Append to progress.md
      const progressSeparator = `\n\n---\n\n## Attempt ${attempt}\n\n`;
      await appendFile(
        join(taskDir, "progress.md"),
        progressSeparator + executeResult.output,
        "utf-8",
      );
      await logCost(costLogDir, task.id, "execute", executeResult.costUsd);
      phaseCost += executeResult.costUsd;

      // Phase 3: REVIEW
      const reviewSystemPrompt = await loadTemplate("review");
      const reviewUserPrompt = await buildReviewPrompt(currentTask, taskDir);

      uiInfo(`Phase 3: REVIEW [${new Date().toLocaleTimeString()}]`);
      const reviewResult = await uiSpinner("Reviewing...", () =>
        invokeClaude({
          prompt: reviewUserPrompt,
          systemPrompt: reviewSystemPrompt,
          outputFormat: "json",
          permissionMode: "default",
        }),
      );

      if (reviewResult.exitCode !== 0) {
        uiError(`Review phase failed (exit code ${reviewResult.exitCode})`);
        throw new Error(`Review phase failed: ${reviewResult.output}`);
      }

      await writeFile(
        join(taskDir, "test_results.md"),
        reviewResult.output,
        "utf-8",
      );
      await logCost(costLogDir, task.id, "review", reviewResult.costUsd);
      phaseCost += reviewResult.costUsd;

      // Parse review output
      const review = parseReviewResult(reviewResult.output);

      // Update task with new confidence and accumulated cost
      currentTask = await backend.updateTask(task.id, {
        confidence: review.confidence,
        totalCost: currentTask.totalCost + phaseCost,
      });

      uiInfo(
        `Confidence: ${review.confidence}% (target: ${config.confidence.target}%)`,
      );
      if (review.summary) {
        uiInfo(`Review: ${review.summary}`);
      }

      // Check if we've reached the target
      if (review.confidence >= config.confidence.target) {
        await backend.updateTask(task.id, { state: "review" });
        uiSuccess(
          `Task ${task.id} reached ${review.confidence}% confidence. Ready for review.`,
        );
        break;
      }

      // Check for blockers from review
      if (review.blockers.length > 0) {
        await writeFile(
          join(taskDir, "blockers.md"),
          review.blockers.join("\n"),
          "utf-8",
        );
        await backend.updateTask(task.id, {
          state: "blocked",
          blockers: review.blockers,
        });
        uiWarn(
          `Task ${task.id} blocked: ${review.blockers.join("; ")}`,
        );
        break;
      }

      // Not done yet — loop
      uiInfo(
        `Confidence ${review.confidence}% < ${config.confidence.target}%. Looping for another attempt.`,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      uiError(`Error during attempt ${attempt}: ${message}`);

      // Update cost even on failure
      if (phaseCost > 0) {
        currentTask = await backend.updateTask(task.id, {
          totalCost: currentTask.totalCost + phaseCost,
        });
      }

      // Keep task in_progress so it can resume
      break;
    }
  }
}
