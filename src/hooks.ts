import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { invokeClaude, logCost } from "./invoke.js";
import type { InvokeOptions } from "./invoke.js";
import type { Config, Hook, HookTrigger } from "./config.js";
import type { Task } from "./tasks/types.js";
import { uiWarn } from "./ui.js";

export interface HookContext {
  task: Task;
  branchName: string | null;
  baseBranch: string;
  confidence: number;
  config: Config;
}

export interface HookResult {
  success: boolean;
  output: string;
  issues: string[];
  remediationActions: string[];
  costUsd: number;
}

/**
 * A skill definition maps a hook context to invoke options.
 * Skills are named prompt templates that encapsulate a specific workflow.
 */
export type SkillDefinition = (ctx: HookContext) => InvokeOptions;

/**
 * Built-in skill registry. Maps skill names to their prompt workflows.
 */
const skillRegistry = new Map<string, SkillDefinition>([
  ["simplify", (ctx) => ({
    prompt: [
      `First, run \`git diff ${ctx.baseBranch}..HEAD\` to see all changes on this branch.`,
      "Review the changed code for reuse, quality, and efficiency.",
      "Look for duplicated logic that could be extracted, overly complex implementations",
      "that could be simplified, and inefficient patterns that could be optimized.",
      "Then fix any issues found.",
    ].join(" "),
    systemPrompt: [
      "You are a code quality reviewer for an autonomous task completion system.",
      `Task: ${ctx.task.title}`,
      `Description: ${ctx.task.description}`,
      `Branch: ${ctx.branchName ?? "none"}`,
      `Base branch: ${ctx.baseBranch}`,
      "",
      `Start by examining the diff between the task branch and ${ctx.baseBranch}.`,
      `Use the git diff output to identify specific files and hunks that need improvement.`,
      "",
      "Respond with a JSON object containing:",
      '  - "pass": boolean (true if code quality is acceptable)',
      '  - "issues": string[] (list of quality issues found)',
      '  - "remediationActions": string[] (concrete fixes to apply)',
    ].join("\n"),
    maxTurns: 5,
  })],
]);

/**
 * Looks up a skill by name in the registry.
 * Returns undefined if the skill is not registered.
 */
export function resolveSkill(name: string): SkillDefinition | undefined {
  return skillRegistry.get(name);
}

/**
 * Runs a skill-based hook: looks up the skill, invokes Claude with the
 * skill's prompt configuration, and parses the result.
 * Returns a failure result if the skill is not found.
 */
export async function runSkillHook(
  skillName: string,
  context: HookContext,
  deps: HookDeps,
): Promise<HookResult> {
  const skill = resolveSkill(skillName);
  if (skill === undefined) {
    return {
      success: false,
      output: "",
      issues: [`Unknown skill: "${skillName}"`],
      remediationActions: [`Register the "${skillName}" skill or use a "prompt" field instead`],
      costUsd: 0,
    };
  }

  const invokeOptions = skill(context);
  const result = await deps.invoke(invokeOptions);
  const parsed = parseHookResult(result.output);

  return {
    success: parsed.pass,
    output: result.output,
    issues: parsed.issues,
    remediationActions: parsed.remediationActions,
    costUsd: result.costUsd,
  };
}

/**
 * Filters configured hooks by trigger point and evaluates conditions.
 * A hook is included if its trigger matches and all conditions are met
 * (e.g. context.confidence >= minConfidence).
 */
export function getHooksForTrigger(
  trigger: HookTrigger,
  hooks: Hook[],
  context: HookContext,
): Hook[] {
  return hooks.filter((hook) => {
    if (hook.trigger !== trigger) return false;

    if (hook.conditions?.minConfidence !== undefined) {
      if (context.confidence < hook.conditions.minConfidence) return false;
    }

    return true;
  });
}

/**
 * Resolves a prompt string. If it looks like a file path
 * (starts with ./, /, templates/, or ends with .md/.txt), reads the file.
 * Otherwise returns the inline string directly.
 * Falls back to raw string on file read failure.
 */
export async function buildHookPrompt(hook: Pick<Hook, "prompt">): Promise<string> {
  const prompt = hook.prompt;
  if (prompt === undefined) return "";

  const isFilePath =
    prompt.startsWith("./") ||
    prompt.startsWith("/") ||
    prompt.startsWith("templates/") ||
    /\.(md|txt)$/.test(prompt);

  if (!isFilePath) {
    return prompt;
  }

  try {
    return await readFile(prompt, "utf-8");
  } catch {
    // Graceful degradation: use raw string if file can't be read
    return prompt;
  }
}

/**
 * Parses hook output as pass/fail JSON. Extracts JSON from raw output
 * using brace-matching (handles markdown code blocks).
 * Defaults to pass: true if JSON parsing fails (graceful degradation).
 */
export function parseHookResult(output: string): {
  pass: boolean;
  issues: string[];
  remediationActions: string[];
} {
  const defaultResult = { pass: true, issues: [] as string[], remediationActions: [] as string[] };

  if (output.trim() === "") return defaultResult;

  // Try brace-matching to extract JSON
  const firstBrace = output.indexOf("{");
  if (firstBrace === -1) return defaultResult;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < output.length; i++) {
    if (output[i] === "{") depth++;
    else if (output[i] === "}") {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return defaultResult;

  try {
    const parsed: unknown = JSON.parse(output.slice(firstBrace, lastBrace + 1));
    if (typeof parsed !== "object" || parsed === null) return defaultResult;

    const record = parsed as Record<string, unknown>;
    const pass = typeof record["pass"] === "boolean" ? record["pass"] : true;
    const issues = Array.isArray(record["issues"])
      ? (record["issues"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const remediationActions = Array.isArray(record["remediationActions"])
      ? (record["remediationActions"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    return { pass, issues, remediationActions };
  } catch {
    return defaultResult;
  }
}

/** Dependencies that can be injected for testing. */
export interface HookDeps {
  invoke: typeof invokeClaude;
  log: typeof logCost;
  warn: typeof uiWarn;
}

const defaultDeps: HookDeps = {
  invoke: invokeClaude,
  log: logCost,
  warn: uiWarn,
};

/**
 * Builds the system prompt that provides task context to the hook validator.
 */
export function buildHookSystemPrompt(context: HookContext): string {
  return [
    "You are a hook validator for an autonomous task completion system.",
    `Task: ${context.task.title}`,
    `Description: ${context.task.description}`,
    `Confidence: ${context.confidence}%`,
    `Branch: ${context.branchName ?? "none"}`,
    `Base branch: ${context.baseBranch}`,
    "",
    "Evaluate the task according to the hook prompt below.",
    "Respond with a JSON object containing:",
    '  - "pass": boolean (true if the check passes)',
    '  - "issues": string[] (list of issues found)',
    '  - "remediationActions": string[] (suggested fixes)',
  ].join("\n");
}

/**
 * Runs a single hook: checks for skill first (takes precedence), then falls
 * back to prompt resolution. Invokes Claude and parses the result.
 */
export async function runHook(
  hook: Hook,
  context: HookContext,
  deps: HookDeps = defaultDeps,
): Promise<HookResult> {
  // Skill takes precedence over prompt
  if (hook.skill !== undefined) {
    return runSkillHook(hook.skill, context, deps);
  }

  const prompt = await buildHookPrompt(hook);
  const systemPrompt = buildHookSystemPrompt(context);

  const result = await deps.invoke({
    prompt,
    systemPrompt,
    maxTurns: 3,
  });

  const parsed = parseHookResult(result.output);

  return {
    success: parsed.pass,
    output: result.output,
    issues: parsed.issues,
    remediationActions: parsed.remediationActions,
    costUsd: result.costUsd,
  };
}

/**
 * Orchestrates hook execution for a trigger point.
 * Runs matching hooks sequentially, logs cost, and handles blocking vs advisory behavior:
 * - Blocking hooks that fail cause immediate short-circuit (allPassed: false)
 * - Advisory hooks that fail log a warning but continue
 */
export async function runHooks(
  triggerPoint: HookTrigger,
  context: HookContext,
  config: Config,
  deps: HookDeps = defaultDeps,
): Promise<{ allPassed: boolean; results: HookResult[] }> {
  const matchingHooks = getHooksForTrigger(triggerPoint, config.hooks, context);
  const results: HookResult[] = [];
  const logDir = join(process.cwd(), ".hootl", "logs");

  for (const hook of matchingHooks) {
    const result = await runHook(hook, context, deps);
    results.push(result);

    // Log cost for this hook invocation
    await deps.log(logDir, context.task.id, `hook:${triggerPoint}`, result.costUsd);

    if (!result.success) {
      if (hook.blocking) {
        return { allPassed: false, results };
      }
      // Advisory: warn and continue
      deps.warn(
        `Advisory hook failed for trigger "${triggerPoint}": ${result.issues.join(", ") || "no details"}`,
      );
    }
  }

  return { allPassed: true, results };
}
