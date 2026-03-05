import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeClaude, logCost } from "./invoke.js";
import { type Config, getProjectDir } from "./config.js";
import { type Task, type TaskBackend } from "./tasks/types.js";
import { uiInfo, uiWarn, uiError, uiSuccess, uiSpinner } from "./ui.js";
import { isGitRepo, createTaskBranch, commitTaskChanges, switchBranch, getBaseBranch } from "./git.js";

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
  suggestions: string[];
  blockers: string[];
  remediationPlan: string;
}

export function parseReviewResult(output: string): ReviewResult {
  const defaultResult: ReviewResult = {
    confidence: 0,
    summary: "",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
  };

  // Try to extract JSON from the output — it may be wrapped in markdown code blocks
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  const jsonCandidate = codeBlockMatch ? codeBlockMatch[1] : output;

  // Try parsing the candidate directly, then fall back to brace matching.
  // Always try brace matching — code block extraction can fail when the JSON
  // contains nested code fences (e.g. remediationPlan with ```typescript blocks).
  const candidates: string[] = [jsonCandidate ?? ""];
  const braceMatch = /\{[\s\S]*\}/.exec(output);
  if (braceMatch && braceMatch[0] !== jsonCandidate) {
    candidates.push(braceMatch[0]);
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
      const suggestions = Array.isArray(record["suggestions"])
        ? (record["suggestions"] as unknown[])
            .filter((v): v is string => typeof v === "string")
        : [];
      const blockers = Array.isArray(record["blockers"])
        ? (record["blockers"] as unknown[])
            .filter((v): v is string => typeof v === "string")
        : [];
      const remediationPlan =
        typeof record["remediationPlan"] === "string"
          ? record["remediationPlan"]
          : "";

      return { confidence, summary, issues, suggestions, blockers, remediationPlan };
    } catch {
      continue;
    }
  }

  return defaultResult;
}

export function isSessionBudgetExceeded(phaseCost: number, perSession: number): boolean {
  return phaseCost >= perSession;
}

export async function applySessionBudgetExceeded(
  backend: TaskBackend,
  taskId: string,
  currentTask: Task,
  phaseCost: number,
  perSession: number,
): Promise<Task | null> {
  if (!isSessionBudgetExceeded(phaseCost, perSession)) return null;
  uiWarn(
    `Session budget exceeded ($${phaseCost.toFixed(4)} >= $${perSession.toFixed(2)}). Ending attempt early.`,
  );
  return backend.updateTask(taskId, { totalCost: currentTask.totalCost + phaseCost });
}

export async function runCompletionLoop(
  task: Task,
  backend: TaskBackend,
  config: Config,
  verbose = false,
): Promise<void> {
  const taskDir = join(getProjectDir(), "tasks", task.id);
  const costLogDir = join(getProjectDir(), "logs");

  await mkdir(taskDir, { recursive: true });

  // Mark task as in_progress
  let currentTask = await backend.updateTask(task.id, { state: "in_progress" });

  // Create a task branch if in a git repo
  let taskBranch: string | null = null;
  let baseBranch: string | null = null;
  if (await isGitRepo()) {
    try {
      baseBranch = await getBaseBranch();
      taskBranch = await createTaskBranch(task.id, task.title, config.git.branchPrefix);
      currentTask = await backend.updateTask(task.id, { branch: taskBranch });
    } catch (err: unknown) {
      uiWarn(`Could not create task branch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let hasRemediationPlan = false;

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
      // Phase 1: PLAN (skipped when the previous review wrote a remediation plan)
      if (hasRemediationPlan) {
        uiInfo(`Phase 1: PLAN [SKIPPED — using remediation plan from previous review]`);
        hasRemediationPlan = false;
      } else {
        const planSystemPrompt = await loadTemplate("plan");
        const planUserPrompt = await buildPlanPrompt(currentTask, taskDir);

        uiInfo(`Phase 1: PLAN [${new Date().toLocaleTimeString()}]`);
        const planResult = await uiSpinner("Planning...", () =>
          invokeClaude({
            prompt: planUserPrompt,
            systemPrompt: planSystemPrompt,
            maxTurns: 20,
            verbose,
          }),
        );

        if (planResult.exitCode !== 0) {
          uiError(`Plan phase failed (exit code ${planResult.exitCode})`);
          throw new Error(`Plan phase failed: ${planResult.output}`);
        }

        if (planResult.output.trim() === "") {
          uiWarn("Plan phase returned empty output — retrying");
          throw new Error("Plan phase returned empty output");
        }

        uiInfo(`Phase 1 done [${new Date().toLocaleTimeString()}] (${planResult.durationMs}ms, $${planResult.costUsd.toFixed(4)}, exit=${planResult.exitCode})`);
        await writeFile(join(taskDir, "plan.md"), planResult.output, "utf-8");
        await logCost(costLogDir, task.id, "plan", planResult.costUsd);
        phaseCost += planResult.costUsd;

        // Check per-session budget after plan phase
        const planBudgetResult = await applySessionBudgetExceeded(backend, task.id, currentTask, phaseCost, config.budgets.perSession);
        if (planBudgetResult) {
          currentTask = planBudgetResult;
          // phaseCost resets at loop top (let phaseCost = 0); totalCost persisted in backend
          continue;
        }
      }

      // Phase 2: EXECUTE
      const executeSystemPrompt = await loadTemplate("execute");
      const executeUserPrompt = await buildExecutePrompt(currentTask, taskDir);

      uiInfo(`Phase 2: EXECUTE [${new Date().toLocaleTimeString()}]`);
      const executeResult = await uiSpinner("Executing...", () =>
        invokeClaude({
          prompt: executeUserPrompt,
          systemPrompt: executeSystemPrompt,
          maxTurns: 50,
          verbose,
        }),
      );

      if (executeResult.exitCode !== 0) {
        uiError(`Execute phase failed (exit code ${executeResult.exitCode})`);
        throw new Error(`Execute phase failed: ${executeResult.output}`);
      }

      if (executeResult.output.trim() === "") {
        uiWarn("Execute phase returned empty output — retrying");
        throw new Error("Execute phase returned empty output");
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

      // Auto-commit after execute phase
      if (taskBranch !== null) {
        try {
          await commitTaskChanges(task.id, `attempt-${attempt}`, `[${task.id}] Execute attempt ${attempt}`);
        } catch (err: unknown) {
          uiWarn(`Could not auto-commit: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Check per-session budget after execute phase
      // Note: hasRemediationPlan was already consumed/reset before this point (at Phase 1), so no explicit reset is needed here.
      const execBudgetResult = await applySessionBudgetExceeded(backend, task.id, currentTask, phaseCost, config.budgets.perSession);
      if (execBudgetResult) {
        currentTask = execBudgetResult;
        // phaseCost resets at loop top (let phaseCost = 0); totalCost persisted in backend
        continue;
      }

      // Phase 3: REVIEW
      const reviewSystemPrompt = await loadTemplate("review");
      const reviewUserPrompt = await buildReviewPrompt(currentTask, taskDir);

      uiInfo(`Phase 3: REVIEW [${new Date().toLocaleTimeString()}]`);
      const reviewResult = await uiSpinner("Reviewing...", () =>
        invokeClaude({
          prompt: reviewUserPrompt,
          systemPrompt: reviewSystemPrompt,
          maxTurns: 20,
          verbose,
        }),
      );

      if (reviewResult.exitCode !== 0) {
        uiError(`Review phase failed (exit code ${reviewResult.exitCode})`);
        throw new Error(`Review phase failed: ${reviewResult.output}`);
      }

      if (reviewResult.output.trim() === "") {
        uiWarn("Review phase returned empty output — retrying");
        throw new Error("Review phase returned empty output");
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

      // Write remediation plan for the next attempt's execute phase (skipping plan phase)
      if (review.remediationPlan.trim().length > 0) {
        await writeFile(
          join(taskDir, "plan.md"),
          review.remediationPlan,
          "utf-8",
        );
        hasRemediationPlan = true;
        uiInfo("Remediation plan written — next attempt will skip planning phase.");
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

      // Transient errors (empty output, timeouts) → continue looping
      // Only break on permanent errors or if we're out of attempts
      const isTransient = message.includes("empty output") || message.includes("timed out");
      if (!isTransient) {
        // Permanent error — keep task in_progress so it can resume later
        break;
      }
      // Transient error — will loop back and check attempt/budget limits
      hasRemediationPlan = false;
      uiInfo("Transient error — will retry on next attempt");
    }
  }

  // Switch back to base branch
  if (baseBranch !== null && taskBranch !== null) {
    try {
      await switchBranch(baseBranch);
    } catch (err: unknown) {
      uiWarn(`Could not switch back to ${baseBranch}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
