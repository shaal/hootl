import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getProjectDir } from "./config.js";
import { uiInfo } from "./ui.js";
import { dim } from "./format.js";
import type { LogEntry } from "./logger.js";

// ── Dependency injection ────────────────────────────────────────────────────

export interface ReadLogsDeps {
  readFileFn: (path: string, encoding: BufferEncoding) => Promise<string>;
}

const defaultDeps: ReadLogsDeps = {
  readFileFn: readFile as (path: string, encoding: BufferEncoding) => Promise<string>,
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface LogFilters {
  taskId?: string;
  eventType?: string;
}

export interface LogsOptions {
  taskId?: string;
  eventType?: string;
  limit?: number;
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Read and parse `.hootl/logs/events.jsonl` into an array of LogEntry objects.
 *
 * - Skips malformed lines (never crashes on bad JSON)
 * - Returns empty array when the file is missing (ENOENT)
 * - Returns empty array for empty files
 */
export async function readLogEntries(
  logDir: string,
  deps: ReadLogsDeps = defaultDeps,
): Promise<LogEntry[]> {
  let content: string;
  try {
    content = await deps.readFileFn(join(logDir, "events.jsonl"), "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  if (content.trim() === "") return [];

  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // Skip malformed lines — never crash on bad JSON
    }
  }
  return entries;
}

// ── Filter ──────────────────────────────────────────────────────────────────

/**
 * Filter entries by taskId and/or event type. Both filters are optional and
 * stack with AND logic (both must match when both are provided).
 */
export function filterEntries(entries: LogEntry[], filters: LogFilters): LogEntry[] {
  return entries.filter((entry) => {
    if (filters.taskId !== undefined && entry.taskId !== filters.taskId) return false;
    if (filters.eventType !== undefined && entry.type !== filters.eventType) return false;
    return true;
  });
}

// ── Format ──────────────────────────────────────────────────────────────────

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return timestamp.slice(0, 8);
    return d.toTimeString().slice(0, 8); // HH:MM:SS
  } catch {
    return timestamp.slice(0, 8);
  }
}

function summarizeEvent(entry: LogEntry): string {
  switch (entry.type) {
    case "run_start":
      return `budget=$${entry.data.config.budgetPerTask}/task, target=${entry.data.config.confidenceTarget}%`;
    case "phase_start":
      return `${entry.data.phase} attempt #${entry.data.attempt}`;
    case "phase_end": {
      const dur = entry.data.durationMs !== undefined ? ` (${entry.data.durationMs}ms)` : "";
      return `${entry.data.phase} attempt #${entry.data.attempt} — $${entry.data.costUsd}${dur}`;
    }
    case "state_change": {
      const reason = entry.data.reason !== undefined ? ` (${entry.data.reason})` : "";
      return `${entry.data.from} → ${entry.data.to}${reason}`;
    }
    case "decision": {
      const details = entry.data.details !== undefined ? ` (${entry.data.details})` : "";
      return `${entry.data.decision}${details}`;
    }
    case "error":
      return `[${entry.data.phase}] ${entry.data.message}`;
    case "hook_run":
      return `${entry.data.trigger} ${entry.data.passed ? "✓" : "✗"} $${entry.data.costUsd}`;
    case "budget_check":
      return `$${entry.data.todayCost}/$${entry.data.limit} ${entry.data.exceeded ? "EXCEEDED" : "ok"}`;
    case "rollback":
      return `${entry.data.shaBefore.slice(0, 7)}..${entry.data.shaAfter.slice(0, 7)} — ${entry.data.reason}`;
  }
}

/**
 * Format log entries as a human-readable timeline.
 *
 * Each line: `[HH:MM:SS] task-id  EVENT_TYPE  summary`
 */
export function formatTimeline(entries: LogEntry[]): string[] {
  return entries.map((entry) => {
    const time = formatTime(entry.timestamp);
    const taskId = entry.taskId.padEnd(12);
    const type = entry.type.padEnd(14);
    const summary = summarizeEvent(entry);
    return `${dim(`[${time}]`)} ${taskId}  ${type}  ${summary}`;
  });
}

// ── Command orchestrator ────────────────────────────────────────────────────

/**
 * Main entry point for the `hootl logs` CLI command.
 *
 * Resolves the log file path, reads entries, applies filters, slices to the
 * requested limit (default 50), and outputs the formatted timeline.
 */
export async function logsCommand(
  options: LogsOptions,
  deps: ReadLogsDeps = defaultDeps,
): Promise<void> {
  const logDir = join(getProjectDir(), "logs");
  const allEntries = await readLogEntries(logDir, deps);

  const filtered = filterEntries(allEntries, {
    taskId: options.taskId,
    eventType: options.eventType,
  });

  if (filtered.length === 0) {
    uiInfo("No matching events.");
    return;
  }

  const limit = options.limit ?? 50;
  const sliced = filtered.slice(-limit);

  const lines = formatTimeline(sliced);
  for (const line of lines) {
    uiInfo(line);
  }

  if (filtered.length > limit) {
    uiInfo(dim(`\n(showing last ${limit} of ${filtered.length} matching events)`));
  }
}
