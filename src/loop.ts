import { readFile, writeFile, appendFile, mkdir, unlink, rename } from "node:fs/promises";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeClaude, logCost } from "./invoke.js";
import { type Config, type OnConfidenceMode, getProjectDir, resolveOnConfidenceMode } from "./config.js";
import { type Task, type TaskBackend, type TaskPriority, type TaskType, TaskPriority as TaskPriorityEnum, TaskType as TaskTypeEnum } from "./tasks/types.js";
import { uiInfo, uiWarn, uiError, uiSuccess, uiSpinner, errorMsg } from "./ui.js";
import { isGitRepo, createTaskBranch, commitTaskChanges, switchBranch, getBaseBranch, getHeadSha, resetToSha, mergeBranch, deleteBranch, pushBranch, createDraftPR, hasUncommittedChanges, slugify, createWorktree, removeWorktree, getDirtyFiles, ensureBranch, hasBranchDiff } from "./git.js";
import { checkGlobalBudget } from "./budget.js";
import { notify, notifyWebhook } from "./notify.js";
import { generateMemoryEntry, appendMemoryEntry } from "./plan-memory.js";
import { inferDependencies, resolveIndicesToIds } from "./dependencies.js";
import { runHooks } from "./hooks.js";
import type { HookContext, HookDeps, HookResult } from "./hooks.js";
import { logEvent } from "./logger.js";

export async function readFileOrEmpty(path: string): Promise<string> {
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

/**
 * Save the full raw output from a claude -p invocation to the task's logs/ directory.
 * Acts as a 'black box recorder' — preserves exact Claude responses for debugging,
 * separate from processed context files (plan.md, progress.md, etc.) which may be
 * truncated, parsed, or overwritten.
 *
 * File naming: `<phase>-<attempt>.txt` (e.g., `plan-1.txt`, `execute-2.txt`, `preflight-0.txt`)
 * Wraps in try/catch so logging failures never crash the completion loop.
 */
export async function saveRawOutput(
  taskDir: string,
  phase: string,
  attempt: number,
  output: string,
): Promise<void> {
  try {
    const logsDir = join(taskDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, `${phase}-${attempt}.txt`), output, "utf-8");
  } catch {
    // Logging must never crash the loop — same pattern as logEvent
  }
}

export interface Checkpoint {
  phase: string;
  attempt: number;
  timestamp: string;
}

/** Write a checkpoint file atomically (tmp + rename) before each phase. */
export async function writeCheckpoint(taskDir: string, phase: string, attempt: number): Promise<void> {
  try {
    const data: Checkpoint = { phase, attempt, timestamp: new Date().toISOString() };
    const filePath = join(taskDir, "checkpoint.json");
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await rename(tmpPath, filePath);
  } catch {
    // Checkpoint is advisory — never block the loop
  }
}

/** Read checkpoint file, returning null if missing or invalid. */
export async function readCheckpoint(taskDir: string): Promise<Checkpoint | null> {
  try {
    const raw = await readFile(join(taskDir, "checkpoint.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["phase"] !== "string" || typeof record["attempt"] !== "number" || typeof record["timestamp"] !== "string") {
      return null;
    }
    return { phase: record["phase"], attempt: record["attempt"], timestamp: record["timestamp"] };
  } catch {
    return null;
  }
}

/** Remove checkpoint file on clean exit. */
export async function clearCheckpoint(taskDir: string): Promise<void> {
  try {
    await unlink(join(taskDir, "checkpoint.json"));
  } catch {
    // Ignore — file may not exist
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

  const understanding = await readFileOrEmpty(join(taskDir, "understanding.md"));
  if (understanding.trim().length > 0) {
    parts.push("");
    parts.push("## Task Understanding");
    parts.push(understanding);
  }

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

export async function buildPreflightPrompt(
  task: Task,
  taskDir: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  parts.push(task.description);

  parts.push("");
  parts.push(`**Priority:** ${task.priority}`);
  parts.push(`**Type:** ${task.type}`);

  const blockers = await readFileOrEmpty(join(taskDir, "blockers.md"));
  if (blockers.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Blockers");
    parts.push(blockers);
  }

  parts.push("");
  parts.push(
    "Validate this task and produce a JSON preflight assessment following your system prompt instructions.",
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

  const understanding = await readFileOrEmpty(join(taskDir, "understanding.md"));
  if (understanding.trim().length > 0) {
    parts.push("");
    parts.push("## Task Understanding");
    parts.push(understanding);
  }

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
  opts?: { taskBranch?: string | null; baseBranch?: string | null },
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  parts.push(task.description);

  parts.push("");
  if (opts?.taskBranch && opts?.baseBranch) {
    parts.push(
      `IMPORTANT: You are reviewing changes on branch \`${opts.taskBranch}\`. ` +
      `First run \`git checkout ${opts.taskBranch}\` to ensure you are on the correct branch. ` +
      `Then examine code changes with \`git diff ${opts.baseBranch}...HEAD\` (not plain \`git diff\` which only shows uncommitted changes). ` +
      `Run tests, and produce a JSON confidence assessment following your system prompt instructions.`,
    );
  } else {
    parts.push(
      "Run tests, examine code changes (use `git diff`), and produce a JSON confidence assessment following your system prompt instructions.",
    );
  }

  const testResults = await readFileOrEmpty(join(taskDir, "test_results.md"));
  if (testResults.trim().length > 0) {
    parts.push("");
    parts.push("## Previous Test Results");
    parts.push(testResults);
  }

  return parts.join("\n");
}

export interface PreflightResult {
  verdict: "proceed" | "too_broad" | "unclear" | "cannot_reproduce";
  understanding: string;
  subtasks: Array<{ title: string; description: string; priority?: TaskPriority; type?: TaskType }>;
  reproductionResult: string;
}

interface ReviewBreakdown {
  correctness: number;
  testCoverage: number;
  codeQuality: number;
  documentation: number;
}

export interface RemediationItem {
  category: string;
  title: string;
  diffMarkers: string[];
  weight: number;
}

interface ReviewResult {
  confidence: number;
  breakdown: ReviewBreakdown;
  summary: string;
  issues: string[];
  suggestions: string[];
  blockers: string[];
  remediationPlan: string;
  remediationItems: RemediationItem[];
}

export function parseReviewResult(output: string): ReviewResult {
  const defaultBreakdown: ReviewBreakdown = {
    correctness: 0,
    testCoverage: 0,
    codeQuality: 0,
    documentation: 0,
  };
  const defaultResult: ReviewResult = {
    confidence: 0,
    breakdown: defaultBreakdown,
    summary: "",
    issues: [],
    suggestions: [],
    blockers: [],
    remediationPlan: "",
    remediationItems: [],
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

      const rawBreakdown = typeof record["breakdown"] === "object" && record["breakdown"] !== null
        ? record["breakdown"] as Record<string, unknown>
        : {};
      const breakdown: ReviewBreakdown = {
        correctness: typeof rawBreakdown["correctness"] === "number" ? rawBreakdown["correctness"] : 0,
        testCoverage: typeof rawBreakdown["testCoverage"] === "number" ? rawBreakdown["testCoverage"] : 0,
        codeQuality: typeof rawBreakdown["codeQuality"] === "number" ? rawBreakdown["codeQuality"] : 0,
        documentation: typeof rawBreakdown["documentation"] === "number" ? rawBreakdown["documentation"] : 0,
      };

      const remediationItems: RemediationItem[] = [];
      if (Array.isArray(record["remediationItems"])) {
        for (const item of record["remediationItems"] as unknown[]) {
          if (typeof item === "object" && item !== null) {
            const rec = item as Record<string, unknown>;
            const category = typeof rec["category"] === "string" ? rec["category"] : "";
            const title = typeof rec["title"] === "string" ? rec["title"] : "";
            const diffMarkers = Array.isArray(rec["diffMarkers"])
              ? (rec["diffMarkers"] as unknown[]).filter((v): v is string => typeof v === "string")
              : [];
            const weight = typeof rec["weight"] === "number" ? rec["weight"] : 0;
            if (category && title) {
              remediationItems.push({ category, title, diffMarkers, weight });
            }
          }
        }
      }

      return { confidence, breakdown, summary, issues, suggestions, blockers, remediationPlan, remediationItems };
    } catch {
      continue;
    }
  }

  return defaultResult;
}

const VALID_VERDICTS = new Set(["proceed", "too_broad", "unclear", "cannot_reproduce"]);

export function parsePreflightResult(output: string): PreflightResult {
  const defaultResult: PreflightResult = {
    verdict: "unclear",
    understanding: "",
    subtasks: [],
    reproductionResult: "",
  };

  // Same robust JSON extraction as parseReviewResult:
  // Try code block first, then brace-matching fallback
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  const jsonCandidate = codeBlockMatch ? codeBlockMatch[1] : output;

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

      const rawVerdict = record["verdict"];
      const verdict: PreflightResult["verdict"] =
        typeof rawVerdict === "string" && VALID_VERDICTS.has(rawVerdict)
          ? (rawVerdict as PreflightResult["verdict"])
          : "unclear";

      const understanding =
        typeof record["understanding"] === "string" ? record["understanding"] : "";

      const subtasks: PreflightResult["subtasks"] = [];
      if (Array.isArray(record["subtasks"])) {
        for (const item of record["subtasks"] as unknown[]) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>)["title"] === "string" &&
            typeof (item as Record<string, unknown>)["description"] === "string"
          ) {
            const rawPriority = (item as Record<string, unknown>)["priority"];
            const parsedPriority = TaskPriorityEnum.safeParse(rawPriority);
            const rawType = (item as Record<string, unknown>)["type"];
            const parsedType = TaskTypeEnum.safeParse(rawType);
            subtasks.push({
              title: (item as Record<string, unknown>)["title"] as string,
              description: (item as Record<string, unknown>)["description"] as string,
              ...(parsedPriority.success ? { priority: parsedPriority.data } : {}),
              ...(parsedType.success ? { type: parsedType.data } : {}),
            });
          }
        }
      }

      const reproductionResult =
        typeof record["reproductionResult"] === "string"
          ? record["reproductionResult"]
          : "";

      return { verdict, understanding, subtasks, reproductionResult };
    } catch {
      continue;
    }
  }

  return defaultResult;
}

export function isConfidenceRegression(current: number, previous: number | null): boolean {
  if (previous === null) return false;
  return current < previous;
}

/**
 * Returns true if every dependency task is in 'done' state.
 * Returns false on any error (conservative — don't auto-promote if we can't verify).
 */
export async function checkAllDependenciesDone(backend: TaskBackend, depIds: string[]): Promise<boolean> {
  for (const depId of depIds) {
    try {
      const dep = await backend.getTask(depId);
      if (dep.state !== "done") return false;
    } catch {
      return false;
    }
  }
  return true;
}

const SCORING_WEIGHTS: Record<keyof ReviewBreakdown, number> = {
  correctness: 0.4,
  testCoverage: 0.3,
  codeQuality: 0.2,
  documentation: 0.1,
};

export function buildScoringTable(
  breakdown: ReviewBreakdown,
  confidence: number,
  target: number,
): string {
  const rows = (Object.entries(SCORING_WEIGHTS) as [keyof ReviewBreakdown, number][])
    .map(([category, weight]) => {
      const score = breakdown[category];
      const points = score * weight;
      const maxPoints = 100 * weight;
      const potentialGain = (100 - score) * weight;
      return { category, score, weight, points, maxPoints, potentialGain };
    })
    .sort((a, b) => b.potentialGain - a.potentialGain);

  const lines: string[] = [];
  lines.push(`## Previous Review Scores (${confidence}/100, target: ${target})`);
  lines.push("");
  lines.push("| Category | Score | Weight | Weighted Points | Potential Gain |");
  lines.push("|----------|-------|--------|-----------------|----------------|");
  for (const r of rows) {
    const marker = r.potentialGain >= 2 ? " **← FIX THIS**" : "";
    lines.push(
      `| ${r.category} | ${r.score} | ${(r.weight * 100).toFixed(0)}% | ${r.points.toFixed(1)}/${r.maxPoints.toFixed(0)} | +${r.potentialGain.toFixed(1)}${marker} |`,
    );
  }

  const topGaps = rows
    .filter((r) => r.potentialGain >= 1)
    .map((r) => `**${r.category}** (+${r.potentialGain.toFixed(1)} points)`)
    .join(", ");

  if (topGaps) {
    lines.push("");
    lines.push(`**Work on these first:** ${topGaps}`);
  }

  lines.push("");
  return lines.join("\n");
}

export const MARKER_WEIGHT_THRESHOLD = 2.0;

export interface MarkerVerificationResult {
  passed: boolean;
  missingItems: RemediationItem[];
}

export interface DiffProvider {
  getDiff: (baseBranch: string, cwd?: string) => Promise<string>;
}

async function defaultGetDiff(baseBranch: string, cwd?: string): Promise<string> {
  const execOpts = cwd ? { cwd } : {};
  const result = await execa("git", ["diff", `${baseBranch}...HEAD`], execOpts);
  return result.stdout;
}

export async function verifyRemediationMarkers(
  items: RemediationItem[],
  baseBranch: string,
  cwd?: string,
  deps?: DiffProvider,
): Promise<MarkerVerificationResult> {
  if (items.length === 0) return { passed: true, missingItems: [] };

  const checkable = items.filter(
    (item) => item.weight >= MARKER_WEIGHT_THRESHOLD && item.diffMarkers.length > 0,
  );
  if (checkable.length === 0) return { passed: true, missingItems: [] };

  let diff: string;
  try {
    const getDiff = deps?.getDiff ?? defaultGetDiff;
    diff = await getDiff(baseBranch, cwd);
  } catch {
    // If git diff fails, skip verification rather than blocking progress
    return { passed: true, missingItems: [] };
  }

  const missingItems: RemediationItem[] = [];
  for (const item of checkable) {
    const hasAnyMarker = item.diffMarkers.some((marker) => diff.includes(marker));
    if (!hasAnyMarker) {
      missingItems.push(item);
    }
  }

  return { passed: missingItems.length === 0, missingItems };
}

export function isContextWindowExceeded(contextWindowPercent: number, limit: number): boolean {
  return contextWindowPercent >= limit;
}

export async function applyContextWindowExceeded(
  backend: TaskBackend,
  taskId: string,
  currentTask: Task,
  phaseCost: number,
  contextWindowPercent: number,
  limit: number,
): Promise<Task | null> {
  if (!isContextWindowExceeded(contextWindowPercent, limit)) return null;
  uiWarn(
    `Context window usage ${contextWindowPercent}% exceeds ${limit}% — ending attempt to preserve quality.`,
  );
  return backend.updateTask(taskId, { totalCost: currentTask.totalCost + phaseCost });
}

export interface CliFlags {
  merge?: boolean;
  noMerge?: boolean;
}

export const MAX_REVERIFICATIONS = 2;

async function handleBlockingHookFailure(
  results: HookResult[],
  contextLabel: string,
  backend: TaskBackend,
  task: Task,
  taskBranch: string | null,
  baseBranch: string | null,
  confidence: number,
  config: Config,
  hookDeps?: HookDeps,
  worktreePath?: string,
): Promise<{ state: "in_progress" | "blocked"; mergedSuccessfully: false }> {
  const hasFixes = results.some((r) => r.remediationActions.length > 0);
  if (hasFixes) {
    uiWarn(`Blocking hook failed${contextLabel} but applied fixes — keeping task in_progress for another attempt.`);
    return { state: "in_progress", mergedSuccessfully: false };
  }
  const issues = results.flatMap((r) => r.issues);
  const blocker = `Blocking hook validation failed${contextLabel}: ${issues.join("; ") || "no details provided"}`;
  uiWarn(`${blocker} — moving task to blocked.`);
  await moveToBlocked(backend, task, [blocker], taskBranch, baseBranch, confidence, config, hookDeps, worktreePath);
  return { state: "blocked", mergedSuccessfully: false };
}

export async function handleConfidenceMet(
  task: Task,
  config: Config,
  backend: TaskBackend,
  taskBranch: string | null,
  baseBranch: string | null,
  taskDir: string,
  cliFlags: CliFlags,
  hookDeps?: HookDeps,
  verbose = false,
  worktreePath?: string,
): Promise<{ state: "done" | "review" | "in_progress" | "blocked"; mergedSuccessfully: boolean }> {
  // Run on_confidence_met hooks before proceeding with merge/PR/none.
  // If no hooks are configured, inject the default simplify hook as a blocking validator.
  const effectiveHooks = config.hooks.length > 0
    ? config.hooks
    : [{ trigger: "on_confidence_met" as const, skill: "simplify", blocking: true }];
  const hasConfidenceHooks = effectiveHooks.some((h) => h.trigger === "on_confidence_met");

  // Skip hooks when the branch has no diff from base — nothing to validate.
  // Only check diff if there are actually hooks to run (avoids wasted git subprocess).
  let skipHooks = false;
  if (hasConfidenceHooks && taskBranch !== null && baseBranch !== null) {
    const hasDiff = await hasBranchDiff(baseBranch, taskBranch, worktreePath);
    if (!hasDiff) {
      uiInfo("Branch has no diff from base — skipping on_confidence_met hooks.");
      await logEvent(join(getProjectDir(), "logs"), {
        taskId: task.id,
        type: "decision",
        data: { decision: "hooks_skipped", details: "No branch diff" },
      });
      skipHooks = true;
    }
  }

  if (hasConfidenceHooks && !skipHooks) {
    let currentTask = task;
    try {
      const hookContext: HookContext = {
        task,
        branchName: taskBranch,
        baseBranch: baseBranch ?? "main",
        confidence: task.confidence,
        config,
        ...(worktreePath ? { cwd: worktreePath } : {}),
      };
      const effectiveConfig = { ...config, hooks: effectiveHooks };
      const hookResult = hookDeps
        ? await runHooks("on_confidence_met", hookContext, effectiveConfig, hookDeps)
        : await runHooks("on_confidence_met", hookContext, effectiveConfig);
      if (!hookResult.allPassed) {
        return handleBlockingHookFailure(hookResult.results, "", backend, task, taskBranch, baseBranch, task.confidence, config, hookDeps, worktreePath);
      }

      // Re-verification loop: if hooks applied fixes, commit and re-review to verify
      const costLogDir = join(getProjectDir(), "logs");
      let reverifyCount = 0;
      let anyFixesApplied = hookResult.results.some((r) => r.remediationActions.length > 0);

      while (anyFixesApplied && reverifyCount < MAX_REVERIFICATIONS) {
        reverifyCount++;
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "re_verification", details: `Iteration ${reverifyCount}/${MAX_REVERIFICATIONS}, hooks applied fixes` },
        });
        uiInfo(`Re-verification ${reverifyCount}/${MAX_REVERIFICATIONS}: hook applied fixes — committing and re-reviewing.`);

        // Auto-commit hook changes
        if (taskBranch !== null) {
          try {
            const commitFn = hookDeps?.commit ?? commitTaskChanges;
            // Hook re-verification commits should stage all hook changes — don't filter by preExistingDirty
            // since the hook's fixes are new work that must be committed regardless of pre-execute state.
            await commitFn(task.id, `hook-fix-${reverifyCount}`, `[${task.id}] Apply code quality fixes (re-verify ${reverifyCount})`, undefined, worktreePath);
          } catch (err: unknown) {
            uiWarn(`Could not auto-commit hook fixes: ${errorMsg(err)}`);
          }
        }

        // Re-run Phase 3 (review) to check if fixes broke anything
        const reviewSystemPrompt = await loadTemplate("review");
        const reviewUserPrompt = await buildReviewPrompt(currentTask, taskDir, {
          taskBranch,
          baseBranch,
        });

        await logEvent(costLogDir, {
          taskId: task.id,
          type: "phase_start",
          data: { phase: "re-verify", attempt: reverifyCount },
        });
        const reVerifyStart = Date.now();

        const reviewResult = hookDeps
          ? await hookDeps.invoke({
              prompt: reviewUserPrompt,
              systemPrompt: reviewSystemPrompt,
              maxTurns: 20,
              verbose,
              ...(worktreePath ? { cwd: worktreePath } : {}),
            })
          : await invokeClaude({
              prompt: reviewUserPrompt,
              systemPrompt: reviewSystemPrompt,
              maxTurns: 20,
              verbose,
              ...(worktreePath ? { cwd: worktreePath } : {}),
            });

        // Save raw re-verify output for debugging
        await saveRawOutput(taskDir, "re-verify", reverifyCount, reviewResult.output);
        // Log re-verify cost
        if (hookDeps) {
          await hookDeps.log(costLogDir, task.id, "re-verify", reviewResult.costUsd);
        } else {
          await logCost(costLogDir, task.id, "re-verify", reviewResult.costUsd);
        }
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "phase_end",
          data: {
            phase: "re-verify",
            attempt: reverifyCount,
            costUsd: reviewResult.costUsd,
            durationMs: Date.now() - reVerifyStart,
            exitCode: reviewResult.exitCode,
            outputLength: reviewResult.output.length,
          },
        });

        const review = parseReviewResult(reviewResult.output);

        // Update task confidence
        currentTask = await backend.updateTask(task.id, {
          confidence: review.confidence,
          totalCost: currentTask.totalCost + reviewResult.costUsd,
        });

        uiInfo(`Re-verify confidence: ${review.confidence}% (target: ${config.confidence.target}%)`);

        if (review.confidence >= config.confidence.target) {
          // Confidence still good — re-run hooks to check for more fixes
          const reHookContext: HookContext = {
            task: currentTask,
            branchName: taskBranch,
            baseBranch: baseBranch ?? "main",
            confidence: review.confidence,
            config,
            ...(worktreePath ? { cwd: worktreePath } : {}),
          };
          const reHookResult = hookDeps
            ? await runHooks("on_confidence_met", reHookContext, effectiveConfig, hookDeps)
            : await runHooks("on_confidence_met", reHookContext, effectiveConfig);

          if (!reHookResult.allPassed) {
            return handleBlockingHookFailure(reHookResult.results, " during re-verification", backend, currentTask, taskBranch, baseBranch, review.confidence, config, hookDeps, worktreePath);
          }

          anyFixesApplied = reHookResult.results.some((r) => r.remediationActions.length > 0);
          // If no more fixes, break out and proceed to merge/PR/none
        } else {
          // Confidence dropped below target — write remediation plan and return in_progress
          uiWarn(`Re-verify: confidence dropped to ${review.confidence}% (below target ${config.confidence.target}%). Writing remediation plan.`);
          if (review.remediationPlan.trim().length > 0) {
            await writeFile(join(taskDir, "plan.md"), review.remediationPlan, "utf-8");
          }
          return { state: "in_progress", mergedSuccessfully: false };
        }
      }

      if (reverifyCount >= MAX_REVERIFICATIONS && anyFixesApplied) {
        uiWarn(`Max re-verifications (${MAX_REVERIFICATIONS}) reached — hook keeps applying fixes. Proceeding with merge/PR/none.`);
      }
    } catch (err: unknown) {
      const blocker = `Hook execution error: ${errorMsg(err)}`;
      uiWarn(`${blocker} — moving task to blocked.`);
      await moveToBlocked(backend, currentTask, [blocker], taskBranch, baseBranch, currentTask.confidence, config, hookDeps, worktreePath);
      return { state: "blocked", mergedSuccessfully: false };
    }
  }

  const mode: OnConfidenceMode = resolveOnConfidenceMode(config, cliFlags.merge, cliFlags.noMerge);

  if (mode === "merge" && taskBranch !== null && baseBranch !== null) {
    // Merge from the main working tree (not the worktree), since we need to checkout baseBranch
    const merged = await mergeBranch(taskBranch, baseBranch);
    if (merged) {
      // Clean up worktree before branch deletion — git refuses to delete a branch
      // that's checked out in a worktree
      if (worktreePath) {
        try {
          await removeWorktree(worktreePath);
          await backend.updateTask(task.id, { worktree: null });
        } catch {
          // Best-effort: worktree cleanup should never block state transitions
        }
      }
      await deleteBranch(taskBranch);
      await backend.updateTask(task.id, { state: "done" });
      await logEvent(join(getProjectDir(), "logs"), {
        taskId: task.id,
        type: "state_change",
        data: { from: "in_progress", to: "done", reason: "Merge successful" },
      });
      await logEvent(join(getProjectDir(), "logs"), {
        taskId: task.id,
        type: "decision",
        data: { decision: "merge_success", details: `Merged ${taskBranch} into ${baseBranch}` },
      });
      uiSuccess(`Task ${task.id} merged into ${baseBranch} and moved to done.`);
      await notify("Task Complete", `${task.id}: ${task.title}`, config);
      void notifyWebhook({
        taskId: task.id,
        title: task.title,
        oldState: "in_progress",
        newState: "done",
        confidence: task.confidence,
        timestamp: new Date().toISOString(),
      }, config);
      return { state: "done", mergedSuccessfully: true };
    }
    // Merge failed — fall through to 'none' behavior
    uiWarn("Merge failed — falling back to review state.");
    await backend.updateTask(task.id, { state: "review" });
    await logEvent(join(getProjectDir(), "logs"), {
      taskId: task.id,
      type: "state_change",
      data: { from: "in_progress", to: "review", reason: "Merge failed" },
    });
    await logEvent(join(getProjectDir(), "logs"), {
      taskId: task.id,
      type: "decision",
      data: { decision: "merge_failed", details: `Merge of ${taskBranch} into ${baseBranch} failed, falling back to review` },
    });
    await notify("Task Ready for Review", `${task.id}: ${task.title}`, config);
    void notifyWebhook({
      taskId: task.id,
      title: task.title,
      oldState: "in_progress",
      newState: "review",
      confidence: task.confidence,
      timestamp: new Date().toISOString(),
    }, config);
    return { state: "review", mergedSuccessfully: false };
  }

  if (mode === "pr" && taskBranch !== null) {
    // Push from the worktree if available, otherwise from cwd
    const pushed = await pushBranch(taskBranch, worktreePath);
    if (pushed) {
      const progress = await readFileOrEmpty(join(taskDir, "progress.md"));
      const body = [
        `## Task: ${task.title}`,
        "",
        task.description,
        "",
        `**Confidence:** ${task.confidence}%`,
        "",
        "## Progress Summary",
        "",
        progress.slice(0, 3000), // Truncate to keep PR body reasonable
      ].join("\n");
      await createDraftPR(`[${task.id}] ${task.title}`, body);
    }
    await backend.updateTask(task.id, { state: "review" });
    await logEvent(join(getProjectDir(), "logs"), {
      taskId: task.id,
      type: "state_change",
      data: { from: "in_progress", to: "review", reason: "PR created" },
    });
    await logEvent(join(getProjectDir(), "logs"), {
      taskId: task.id,
      type: "decision",
      data: { decision: "pr_created", details: `Pushed ${taskBranch} and created draft PR` },
    });
    uiSuccess(`Task ${task.id} pushed and moved to review.`);
    await notify("Task Ready for Review", `${task.id}: ${task.title}`, config);
    void notifyWebhook({
      taskId: task.id,
      title: task.title,
      oldState: "in_progress",
      newState: "review",
      confidence: task.confidence,
      timestamp: new Date().toISOString(),
    }, config);
    return { state: "review", mergedSuccessfully: false };
  }

  // 'none' mode or no branch available
  await backend.updateTask(task.id, { state: "review" });
  await logEvent(join(getProjectDir(), "logs"), {
    taskId: task.id,
    type: "state_change",
    data: { from: "in_progress", to: "review", reason: "Confidence met (none mode)" },
  });
  await logEvent(join(getProjectDir(), "logs"), {
    taskId: task.id,
    type: "decision",
    data: { decision: "confidence_met_none", details: "No merge/PR configured, moved to review" },
  });
  await notify("Task Ready for Review", `${task.id}: ${task.title}`, config);
  void notifyWebhook({
    taskId: task.id,
    title: task.title,
    oldState: "in_progress",
    newState: "review",
    confidence: task.confidence,
    timestamp: new Date().toISOString(),
  }, config);
  return { state: "review", mergedSuccessfully: false };
}

export async function handleTooBroad(
  backend: TaskBackend,
  currentTask: Task,
  preflight: PreflightResult,
  taskDir: string,
): Promise<{ createdIds: string[]; updatedTask: Task }> {
  const createdIds: string[] = [];
  for (let i = 0; i < preflight.subtasks.length; i++) {
    const sub = preflight.subtasks[i]!;
    const created = await backend.createTask({
      title: sub.title,
      description: sub.description,
      priority: sub.priority ?? currentTask.priority,
      type: sub.type ?? currentTask.type,
      dependencies: [],
    });
    // createTask defaults to 'proposed'; move to 'ready' so subtasks are immediately runnable
    // If parent has a userPriority, subtasks inherit fractional slots right after it (e.g. 16 → 16.1, 16.2, ...)
    const subtaskUpdate: Partial<Task> = { state: "ready" };
    if (currentTask.userPriority !== null) {
      subtaskUpdate.userPriority = currentTask.userPriority + (i + 1) / (preflight.subtasks.length + 1);
    }
    await backend.updateTask(created.id, subtaskUpdate);
    createdIds.push(created.id);
  }

  // Infer inter-subtask dependencies via heuristic keyword matching
  const depMap = inferDependencies(preflight.subtasks);
  const indexToId = new Map(createdIds.map((id, i) => [i, id]));
  const resolvedDeps = resolveIndicesToIds(depMap, indexToId);
  for (const [idx, depIds] of resolvedDeps) {
    const subtaskId = indexToId.get(idx);
    if (subtaskId !== undefined) {
      await backend.updateTask(subtaskId, { dependencies: depIds });
    }
  }

  const idList = createdIds.join(", ");
  const note = `Decomposed into subtasks: ${idList}`;
  const updatedTask = await backend.updateTask(currentTask.id, {
    state: "ready",
    dependencies: [...currentTask.dependencies, ...createdIds],
    blockers: [...currentTask.blockers, note],
  });
  // Remove understanding.md so preflight runs fresh when the parent is picked up again
  // (the original understanding reflects a "too broad" assessment that won't apply after subtasks complete)
  try {
    await unlink(join(taskDir, "understanding.md"));
  } catch {
    // Ignore — file may not exist
  }
  return { createdIds, updatedTask };
}

async function recordMemory(task: Task, projectDir: string): Promise<void> {
  try {
    const entry = generateMemoryEntry(task);
    await appendMemoryEntry(projectDir, entry);
  } catch {
    // Memory recording should never crash the loop
  }
}

/** Helper to build HookContext and run hooks at a trigger point. Fire-and-forget: errors are caught. */
export async function fireHooks(
  trigger: "on_execute_start" | "on_review_complete" | "on_blocked",
  task: Task,
  taskBranch: string | null,
  baseBranch: string | null,
  confidence: number,
  config: Config,
  hookDeps?: HookDeps,
  cwd?: string,
): Promise<void> {
  if (config.hooks.length === 0) return;
  try {
    const hookContext: HookContext = {
      task,
      branchName: taskBranch,
      baseBranch: baseBranch ?? "main",
      confidence,
      config,
      ...(cwd ? { cwd } : {}),
    };
    if (hookDeps) {
      await runHooks(trigger, hookContext, config, hookDeps);
    } else {
      await runHooks(trigger, hookContext, config);
    }
  } catch (err: unknown) {
    uiWarn(`Hook error (${trigger}): ${errorMsg(err)}`);
  }
}

/** Helper to run on_blocked hook, then update task to blocked state. */
export async function moveToBlocked(
  backend: TaskBackend,
  task: Task,
  blockers: string[],
  taskBranch: string | null,
  baseBranch: string | null,
  confidence: number,
  config: Config,
  hookDeps?: HookDeps,
  cwd?: string,
): Promise<Task> {
  await fireHooks("on_blocked", task, taskBranch, baseBranch, confidence, config, hookDeps, cwd);
  const updated = await backend.updateTask(task.id, { state: "blocked", blockers });
  await logEvent(join(getProjectDir(), "logs"), {
    taskId: task.id,
    type: "state_change",
    data: { from: "in_progress", to: "blocked", reason: blockers[0] ?? "unknown reason" },
  });
  await notify("Task Blocked", `${task.id}: ${blockers[0] ?? "unknown reason"}`, config);
  void notifyWebhook({
    taskId: task.id,
    title: task.title,
    oldState: "in_progress",
    newState: "blocked",
    confidence,
    timestamp: new Date().toISOString(),
  }, config);
  return updated;
}

export async function runCompletionLoop(
  task: Task,
  backend: TaskBackend,
  config: Config,
  verbose = false,
  cliFlags: CliFlags = {},
  hookDeps?: HookDeps,
  abortSignal?: AbortSignal,
): Promise<void> {
  const taskDir = join(getProjectDir(), "tasks", task.id);
  const costLogDir = join(getProjectDir(), "logs");

  await logEvent(costLogDir, {
    taskId: task.id,
    type: "run_start",
    data: {
      config: {
        budgetPerTask: config.budgets.perTask,
        budgetGlobal: config.budgets.global,
        confidenceTarget: config.confidence.target,
        onConfidenceMode: resolveOnConfidenceMode(config, cliFlags.merge, cliFlags.noMerge),
        maxAttempts: config.budgets.maxAttemptsPerTask,
        useWorktrees: config.git.useWorktrees,
      },
    },
  });

  await mkdir(taskDir, { recursive: true });

  // Crash recovery: detect interrupted phases from a previous run
  const checkpoint = await readCheckpoint(taskDir);
  if (checkpoint !== null) {
    uiInfo(`Resuming from interrupted ${checkpoint.phase} phase (attempt ${checkpoint.attempt})`);

    // If the execute phase was interrupted, check for uncommitted changes.
    // Use the task's stored worktree path if available (for worktree mode).
    if (checkpoint.phase === "execute") {
      try {
        const recoveryCwd = task.worktree ?? undefined;
        if (await hasUncommittedChanges(recoveryCwd)) {
          uiInfo("Detected uncommitted changes from interrupted execute phase — auto-committing.");
          await commitTaskChanges(task.id, "recovery", `[${task.id}] recovery: uncommitted changes from interrupted execute phase`, undefined, recoveryCwd);
          await appendFile(
            join(taskDir, "progress.md"),
            `\n\n---\n\n## Recovery\n\nProcess was interrupted during execute phase (attempt ${checkpoint.attempt}). Uncommitted changes were auto-committed.\n`,
            "utf-8",
          );
        }
      } catch (err: unknown) {
        uiWarn(`Recovery auto-commit failed: ${errorMsg(err)}`);
      }
    }

    // If a plan was already written (execute or review was interrupted), skip re-planning
    if ((checkpoint.phase === "execute" || checkpoint.phase === "review") && existsSync(join(taskDir, "plan.md"))) {
      const planContent = await readFileOrEmpty(join(taskDir, "plan.md"));
      if (planContent.trim().length > 0) {
        uiInfo("Plan exists from interrupted run — will skip planning phase.");
      }
    }

    // Clear the stale checkpoint; the loop will write fresh ones
    await clearCheckpoint(taskDir);
  }

  // Mark task as in_progress
  let currentTask = await backend.updateTask(task.id, { state: "in_progress" });
  await logEvent(costLogDir, {
    taskId: task.id,
    type: "state_change",
    data: { from: task.state, to: "in_progress", reason: "Task claimed and starting" },
  });
  void notifyWebhook({
    taskId: task.id,
    title: task.title,
    oldState: task.state,
    newState: "in_progress",
    confidence: task.confidence,
    timestamp: new Date().toISOString(),
  }, config);

  // Create a task branch (or worktree) if in a git repo
  let taskBranch: string | null = null;
  let baseBranch: string | null = null;
  let worktreePath: string | undefined;
  const useWorktrees = config.git.useWorktrees;

  if (await isGitRepo()) {
    try {
      baseBranch = await getBaseBranch();
      const branchName = `${config.git.branchPrefix}${task.id}-${slugify(task.title)}`;

      if (useWorktrees) {
        worktreePath = join(getProjectDir(), "worktrees", task.id);
        await createWorktree(baseBranch, branchName, worktreePath);
        taskBranch = branchName;
        currentTask = await backend.updateTask(task.id, { branch: taskBranch, worktree: worktreePath });
      } else {
        taskBranch = await createTaskBranch(task.id, task.title, config.git.branchPrefix, {
          taskDir,
          staleBranchThreshold: config.git.staleBranchThreshold,
          baseBranch,
        });
        currentTask = await backend.updateTask(task.id, { branch: taskBranch });
      }
    } catch (err: unknown) {
      const msg = errorMsg(err);
      uiWarn(`Could not create task branch: ${msg}`);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "error",
        data: { phase: "branch_creation", message: msg },
      });
      if (useWorktrees) {
        // Worktree creation failures don't involve dirty worktree issues
        const blocker = `Cannot create worktree: ${msg}`;
        await moveToBlocked(backend, task, [blocker], null, baseBranch, 0, config, hookDeps);
      } else {
        const isDirtyWorktree = msg.includes("local changes") || msg.includes("Please commit your changes or stash");
        const blocker = isDirtyWorktree
          ? "Cannot switch to task branch: uncommitted changes would be overwritten. Commit or stash your changes, then re-run."
          : `Cannot switch to task branch: ${msg}`;
        await moveToBlocked(backend, task, [blocker], null, baseBranch, 0, config, hookDeps);
      }
      try { await backend.releaseTask(task.id); } catch { /* best-effort */ }
      return;
    }
  }

  // Snapshot pre-existing dirty files before any execute phase runs.
  // In non-worktree mode, the developer may have uncommitted edits that shouldn't be staged.
  // In worktree mode, the worktree is isolated so we don't need to exclude anything.
  const preExistingDirty = useWorktrees ? undefined : await getDirtyFiles();

  // Branch drift guard: after every invokeClaude/runHooks call in non-worktree mode,
  // verify we're still on the task branch. Claude -p can run `git checkout main` internally,
  // which would cause subsequent commits to land on main instead of the task branch.
  async function guardBranch(): Promise<void> {
    if (useWorktrees || taskBranch === null) return;
    try {
      const drifted = await ensureBranch(taskBranch);
      if (drifted) {
        uiWarn(`Branch drift detected — claude switched away from ${taskBranch}. Restored.`);
      }
    } catch (err: unknown) {
      uiWarn(`Could not verify branch: ${errorMsg(err)}`);
    }
  }

  let hasRemediationPlan = false;
  let lastRemediationItems: RemediationItem[] = [];

  // Load previous confidence from persistence file (supports cross-run rollback detection)
  let previousConfidence: number | null = null;
  const lastConfidencePath = join(taskDir, "last_confidence.txt");
  const lastReviewShaPath = join(taskDir, "last_review_sha.txt");
  try {
    const stored = await readFileOrEmpty(lastConfidencePath);
    if (stored.trim().length > 0) {
      const parsed = Number(stored.trim());
      if (!Number.isNaN(parsed)) {
        previousConfidence = parsed;
      }
    }
  } catch {
    // Ignore — first run or corrupted file
  }

  // Phase 0: PREFLIGHT — runs once per task, not per attempt.
  // Skip if understanding.md already exists (task is resuming after a human resolved a blocker).
  const understandingPath = join(taskDir, "understanding.md");
  if (existsSync(understandingPath)) {
    uiInfo("Phase 0: PREFLIGHT [SKIPPED — understanding.md exists, task is resuming]");
    await logEvent(costLogDir, {
      taskId: task.id,
      type: "decision",
      data: { decision: "preflight_skipped", details: "understanding.md exists, task is resuming" },
    });
  } else {
    uiInfo(`Phase 0: PREFLIGHT [${new Date().toLocaleTimeString()}]`);
    await writeCheckpoint(taskDir, "preflight", 0);
    try {
      const preflightSystemPrompt = await loadTemplate("preflight");
      const preflightUserPrompt = await buildPreflightPrompt(currentTask, taskDir);

      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_start",
        data: { phase: "preflight", attempt: 0 },
      });

      const preflightResult = await uiSpinner("Running preflight validation...", () =>
        invokeClaude({
          prompt: preflightUserPrompt,
          systemPrompt: preflightSystemPrompt,
          maxTurns: 20,
          verbose,
          ...(worktreePath ? { cwd: worktreePath } : {}),
        }),
      );

      await guardBranch();

      // Save raw output for debugging (black box recorder)
      await saveRawOutput(taskDir, "preflight", 0, preflightResult.output);
      // Log cost immediately — even if parsing fails, spend is captured
      await logCost(costLogDir, task.id, "preflight", preflightResult.costUsd);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_end",
        data: {
          phase: "preflight",
          attempt: 0,
          costUsd: preflightResult.costUsd,
          durationMs: preflightResult.durationMs,
          exitCode: preflightResult.exitCode,
          outputLength: preflightResult.output.length,
        },
      });
      currentTask = await backend.updateTask(task.id, {
        totalCost: currentTask.totalCost + preflightResult.costUsd,
      });

      if (preflightResult.exitCode !== 0 || preflightResult.output.trim() === "") {
        uiWarn("Preflight phase failed or returned empty output — proceeding anyway (graceful degradation)");
      } else {
        uiInfo(`Phase 0 done [${new Date().toLocaleTimeString()}] (${preflightResult.durationMs}ms, $${preflightResult.costUsd.toFixed(4)}, exit=${preflightResult.exitCode})`);

        const preflight = parsePreflightResult(preflightResult.output);

        // Persist understanding for context bridging (even for non-proceed verdicts)
        await writeFile(understandingPath, preflight.understanding || preflightResult.output, "utf-8");

        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "preflight_verdict", details: preflight.verdict },
        });

        if (preflight.verdict === "proceed") {
          uiSuccess("Preflight: task validated — proceeding to completion loop.");
        } else if (preflight.verdict === "too_broad") {
          if (preflight.subtasks.length === 0) {
            // No subtasks provided — fall back to blocking with a generic message
            const blockerMsg = "Task is too broad but no subtasks were suggested.";
            uiWarn(`Preflight: ${blockerMsg}`);
            const updatedTask = await backend.updateTask(task.id, {
              state: "blocked",
              blockers: [...currentTask.blockers, blockerMsg],
            });
            await logEvent(costLogDir, {
              taskId: task.id,
              type: "state_change",
              data: { from: "in_progress", to: "blocked", reason: "Preflight: too_broad, no subtasks" },
            });
            await recordMemory(updatedTask, getProjectDir());
          } else {
            const { createdIds, updatedTask } = await handleTooBroad(backend, currentTask, preflight, taskDir);
            const idList = createdIds.join(", ");
            uiSuccess(`Preflight: task too broad — created ${createdIds.length} subtasks (${idList}); parent waiting on dependencies`);
            await recordMemory(updatedTask, getProjectDir());
          }
          try { await backend.releaseTask(task.id); } catch { /* best-effort */ }
          if (!useWorktrees && baseBranch !== null && taskBranch !== null) {
            try { await switchBranch(baseBranch); } catch { /* best-effort */ }
          }
          return;
        } else if (preflight.verdict === "unclear") {
          const blockerMsg = preflight.understanding || "Task requirements are unclear — needs clarification.";
          uiWarn(`Preflight: ${blockerMsg}`);
          const updatedTask = await backend.updateTask(task.id, {
            state: "blocked",
            blockers: [...currentTask.blockers, blockerMsg],
          });
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "state_change",
            data: { from: "in_progress", to: "blocked", reason: "Preflight: unclear" },
          });
          await recordMemory(updatedTask, getProjectDir());
          try { await backend.releaseTask(task.id); } catch { /* best-effort */ }
          if (!useWorktrees && baseBranch !== null && taskBranch !== null) {
            try { await switchBranch(baseBranch); } catch { /* best-effort */ }
          }
          return;
        } else if (preflight.verdict === "cannot_reproduce") {
          const blockerMsg = preflight.reproductionResult || "Could not reproduce the reported issue.";
          uiWarn(`Preflight: ${blockerMsg}`);
          const updatedTask = await backend.updateTask(task.id, {
            state: "blocked",
            blockers: [...currentTask.blockers, blockerMsg],
          });
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "state_change",
            data: { from: "in_progress", to: "blocked", reason: "Preflight: cannot_reproduce" },
          });
          await recordMemory(updatedTask, getProjectDir());
          try { await backend.releaseTask(task.id); } catch { /* best-effort */ }
          if (!useWorktrees && baseBranch !== null && taskBranch !== null) {
            try { await switchBranch(baseBranch); } catch { /* best-effort */ }
          }
          return;
        }
      }
    } catch (err: unknown) {
      uiWarn(`Preflight phase error: ${errorMsg(err)} — proceeding anyway`);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "error",
        data: { phase: "preflight", message: errorMsg(err) },
      });
    }
  }

  // Auto-promote: if all dependencies are done and branch has no diff, the work was
  // already completed by subtasks. Skip the entire completion loop to save budget.
  // Only check after at least one attempt — a fresh task (attempts === 0) always has
  // no diff because its branch was just created, and hasn't had a chance to do its own work.
  if (currentTask.dependencies.length > 0 && currentTask.attempts > 0 && taskBranch !== null && baseBranch !== null) {
    try {
      const allDepsDone = await checkAllDependenciesDone(backend, currentTask.dependencies);
      if (allDepsDone) {
        const hasDiff = await hasBranchDiff(baseBranch, taskBranch, worktreePath);
        if (!hasDiff) {
          uiInfo(`All ${currentTask.dependencies.length} dependencies are done and branch has no diff — auto-promoting.`);
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "decision",
            data: { decision: "auto_promote", details: `All ${currentTask.dependencies.length} dependencies done, no branch diff` },
          });
          const mode: OnConfidenceMode = resolveOnConfidenceMode(config, cliFlags.merge, cliFlags.noMerge);
          const targetState = mode === "merge" ? "done" : "review";
          await backend.updateTask(task.id, { state: targetState, confidence: 100 });
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "state_change",
            data: { from: "in_progress", to: targetState, reason: "Auto-promoted: all deps done, no diff" },
          });
          uiSuccess(`Task ${task.id} auto-promoted to ${targetState}.`);
          await notify("Task Auto-Promoted", `${task.id}: ${task.title} (all subtasks done, no new changes)`, config);
          void notifyWebhook({
            taskId: task.id,
            title: task.title,
            oldState: "in_progress",
            newState: targetState,
            confidence: 100,
            timestamp: new Date().toISOString(),
          }, config);
          await recordMemory(await backend.getTask(task.id), getProjectDir());
          await clearCheckpoint(taskDir);
          try { await backend.releaseTask(task.id); } catch { /* best-effort */ }
          if (worktreePath) {
            try {
              await removeWorktree(worktreePath);
              await backend.updateTask(task.id, { worktree: null });
            } catch { /* best-effort */ }
          }
          if (taskBranch) {
            try { await deleteBranch(taskBranch); } catch { /* best-effort */ }
          }
          if (!useWorktrees && baseBranch !== null) {
            try { await switchBranch(baseBranch); } catch { /* best-effort */ }
          }
          return;
        }
      }
    } catch (err: unknown) {
      uiWarn(`Auto-promote check failed: ${errorMsg(err)} — proceeding normally`);
    }
  }

  let budgetWarningFired = false;

  while (true) {
    // Check budget
    if (currentTask.totalCost >= config.budgets.perTask) {
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "decision",
        data: { decision: "budget_exceeded", details: `Per-task: $${currentTask.totalCost.toFixed(2)} >= $${config.budgets.perTask.toFixed(2)}` },
      });
      uiWarn(
        `Task ${task.id} exceeded per-task budget ($${currentTask.totalCost.toFixed(2)} >= $${config.budgets.perTask.toFixed(2)}). Moving to blocked.`,
      );
      const updatedBudgetTask = await moveToBlocked(
        backend, currentTask, [...currentTask.blockers, "Per-task budget exhausted"],
        taskBranch, baseBranch, currentTask.confidence, config, hookDeps, worktreePath,
      );
      await recordMemory(updatedBudgetTask, getProjectDir());
      break;
    }

    // Check global daily budget
    const globalBudgetCheck = await checkGlobalBudget(costLogDir, config.budgets.global);
    await logEvent(costLogDir, {
      taskId: task.id,
      type: "budget_check",
      data: { todayCost: globalBudgetCheck.todayCost, limit: config.budgets.global, exceeded: globalBudgetCheck.exceeded },
    });
    if (globalBudgetCheck.exceeded) {
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "decision",
        data: { decision: "budget_exceeded", details: `Global daily: $${globalBudgetCheck.todayCost.toFixed(2)} >= $${config.budgets.global.toFixed(2)}` },
      });
      uiWarn(
        `Global daily budget exhausted ($${globalBudgetCheck.todayCost.toFixed(2)} >= $${config.budgets.global.toFixed(2)}). Moving task to blocked.`,
      );
      const updatedGlobalTask = await moveToBlocked(
        backend, currentTask, [...currentTask.blockers, "Global daily budget exhausted"],
        taskBranch, baseBranch, currentTask.confidence, config, hookDeps, worktreePath,
      );
      await recordMemory(updatedGlobalTask, getProjectDir());
      break;
    }

    // Budget 80% warning (fire once per runCompletionLoop invocation)
    if (!budgetWarningFired && !globalBudgetCheck.exceeded) {
      const threshold = 0.8 * config.budgets.global;
      if (globalBudgetCheck.todayCost >= threshold) {
        budgetWarningFired = true;
        uiWarn(`Daily budget 80% used ($${globalBudgetCheck.todayCost.toFixed(2)}/$${config.budgets.global.toFixed(2)})`);
        await notify("Budget Warning", `Daily budget 80% used ($${globalBudgetCheck.todayCost.toFixed(2)}/$${config.budgets.global.toFixed(2)})`, config);
      }
    }

    // Check attempts
    if (currentTask.attempts >= config.budgets.maxAttemptsPerTask) {
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "decision",
        data: { decision: "max_attempts_reached", details: `${currentTask.attempts}/${config.budgets.maxAttemptsPerTask}` },
      });
      uiWarn(
        `Task ${task.id} reached max attempts (${currentTask.attempts}/${config.budgets.maxAttemptsPerTask}). Moving to blocked.`,
      );
      const updatedAttemptsTask = await moveToBlocked(
        backend, currentTask, [...currentTask.blockers, "Max attempts exhausted"],
        taskBranch, baseBranch, currentTask.confidence, config, hookDeps, worktreePath,
      );
      await recordMemory(updatedAttemptsTask, getProjectDir());
      break;
    }

    // Fast path: skip plan+execute when confidence already met on a clean, unchanged branch
    if (currentTask.confidence >= config.confidence.target) {
      let dirtyTree = true;
      try { dirtyTree = await hasUncommittedChanges(worktreePath); } catch { /* assume dirty */ }
      if (!dirtyTree) {
        let lastReviewSha: string | null = null;
        try {
          const storedSha = (await readFileOrEmpty(lastReviewShaPath)).trim();
          if (storedSha.length > 0) lastReviewSha = storedSha;
        } catch { /* ignore */ }
        let headSha: string | null = null;
        try { headSha = await getHeadSha(worktreePath); } catch { /* ignore */ }
        if (lastReviewSha !== null && headSha === lastReviewSha) {
          uiInfo(`Confidence ${currentTask.confidence}% >= ${config.confidence.target}% target, branch clean and unchanged — skipping to hook.`);
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "decision",
            data: { decision: "skip_to_hook", details: `${currentTask.confidence}% >= ${config.confidence.target}% target, no dirty files, HEAD ${headSha?.slice(0, 8)} matches last review` },
          });
          const result = await handleConfidenceMet(
            currentTask, config, backend, taskBranch, baseBranch, taskDir, cliFlags, hookDeps, verbose, worktreePath,
          );
          if (result.state === "in_progress") {
            uiInfo("Blocking hook applied fixes — retrying.");
            continue;
          }
          if (result.state === "blocked") {
            const blockedTask = await backend.getTask(task.id);
            await recordMemory(blockedTask, getProjectDir());
            break;
          }
          const doneTask = await backend.getTask(task.id);
          await recordMemory(doneTask, getProjectDir());
          if (result.mergedSuccessfully) {
            taskBranch = null;
          }
          break;
        }
      }
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
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "plan_skipped", details: "Using remediation plan from previous review" },
        });
        hasRemediationPlan = false;
      } else {
        await writeCheckpoint(taskDir, "plan", attempt);
        const planSystemPrompt = await loadTemplate("plan");
        const planUserPrompt = await buildPlanPrompt(currentTask, taskDir);

        uiInfo(`Phase 1: PLAN [${new Date().toLocaleTimeString()}]`);
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "phase_start",
          data: { phase: "plan", attempt },
        });
        const planResult = await uiSpinner("Planning...", () =>
          invokeClaude({
            prompt: planUserPrompt,
            systemPrompt: planSystemPrompt,
            maxTurns: 20,
            verbose,
            ...(worktreePath ? { cwd: worktreePath } : {}),
          }),
        );

        await guardBranch();

        if (planResult.exitCode !== 0) {
          if (!abortSignal?.aborted) uiError(`Plan phase failed (exit code ${planResult.exitCode})`);
          throw new Error(`Plan phase failed: ${planResult.output}`);
        }

        if (planResult.output.trim() === "") {
          if (!abortSignal?.aborted) uiWarn("Plan phase returned empty output — retrying");
          throw new Error("Plan phase returned empty output");
        }

        uiInfo(`Phase 1 done [${new Date().toLocaleTimeString()}] (${planResult.durationMs}ms, $${planResult.costUsd.toFixed(4)}, exit=${planResult.exitCode})`);
        await writeFile(join(taskDir, "plan.md"), planResult.output, "utf-8");
        await saveRawOutput(taskDir, "plan", attempt, planResult.output);
        await logCost(costLogDir, task.id, "plan", planResult.costUsd);
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "phase_end",
          data: {
            phase: "plan",
            attempt,
            costUsd: planResult.costUsd,
            durationMs: planResult.durationMs,
            exitCode: planResult.exitCode,
            outputLength: planResult.output.length,
          },
        });
        phaseCost += planResult.costUsd;

        // Check context window usage after plan phase
        const planCtxResult = await applyContextWindowExceeded(backend, task.id, currentTask, phaseCost, planResult.contextWindowPercent, config.budgets.contextWindowLimit);
        if (planCtxResult) {
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "decision",
            data: { decision: "context_window_exceeded", details: "Plan phase context window exceeded" },
          });
          currentTask = planCtxResult;
          // phaseCost resets at loop top (let phaseCost = 0); totalCost persisted in backend
          continue;
        }
      }

      // Record HEAD SHA before execute for rollback safety
      let preExecuteSha: string | null = null;
      if (taskBranch !== null) {
        try {
          preExecuteSha = await getHeadSha(worktreePath);
        } catch (err: unknown) {
          uiWarn(`Could not record pre-execute SHA: ${errorMsg(err)}`);
        }
      }

      // Run on_execute_start hooks before Phase 2
      await fireHooks("on_execute_start", currentTask, taskBranch, baseBranch, previousConfidence ?? 0, config, hookDeps, worktreePath);
      await guardBranch();

      // Phase 2: EXECUTE
      await writeCheckpoint(taskDir, "execute", attempt);
      const executeSystemPrompt = await loadTemplate("execute");
      const executeUserPrompt = await buildExecutePrompt(currentTask, taskDir);

      uiInfo(`Phase 2: EXECUTE [${new Date().toLocaleTimeString()}]`);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_start",
        data: { phase: "execute", attempt },
      });
      const executeResult = await uiSpinner("Executing...", () =>
        invokeClaude({
          prompt: executeUserPrompt,
          systemPrompt: executeSystemPrompt,
          maxTurns: 50,
          verbose,
          ...(worktreePath ? { cwd: worktreePath } : {}),
        }),
      );

      if (executeResult.exitCode !== 0) {
        if (!abortSignal?.aborted) uiError(`Execute phase failed (exit code ${executeResult.exitCode})`);
        throw new Error(`Execute phase failed: ${executeResult.output}`);
      }

      if (executeResult.output.trim() === "") {
        if (!abortSignal?.aborted) uiWarn("Execute phase returned empty output — retrying");
        throw new Error("Execute phase returned empty output");
      }

      // Append to progress.md
      const progressSeparator = `\n\n---\n\n## Attempt ${attempt}\n\n`;
      await appendFile(
        join(taskDir, "progress.md"),
        progressSeparator + executeResult.output,
        "utf-8",
      );
      await saveRawOutput(taskDir, "execute", attempt, executeResult.output);
      await logCost(costLogDir, task.id, "execute", executeResult.costUsd);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_end",
        data: {
          phase: "execute",
          attempt,
          costUsd: executeResult.costUsd,
          durationMs: executeResult.durationMs,
          exitCode: executeResult.exitCode,
          outputLength: executeResult.output.length,
        },
      });
      phaseCost += executeResult.costUsd;

      // Guard against branch drift before committing — ensures changes land on the task branch
      await guardBranch();

      // Auto-commit after execute phase
      if (taskBranch !== null) {
        try {
          await commitTaskChanges(task.id, `attempt-${attempt}`, undefined, undefined, worktreePath, preExistingDirty);
        } catch (err: unknown) {
          uiWarn(`Could not auto-commit: ${errorMsg(err)}`);
        }
      }

      // Note: no context window check after execute. Each phase is a separate `claude -p` call
      // with a fresh context window, so execute's usage doesn't affect review quality. Skipping
      // review here would create a plan→execute loop with no confidence evaluation — the task
      // can only exit via budget/attempt exhaustion, wasting both.

      // Diff marker verification: check if executor addressed high-weight remediation items
      if (lastRemediationItems.length > 0 && baseBranch !== null) {
        const verification = await verifyRemediationMarkers(
          lastRemediationItems, baseBranch, worktreePath,
        );
        if (!verification.passed) {
          await logEvent(costLogDir, {
            taskId: task.id,
            type: "decision",
            data: { decision: "remediation_markers_missing", details: `${verification.missingItems.length} high-weight item(s) missing from diff` },
          });
          const missing = verification.missingItems
            .map((item) => `- **[${item.category}]** ${item.title} (weight: ${item.weight})`)
            .join("\n");
          uiWarn(
            `Diff marker check: ${verification.missingItems.length} high-weight item(s) missing from diff.`,
          );

          const originalPlan = await readFileOrEmpty(join(taskDir, "plan.md"));
          const reExecPlan = [
            "<!-- RE-EXECUTION: Diff marker verification failed -->",
            "<!-- The following high-weight remediation items were NOT found in the git diff. -->",
            "<!-- You MUST address these before your work will be reviewed. -->",
            "",
            "## CRITICAL: Missing Remediation Items",
            "",
            missing,
            "",
            "The review phase will NOT run until these items appear in the diff.",
            "Focus on the missing items above — they are worth the most points.",
            "",
            "## Original Remediation Plan",
            "",
            originalPlan,
          ].join("\n");
          await writeFile(join(taskDir, "plan.md"), reExecPlan, "utf-8");
          hasRemediationPlan = true;
          uiInfo("Looping back to execute — review skipped until missing items are addressed.");
          continue;
        }
        lastRemediationItems = [];
      }

      // Phase 3: REVIEW
      // Guard branch BEFORE review — ensures the reviewer starts on the task branch
      await guardBranch();

      await writeCheckpoint(taskDir, "review", attempt);
      const reviewSystemPrompt = await loadTemplate("review");
      const reviewUserPrompt = await buildReviewPrompt(currentTask, taskDir, {
        taskBranch,
        baseBranch,
      });

      uiInfo(`Phase 3: REVIEW [${new Date().toLocaleTimeString()}]`);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_start",
        data: { phase: "review", attempt },
      });
      const reviewResult = await uiSpinner("Reviewing...", () =>
        invokeClaude({
          prompt: reviewUserPrompt,
          systemPrompt: reviewSystemPrompt,
          maxTurns: 20,
          verbose,
          ...(worktreePath ? { cwd: worktreePath } : {}),
        }),
      );

      await guardBranch();

      if (reviewResult.exitCode !== 0) {
        if (!abortSignal?.aborted) uiError(`Review phase failed (exit code ${reviewResult.exitCode})`);
        throw new Error(`Review phase failed: ${reviewResult.output}`);
      }

      if (reviewResult.output.trim() === "") {
        if (!abortSignal?.aborted) uiWarn("Review phase returned empty output — retrying");
        throw new Error("Review phase returned empty output");
      }

      await writeFile(
        join(taskDir, "test_results.md"),
        reviewResult.output,
        "utf-8",
      );
      await saveRawOutput(taskDir, "review", attempt, reviewResult.output);
      await logCost(costLogDir, task.id, "review", reviewResult.costUsd);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "phase_end",
        data: {
          phase: "review",
          attempt,
          costUsd: reviewResult.costUsd,
          durationMs: reviewResult.durationMs,
          exitCode: reviewResult.exitCode,
          outputLength: reviewResult.output.length,
        },
      });
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

      // Run on_review_complete hooks after review parsing
      await fireHooks("on_review_complete", currentTask, taskBranch, baseBranch, review.confidence, config, hookDeps, worktreePath);
      await guardBranch();

      // Rollback safety: detect confidence regression
      if (isConfidenceRegression(review.confidence, previousConfidence) && preExecuteSha !== null) {
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "confidence_regression", details: `${review.confidence}% < ${previousConfidence}% (previous)` },
        });
        uiWarn(`Confidence regressed: ${review.confidence}% < ${previousConfidence}% (previous). Rolling back.`);
        let shaAfterRollback = preExecuteSha;
        try {
          await resetToSha(preExecuteSha, worktreePath);
          try { shaAfterRollback = await getHeadSha(worktreePath); } catch { /* use preExecuteSha */ }
          uiInfo(`Rolled back to ${preExecuteSha.slice(0, 8)}`);
        } catch (rollbackErr: unknown) {
          uiError(`Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "rollback",
          data: { shaBefore: preExecuteSha, shaAfter: shaAfterRollback, reason: "Confidence regression" },
        });
        // Log failure in progress.md
        const rollbackMsg = `\n\n---\n\n## Attempt ${attempt} — ROLLED BACK\n\nConfidence regressed from ${previousConfidence}% to ${review.confidence}%. Changes reverted to ${preExecuteSha.slice(0, 8)}.\n`;
        await appendFile(join(taskDir, "progress.md"), rollbackMsg, "utf-8");
        // Move to blocked
        const updatedRegressionTask = await moveToBlocked(
          backend, currentTask,
          [...currentTask.blockers, `Confidence regression: ${review.confidence}% < ${previousConfidence}% (previous attempt). Execute phase rolled back.`],
          taskBranch, baseBranch, review.confidence, config, hookDeps, worktreePath,
        );
        await recordMemory(updatedRegressionTask, getProjectDir());
        break;
      }

      // Persist confidence for cross-run rollback detection
      previousConfidence = review.confidence;
      await writeFile(lastConfidencePath, String(review.confidence), "utf-8");
      // Persist HEAD SHA so the skip-to-hook fast path can detect unchanged branches
      try {
        const reviewHeadSha = await getHeadSha(worktreePath);
        await writeFile(lastReviewShaPath, reviewHeadSha, "utf-8");
      } catch { /* best-effort — fast path will simply not trigger if missing */ }

      // Check if we've reached the target
      if (review.confidence >= config.confidence.target) {
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "confidence_met", details: `${review.confidence}% >= ${config.confidence.target}% target` },
        });
        uiSuccess(
          `Task ${task.id} reached ${review.confidence}% confidence.`,
        );
        const result = await handleConfidenceMet(
          currentTask, config, backend, taskBranch, baseBranch, taskDir, cliFlags, hookDeps, verbose, worktreePath,
        );
        if (result.state === "in_progress") {
          // Blocking hook failed but applied fixes — retry with the new code
          uiInfo("Blocking hook applied fixes — retrying.");
          continue;
        }
        if (result.state === "blocked") {
          // Blocking hook failed with no fixes — retrying won't help
          const blockedTask = await backend.getTask(task.id);
          await recordMemory(blockedTask, getProjectDir());
          break;
        }
        // Record success in planning memory
        const doneTask = await backend.getTask(task.id);
        await recordMemory(doneTask, getProjectDir());
        if (result.mergedSuccessfully) {
          // Merge already checked out base branch — skip end-of-loop switchBranch
          taskBranch = null;
        }
        break;
      }

      // Check for blockers from review
      if (review.blockers.length > 0) {
        await writeFile(
          join(taskDir, "blockers.md"),
          review.blockers.join("\n"),
          "utf-8",
        );
        const updatedBlockedTask = await moveToBlocked(
          backend, currentTask, review.blockers,
          taskBranch, baseBranch, review.confidence, config, hookDeps, worktreePath,
        );
        uiWarn(
          `Task ${task.id} blocked: ${review.blockers.join("; ")}`,
        );
        await recordMemory(updatedBlockedTask, getProjectDir());
        break;
      }

      // Write remediation plan for the next attempt's execute phase (skipping plan phase)
      if (review.remediationPlan.trim().length > 0) {
        const scoringTable = buildScoringTable(
          review.breakdown, review.confidence, config.confidence.target,
        );
        const remediationHeader = [
          "<!-- REMEDIATION PLAN — written by the reviewer after a sub-target confidence score -->",
          "<!-- IMPORTANT: Every item below was identified as a specific gap that prevented the",
          "     previous attempt from reaching the confidence target. You MUST complete ALL items.",
          "     Items are tagged with [category] to show which score they affect. -->",
          "",
          scoringTable,
        ].join("\n");
        await writeFile(
          join(taskDir, "plan.md"),
          remediationHeader + review.remediationPlan,
          "utf-8",
        );
        hasRemediationPlan = true;
        lastRemediationItems = review.remediationItems;
        await logEvent(costLogDir, {
          taskId: task.id,
          type: "decision",
          data: { decision: "remediation_plan_written", details: `Confidence ${review.confidence}% below target ${config.confidence.target}%, wrote remediation plan` },
        });
        uiInfo("Remediation plan written — next attempt will skip planning phase.");
      }

      // Not done yet — loop
      uiInfo(
        `Confidence ${review.confidence}% < ${config.confidence.target}%. Looping for another attempt.`,
      );
    } catch (error: unknown) {
      // If abort was signalled (e.g. Ctrl+C graceful stop), exit quietly
      if (abortSignal?.aborted) {
        uiInfo("Task interrupted — will resume on next run.");
        break;
      }

      const message =
        error instanceof Error ? error.message : String(error);
      uiError(`Error during attempt ${attempt}: ${message}`);
      await logEvent(costLogDir, {
        taskId: task.id,
        type: "error",
        data: { phase: "attempt", message },
      });

      // Update cost even on failure
      if (phaseCost > 0) {
        currentTask = await backend.updateTask(task.id, {
          totalCost: currentTask.totalCost + phaseCost,
        });
      }

      // Transient errors (empty output, timeouts) → continue looping
      // Only break on permanent errors or if we're out of attempts
      // Note: timeouts and rate limits are already retried with exponential
      // backoff inside invokeClaude() (up to 3 retries). This is the fallback
      // if all invoke-level retries were exhausted.
      const isTransient = message.includes("empty output") || message.includes("timed out");
      if (!isTransient) {
        // Permanent error — keep task in_progress so it can resume later
        break;
      }
      // Transient error — will loop back and check attempt/budget limits
      hasRemediationPlan = false;
      lastRemediationItems = [];
      uiInfo("Transient error — will retry on next attempt");
    }
  }

  // Clean up checkpoint on normal exit
  await clearCheckpoint(taskDir);

  // Release task claim so other instances can pick it up if it's re-queued
  try {
    await backend.releaseTask(task.id);
  } catch {
    // Best-effort: claim file may not exist
  }

  // Switch back to base branch (only needed in branch-switching mode — worktrees don't touch the main working tree)
  if (!useWorktrees && baseBranch !== null && taskBranch !== null) {
    try {
      await switchBranch(baseBranch);
    } catch (err: unknown) {
      uiWarn(`Could not switch back to ${baseBranch}: ${errorMsg(err)}`);
    }
  }
}
