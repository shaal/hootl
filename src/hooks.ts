import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Formats a hook as a human-readable label for display in lists.
 * Used by `hooks list` and `hooks remove` commands.
 */
export function formatHookLabel(hook: Hook, index: number): string {
  const num = index + 1;
  const mode = hook.blocking ? "blocking" : "advisory";

  let target: string;
  if (hook.skill !== undefined) {
    target = `skill:${hook.skill}`;
  } else if (hook.prompt !== undefined) {
    const truncated = hook.prompt.length > 40
      ? hook.prompt.slice(0, 37) + "..."
      : hook.prompt;
    target = `prompt:"${truncated}"`;
  } else {
    target = "(no prompt or skill)";
  }

  return `${num}) ${hook.trigger} → ${target} [${mode}]`;
}

/**
 * Validates a 1-based index argument for hook removal.
 * Returns the 0-based index on success, or null if invalid.
 */
export function validateRemoveIndex(indexArg: string, hookCount: number): number | null {
  if (hookCount === 0) return null;
  const parsed = parseInt(indexArg, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > hookCount) return null;
  return parsed - 1;
}

/**
 * A skill definition maps a hook context to invoke options.
 * Skills are named prompt templates that encapsulate a specific workflow.
 * May be async (e.g. to read template files from disk).
 */
export type SkillDefinition = (ctx: HookContext) => InvokeOptions | Promise<InvokeOptions>;

/**
 * Reads a skill template from templates/ directory relative to the package root.
 * Returns null if the file cannot be read (graceful degradation).
 */
async function loadSkillTemplate(name: string): Promise<string | null> {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const templatesDir = join(dirname(thisFile), "..", "templates");
    return await readFile(join(templatesDir, `${name}.md`), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Built-in skill registry. Maps skill names to their prompt workflows.
 */
const skillRegistry = new Map<string, SkillDefinition>([
  ["simplify", async (ctx) => {
    const template = await loadSkillTemplate("validate-simplify");

    // If template loaded, use it as system prompt with variable substitution
    if (template !== null) {
      const systemPrompt = template
        .replace(/\{\{baseBranch\}\}/g, ctx.baseBranch)
        .replace(/\{\{taskTitle\}\}/g, ctx.task.title)
        .replace(/\{\{taskDescription\}\}/g, ctx.task.description)
        .replace(/\{\{branchName\}\}/g, ctx.branchName ?? "none");

      return {
        prompt: [
          `Run \`git diff ${ctx.baseBranch}..HEAD\` to see all changes on this branch.`,
          "Review the changed code for reuse, quality, and efficiency.",
          "Fix any issues found, then run the test suite to verify tests still pass.",
          "Output your result as JSON following the system prompt instructions.",
        ].join(" "),
        systemPrompt,
        maxTurns: 10,
        disallowedTools: ["Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)"],
      };
    }

    // Fallback: inline prompt if template cannot be read
    return {
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
        '  - "passed": boolean (true if code quality is acceptable)',
        '  - "confidence": number (0-100)',
        '  - "issues": string[] (list of quality issues found)',
        '  - "fixes_applied": string[] (concrete fixes applied)',
      ].join("\n"),
      maxTurns: 10,
      disallowedTools: ["Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)"],
    };
  }],
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

  const invokeOptions = await skill(context);
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
 * Supports both old field names (pass, remediationActions) and new ones
 * (passed, fixes_applied, confidence). New names take precedence.
 * Defaults to pass: true if JSON parsing fails (graceful degradation).
 */
export function parseHookResult(output: string): {
  pass: boolean;
  issues: string[];
  remediationActions: string[];
  confidence: number | null;
} {
  const defaultResult = { pass: true, issues: [] as string[], remediationActions: [] as string[], confidence: null as number | null };

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

    // "passed" (new) takes precedence over "pass" (old)
    const pass = typeof record["passed"] === "boolean"
      ? record["passed"]
      : typeof record["pass"] === "boolean"
        ? record["pass"]
        : true;

    const issues = Array.isArray(record["issues"])
      ? (record["issues"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    // "fixes_applied" (new) takes precedence over "remediationActions" (old)
    const remediationActions = Array.isArray(record["fixes_applied"])
      ? (record["fixes_applied"] as unknown[]).filter((x): x is string => typeof x === "string")
      : Array.isArray(record["remediationActions"])
        ? (record["remediationActions"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];

    const confidence = typeof record["confidence"] === "number" ? record["confidence"] : null;

    return { pass, issues, remediationActions, confidence };
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
/**
 * Builds a HookContext with a synthetic minimal task for testing hooks
 * outside the completion loop. Used by `hootl hooks test`.
 */
export function buildTestHookContext(
  config: Config,
  branchName: string,
  baseBranch: string,
  confidence: number,
): HookContext {
  const now = new Date().toISOString();
  const syntheticTask: Task = {
    id: "test",
    title: "Hook test",
    description: "Manual hook test run",
    priority: "medium",
    type: "feature",
    state: "in_progress",
    dependencies: [],
    backend: "local",
    backendRef: null,
    confidence: 0,
    attempts: 0,
    totalCost: 0,
    branch: branchName,
    worktree: null,
    userPriority: null,
    blockers: [],
    createdAt: now,
    updatedAt: now,
  };

  return {
    task: syntheticTask,
    branchName,
    baseBranch,
    confidence,
    config,
  };
}

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
