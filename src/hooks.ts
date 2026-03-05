import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { invokeClaude, logCost } from "./invoke.js";
import type { Config, HookTrigger, Hook } from "./config.js";
import type { Task } from "./tasks/types.js";
import { uiInfo, uiWarn } from "./ui.js";

export interface HookContext {
  task: Task;
  taskDir: string;
  baseBranch: string | null;
  taskBranch: string | null;
  confidence: number | null;
  config: Config;
}

export interface HookResult {
  hookPrompt: string;
  success: boolean;
  output: string;
  costUsd: number;
  remediation?: string;
}

export interface HookRunResult {
  allPassed: boolean;
  results: HookResult[];
  totalCost: number;
}

// --- Skill Registry ---
// Built-in skills are prompt builders keyed by name. Hooks reference them with "/skillName" syntax.

type SkillBuilder = (ctx: HookContext) => string;

const skillRegistry = new Map<string, SkillBuilder>();

skillRegistry.set("simplify", (ctx: HookContext): string => {
  const branch = ctx.taskBranch ?? "HEAD";
  const base = ctx.baseBranch ?? "main";
  return [
    `Review all code changes on branch "${branch}" compared to "${base}" using \`git diff ${base}...HEAD\`.`,
    "",
    "For each changed file, check for:",
    "- Code reuse opportunities (duplicated logic that could be extracted)",
    "- Quality issues (error handling gaps, missing edge cases, unclear naming)",
    "- Efficiency problems (unnecessary allocations, redundant operations)",
    "",
    "Fix any issues you find directly in the code. After fixing, run the project's test suite to verify nothing is broken.",
    "",
    "Output a JSON object with your assessment:",
    '```',
    '{',
    '  "pass": true/false,',
    '  "issues": ["description of each issue found"],',
    '  "fixed": ["description of each fix applied"]',
    '}',
    '```',
  ].join("\n");
});

export function getSkillRegistry(): ReadonlyMap<string, SkillBuilder> {
  return skillRegistry;
}

// --- Prompt Resolution ---

async function loadTemplateFile(name: string): Promise<string> {
  const thisFile = fileURLToPath(import.meta.url);
  const templatesDir = join(dirname(thisFile), "..", "templates");
  const templatePath = join(templatesDir, name);
  return readFile(templatePath, "utf-8");
}

export async function resolvePrompt(hook: Hook, ctx: HookContext): Promise<string> {
  const prompt = hook.prompt;

  // Skill reference: "/simplify" -> look up in registry
  if (prompt.startsWith("/")) {
    const skillName = prompt.slice(1);
    const builder = skillRegistry.get(skillName);
    if (builder === undefined) {
      throw new Error(`Unknown skill: ${prompt}. Available skills: ${[...skillRegistry.keys()].join(", ")}`);
    }
    return builder(ctx);
  }

  // Template file reference: "templates/foo.md" -> load from disk
  if (prompt.startsWith("templates/")) {
    const fileName = prompt.slice("templates/".length);
    return loadTemplateFile(fileName);
  }

  // Inline prompt: return as-is
  return prompt;
}

// --- Condition Evaluation ---

export function evaluateConditions(hook: Hook, ctx: HookContext): boolean {
  if (hook.conditions === undefined) return true;

  if (hook.conditions.minConfidence !== undefined) {
    if (ctx.confidence === null) return false;
    if (ctx.confidence < hook.conditions.minConfidence) return false;
  }

  return true;
}

// --- Output Parsing ---

export interface ParsedHookOutput {
  success: boolean;
  issues: string[];
  fixed: string[];
}

export function parseHookOutput(output: string): ParsedHookOutput {
  if (output.trim() === "") {
    return { success: false, issues: [], fixed: [] };
  }

  // Try to extract JSON from code block or brace-matching
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  const candidates: string[] = [];
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1]);
  }
  const braceMatch = /\{[\s\S]*\}/.exec(output);
  if (braceMatch && braceMatch[0] !== codeBlockMatch?.[1]) {
    candidates.push(braceMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) continue;

      const record = parsed as Record<string, unknown>;

      const pass = record["pass"];
      const success = pass === true;

      const issues = Array.isArray(record["issues"])
        ? (record["issues"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];

      const fixed = Array.isArray(record["fixed"])
        ? (record["fixed"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];

      return { success, issues, fixed };
    } catch {
      continue;
    }
  }

  // Fallback: non-empty, non-error output treated as success
  return { success: true, issues: [], fixed: [] };
}

// --- Single Hook Execution ---

async function runSingleHook(
  hook: Hook,
  ctx: HookContext,
  logDir: string,
): Promise<HookResult> {
  const prompt = await resolvePrompt(hook, ctx);

  // Load system prompt for skill-based hooks
  let systemPrompt: string | undefined;
  if (hook.prompt.startsWith("/")) {
    const skillName = hook.prompt.slice(1);
    try {
      systemPrompt = await loadTemplateFile(`${skillName}.md`);
    } catch {
      // No system prompt template — that's fine, run without one
    }
  }

  const result = await invokeClaude({
    prompt,
    systemPrompt,
    maxTurns: 50,
    verbose: false,
  });

  // Log cost
  await logCost(logDir, ctx.task.id, `hook:${hook.prompt}`, result.costUsd);

  const parsed = parseHookOutput(result.output);

  const hookResult: HookResult = {
    hookPrompt: hook.prompt,
    success: result.exitCode === 0 && parsed.success,
    output: result.output,
    costUsd: result.costUsd,
  };

  if (parsed.issues.length > 0) {
    hookResult.remediation = parsed.issues.join("; ");
  }

  return hookResult;
}

// --- Hook Orchestrator ---

export async function runHooks(
  trigger: HookTrigger,
  ctx: HookContext,
): Promise<HookRunResult> {
  const hooks = ctx.config.hooks.filter((h) => h.trigger === trigger);

  if (hooks.length === 0) {
    return { allPassed: true, results: [], totalCost: 0 };
  }

  const logDir = join(ctx.taskDir, "..", "..", "logs");
  const results: HookResult[] = [];
  let allPassed = true;
  let totalCost = 0;

  for (const hook of hooks) {
    // Evaluate conditions
    if (!evaluateConditions(hook, ctx)) {
      uiInfo(`Hook "${hook.prompt}" skipped (conditions not met)`);
      continue;
    }

    uiInfo(`Running hook: ${hook.prompt} [${hook.blocking ? "blocking" : "advisory"}]`);

    try {
      const result = await runSingleHook(hook, ctx, logDir);
      results.push(result);
      totalCost += result.costUsd;

      if (!result.success) {
        if (hook.blocking) {
          uiWarn(`Blocking hook "${hook.prompt}" failed: ${result.remediation ?? "no details"}`);
          allPassed = false;
        } else {
          uiWarn(`Advisory hook "${hook.prompt}" reported issues: ${result.remediation ?? "no details"}`);
          // Advisory hooks don't affect allPassed
        }
      } else {
        uiInfo(`Hook "${hook.prompt}" passed`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      uiWarn(`Hook "${hook.prompt}" threw: ${msg}`);
      results.push({
        hookPrompt: hook.prompt,
        success: false,
        output: msg,
        costUsd: 0,
        remediation: msg,
      });
      if (hook.blocking) {
        allPassed = false;
      }
    }
  }

  return { allPassed, results, totalCost };
}
