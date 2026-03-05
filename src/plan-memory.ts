import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Task } from "./tasks/types.js";

const PATTERNS_FILE = "planning-patterns.md";
const MAX_ENTRIES = 50;
const DEFAULT_RECENT_COUNT = 20;

export interface PlanningMetrics {
  averageAttempts: number;
  completionRate: number;
  totalCompleted: number;
  totalBlocked: number;
  topBlockerReasons: string[];
}

/**
 * Analyze a completed or blocked task and generate a 1-2 line memory entry
 * summarizing what worked or what went wrong. Pure analysis — no Claude call.
 */
export function generateMemoryEntry(task: Task): string {
  const date = new Date().toISOString().slice(0, 10);
  const stateLabel = task.state === "done" ? "done" : "blocked";
  const prefix = `[${date}] ${task.id} (${stateLabel}, ${task.attempts} attempt${task.attempts === 1 ? "" : "s"})`;

  if (task.state === "done") {
    if (task.attempts <= 1) {
      return `${prefix}: Small, focused task with clear scope — completed efficiently.`;
    }
    if (task.attempts <= 3) {
      return `${prefix}: Completed after moderate iteration. Task was well-scoped.`;
    }
    return `${prefix}: Required ${task.attempts} iterations to complete — consider breaking similar tasks into smaller pieces.`;
  }

  // Blocked — analyze blocker reasons
  const blockerText = task.blockers.join(" ").toLowerCase();

  if (blockerText.includes("budget")) {
    if (blockerText.includes("global")) {
      return `${prefix}: Hit global daily budget ceiling. Multiple tasks running same day.`;
    }
    return `${prefix}: Task scope too large for budget constraints — needed more attempts than budget allowed.`;
  }

  if (blockerText.includes("confidence regression") || blockerText.includes("regress")) {
    return `${prefix}: Implementation approach destabilized existing functionality — confidence regressed and changes were rolled back.`;
  }

  if (blockerText.includes("max attempts")) {
    return `${prefix}: Exhausted max attempts without reaching confidence target — task may need clearer acceptance criteria or smaller scope.`;
  }

  if (blockerText.includes("abstract") || blockerText.includes("vague") || blockerText.includes("unclear")) {
    return `${prefix}: Plan was too abstract — needed concrete implementation steps.`;
  }

  // Generic blocked with custom blockers
  if (task.blockers.length > 0) {
    const firstBlocker = task.blockers[0] ?? "unknown reason";
    const truncated = firstBlocker.length > 100 ? firstBlocker.slice(0, 100) + "..." : firstBlocker;
    return `${prefix}: Blocked — ${truncated}`;
  }

  return `${prefix}: Blocked with no documented reason.`;
}

/**
 * Append a memory entry to planning-patterns.md, rotating oldest entries
 * when count exceeds MAX_ENTRIES. Uses atomic write (tmp + rename) for rotation.
 */
export async function appendMemoryEntry(projectDir: string, entry: string): Promise<void> {
  const patternsPath = join(projectDir, PATTERNS_FILE);

  // Ensure directory exists
  await mkdir(dirname(patternsPath), { recursive: true });

  let lines: string[] = [];
  try {
    const content = await readFile(patternsPath, "utf-8");
    lines = content.split("\n").filter((line) => line.trim().length > 0);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // File doesn't exist yet — start fresh
    } else {
      throw err;
    }
  }

  lines.push(entry);

  // Rotate: keep only the newest MAX_ENTRIES
  if (lines.length > MAX_ENTRIES) {
    lines = lines.slice(lines.length - MAX_ENTRIES);
  }

  // Atomic write: tmp file then rename
  const tmpPath = join(tmpdir(), `hootl-patterns-${randomUUID()}.tmp`);
  await writeFile(tmpPath, lines.join("\n") + "\n", "utf-8");
  // Use rename for atomicity (same-filesystem fast path)
  // Fall back to write if cross-filesystem
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, patternsPath);
  } catch {
    await writeFile(patternsPath, lines.join("\n") + "\n", "utf-8");
  }
}

/**
 * Load the last N entries from planning-patterns.md for prompt injection.
 * Returns empty string if the file doesn't exist.
 */
export async function loadRecentPatterns(projectDir: string, count?: number): Promise<string> {
  const patternsPath = join(projectDir, PATTERNS_FILE);
  const limit = count ?? DEFAULT_RECENT_COUNT;

  let content: string;
  try {
    content = await readFile(patternsPath, "utf-8");
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

  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";

  const recent = lines.slice(-limit);
  return recent.join("\n");
}

/**
 * Parse all entries in planning-patterns.md and compute aggregate metrics.
 */
export function computeMetricsFromEntries(entries: string[]): PlanningMetrics {
  let totalCompleted = 0;
  let totalBlocked = 0;
  let totalAttempts = 0;
  const blockerReasons = new Map<string, number>();

  for (const line of entries) {
    // Parse entry format: [date] task-id (done|blocked, N attempt(s)): insight
    const match = /\((\w+), (\d+) attempts?\)/.exec(line);
    if (match === null) continue;

    const state = match[1];
    const attempts = Number(match[2]);

    if (state === "done") {
      totalCompleted++;
      totalAttempts += attempts;
    } else if (state === "blocked") {
      totalBlocked++;
      totalAttempts += attempts;

      // Categorize the blocker reason
      const reason = categorizeBlockerReason(line);
      blockerReasons.set(reason, (blockerReasons.get(reason) ?? 0) + 1);
    }
  }

  const totalTasks = totalCompleted + totalBlocked;
  const averageAttempts = totalTasks > 0 ? totalAttempts / totalTasks : 0;
  const completionRate = totalTasks > 0 ? totalCompleted / totalTasks : 0;

  // Top 3 blocker reasons sorted by frequency
  const topBlockerReasons = [...blockerReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => reason);

  return {
    averageAttempts,
    completionRate,
    totalCompleted,
    totalBlocked,
    topBlockerReasons,
  };
}

function categorizeBlockerReason(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("budget")) return "budget exhausted";
  if (lower.includes("confidence regress") || lower.includes("rolled back") || lower.includes("destabilized")) return "confidence regression";
  if (lower.includes("max attempts")) return "max attempts exhausted";
  if (lower.includes("abstract") || lower.includes("vague") || lower.includes("unclear")) return "plan too abstract";
  if (lower.includes("scope too large") || lower.includes("smaller pieces")) return "scope too large";
  return "other";
}

/**
 * Compute metrics by reading from the patterns file.
 */
export async function computeMetrics(projectDir: string): Promise<PlanningMetrics> {
  const patternsPath = join(projectDir, PATTERNS_FILE);

  let content: string;
  try {
    content = await readFile(patternsPath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        averageAttempts: 0,
        completionRate: 0,
        totalCompleted: 0,
        totalBlocked: 0,
        topBlockerReasons: [],
      };
    }
    throw err;
  }

  const entries = content.split("\n").filter((line) => line.trim().length > 0);
  return computeMetricsFromEntries(entries);
}

/**
 * Format patterns and metrics into a prompt section for injection into planning prompts.
 */
export async function formatPlanningMemoryContext(projectDir: string): Promise<string> {
  const [patterns, metrics] = await Promise.all([
    loadRecentPatterns(projectDir),
    computeMetrics(projectDir),
  ]);

  if (patterns === "" && metrics.totalCompleted === 0 && metrics.totalBlocked === 0) {
    return "";
  }

  const parts: string[] = [];
  parts.push("## Lessons from Previous Tasks\n");

  if (metrics.totalCompleted + metrics.totalBlocked > 0) {
    parts.push(
      `Metrics: ${metrics.totalCompleted} completed, ${metrics.totalBlocked} blocked ` +
      `(${(metrics.completionRate * 100).toFixed(0)}% completion rate), ` +
      `avg ${metrics.averageAttempts.toFixed(1)} attempts per task.`,
    );
    if (metrics.topBlockerReasons.length > 0) {
      parts.push(`Common blocker reasons: ${metrics.topBlockerReasons.join(", ")}.`);
    }
    parts.push("");
  }

  if (patterns !== "") {
    parts.push("Recent patterns:");
    parts.push(patterns);
  }

  return parts.join("\n");
}
