import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BudgetSchema = z.object({
  perTask: z.number().default(5.00),
  global: z.number().default(50.00),
  maxAttemptsPerTask: z.number().default(10),
  contextWindowLimit: z.number().default(60),
}).passthrough();

const ConfidenceSchema = z.object({
  target: z.number().default(95),
  requireTests: z.boolean().default(true),
});

const OnConfidenceSchema = z.enum(["merge", "pr", "none"]);
export type OnConfidenceMode = z.infer<typeof OnConfidenceSchema>;

const GitSchema = z.object({
  useWorktrees: z.boolean().default(false),
  autoPR: z.boolean().default(true),
  branchPrefix: z.string().default("hootl/"),
  onConfidence: OnConfidenceSchema.nullable().default(null),
});

const AutoSchema = z.object({
  defaultLevel: z.enum(["conservative", "moderate", "proactive", "full"]).default("proactive"),
  maxParallel: z.number().default(1),
});

const NotificationsSchema = z.object({
  terminal: z.boolean().default(true),
  osNotify: z.boolean().default(false),
  summaryFile: z.boolean().default(true),
  webhook: z.string().nullable().default(null),
});

export const HOOK_TRIGGERS = [
  "on_confidence_met",
  "on_review_complete",
  "on_blocked",
  "on_execute_start",
] as const;

const HookTriggerSchema = z.enum(HOOK_TRIGGERS);
export type HookTrigger = z.infer<typeof HookTriggerSchema>;

const HookConditionSchema = z.object({
  minConfidence: z.number().optional(),
});

export const HookSchema = z.object({
  trigger: HookTriggerSchema,
  prompt: z.string().optional(),
  skill: z.string().optional(),
  blocking: z.boolean().default(false),
  conditions: HookConditionSchema.optional(),
}).refine(
  (h) => h.prompt !== undefined || h.skill !== undefined,
  { message: "Hook must have at least one of 'prompt' or 'skill'" },
);
export type Hook = z.infer<typeof HookSchema>;

const HooksSchema = z.array(HookSchema).default([]);

export const ConfigSchema = z.object({
  taskBackend: z.enum(["local", "github", "beads"]).default("local"),
  budgets: BudgetSchema.default({}),
  confidence: ConfidenceSchema.default({}),
  git: GitSchema.default({}),
  auto: AutoSchema.default({}),
  notifications: NotificationsSchema.default({}),
  hooks: HooksSchema,
  permissionMode: z.string().default("default"),
});
export type Config = z.infer<typeof ConfigSchema>;

export async function loadJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

const ENV_MAP: Record<string, string[]> = {
  HOOTL_TASK_BACKEND: ["taskBackend"],
  HOOTL_BUDGET_CONTEXT_WINDOW_LIMIT: ["budgets", "contextWindowLimit"],
  HOOTL_BUDGET_PER_TASK: ["budgets", "perTask"],
  HOOTL_BUDGET_GLOBAL: ["budgets", "global"],
  HOOTL_BUDGET_MAX_ATTEMPTS: ["budgets", "maxAttemptsPerTask"],
  HOOTL_CONFIDENCE_TARGET: ["confidence", "target"],
  HOOTL_CONFIDENCE_REQUIRE_TESTS: ["confidence", "requireTests"],
  HOOTL_GIT_USE_WORKTREES: ["git", "useWorktrees"],
  HOOTL_GIT_AUTO_PR: ["git", "autoPR"],
  HOOTL_GIT_BRANCH_PREFIX: ["git", "branchPrefix"],
  HOOTL_GIT_ON_CONFIDENCE: ["git", "onConfidence"],
  HOOTL_AUTO_LEVEL: ["auto", "defaultLevel"],
  HOOTL_AUTO_MAX_PARALLEL: ["auto", "maxParallel"],
  HOOTL_NOTIFICATIONS_TERMINAL: ["notifications", "terminal"],
  HOOTL_NOTIFICATIONS_OS_NOTIFY: ["notifications", "osNotify"],
  HOOTL_NOTIFICATIONS_SUMMARY_FILE: ["notifications", "summaryFile"],
  HOOTL_NOTIFICATIONS_WEBHOOK: ["notifications", "webhook"],
  HOOTL_PERMISSION_MODE: ["permissionMode"],
};

export function coerceEnvValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return value;
}

export function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(config);

  for (const [envVar, path] of Object.entries(ENV_MAP)) {
    const rawValue = process.env[envVar];
    if (rawValue === undefined) continue;

    const value = coerceEnvValue(rawValue);

    const first = path[0];
    if (first === undefined) continue;

    if (path.length === 1) {
      result[first] = value;
    } else if (path.length === 2) {
      const second = path[1];
      if (second === undefined) continue;
      if (typeof result[first] !== "object" || result[first] === null) {
        result[first] = {};
      }
      (result[first] as Record<string, unknown>)[second] = value;
    }
  }

  return result;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overVal === "object" &&
      overVal !== null &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

export async function loadConfig(projectDir?: string): Promise<Config> {
  const resolvedProjectDir = projectDir ?? process.cwd();

  const globalPath = join(homedir(), ".hootl", "config.json");
  const projectPath = join(resolvedProjectDir, ".hootl", "config.json");

  const globalConfig = await loadJsonFile(globalPath);
  const projectConfig = await loadJsonFile(projectPath);

  const merged = deepMerge(globalConfig, projectConfig);
  const withEnv = applyEnvOverrides(merged);

  return ConfigSchema.parse(withEnv);
}

export function getProjectDir(): string {
  return join(process.cwd(), ".hootl");
}

const AUTO_LEVEL_TO_ON_CONFIDENCE: Record<string, OnConfidenceMode> = {
  conservative: "none",
  moderate: "pr",
  proactive: "merge",
  full: "merge",
};

/**
 * Reads the raw project config JSON, applies a mutation via the updater callback,
 * and writes it back to `.hootl/config.json`. Operates on raw JSON to avoid
 * clobbering global config defaults or Zod-injected defaults.
 */
export async function saveProjectConfig(
  updater: (raw: Record<string, unknown>) => void,
  projectDir?: string,
): Promise<void> {
  const resolvedProjectDir = projectDir ?? process.cwd();
  const projectPath = join(resolvedProjectDir, ".hootl", "config.json");
  const raw = await loadJsonFile(projectPath);
  updater(raw);
  await writeFile(projectPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

export function resolveOnConfidenceMode(
  config: Config,
  cliMerge?: boolean,
  cliNoMerge?: boolean,
): OnConfidenceMode {
  // CLI flags take highest priority
  if (cliMerge === true) return "merge";
  if (cliNoMerge === true) return "none";

  // Explicit config overrides auto-level inference
  if (config.git.onConfidence !== null) return config.git.onConfidence;

  // Infer from auto.defaultLevel
  return AUTO_LEVEL_TO_ON_CONFIDENCE[config.auto.defaultLevel] ?? "none";
}

/**
 * Sets a value at a dotted path within an object, creating intermediate objects as needed.
 * e.g. setNestedValue({}, "budgets.perTask", 10) → { budgets: { perTask: 10 } }
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
): void {
  const parts = dottedPath.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const newObj: Record<string, unknown> = {};
      current[key] = newObj;
      current = newObj;
    } else {
      current = next as Record<string, unknown>;
    }
  }

  const leafKey = parts[parts.length - 1];
  if (leafKey !== undefined) {
    current[leafKey] = value;
  }
}

/**
 * Reads the raw global config JSON, applies a mutation via the updater callback,
 * and writes it back to `~/.hootl/config.json`.
 */
export async function saveGlobalConfig(
  updater: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const globalDir = join(homedir(), ".hootl");
  const globalPath = join(globalDir, "config.json");
  const raw = await loadJsonFile(globalPath);
  updater(raw);
  // Ensure directory exists
  const { mkdir } = await import("node:fs/promises");
  await mkdir(globalDir, { recursive: true });
  await writeFile(globalPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}
