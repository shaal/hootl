import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Event type discriminated union ──────────────────────────────────────────

export type LogEvent =
  | { taskId: string; type: "phase_start"; data: { phase: string; attempt: number } }
  | { taskId: string; type: "phase_end"; data: { phase: string; attempt: number; costUsd: number } }
  | { taskId: string; type: "state_change"; data: { from: string; to: string; reason?: string } }
  | { taskId: string; type: "decision"; data: { decision: string; details?: string } }
  | { taskId: string; type: "error"; data: { phase: string; message: string } }
  | { taskId: string; type: "hook_run"; data: { trigger: string; skill?: string; passed: boolean; costUsd: number } }
  | { taskId: string; type: "budget_check"; data: { todayCost: number; limit: number; exceeded: boolean } };

/**
 * The serialized envelope written as a single JSONL line.
 */
export type LogEntry = { timestamp: string; sessionId: string } & LogEvent;

// ── Dependency injection (same pattern as notify.ts) ────────────────────────

export interface LoggerDeps {
  appendFn: (path: string, data: string) => Promise<void>;
  mkdirFn: (path: string, opts: { recursive: boolean }) => Promise<unknown>;
  now: () => string;
}

const defaultDeps: LoggerDeps = {
  appendFn: appendFile,
  mkdirFn: mkdir,
  now: () => new Date().toISOString(),
};

// ── Session ID (one per process, overridable for tests) ─────────────────────

let sessionId: string = randomUUID();

export function getSessionId(): string {
  return sessionId;
}

/** Test-only: override the session ID for deterministic assertions. */
export function _setSessionId(id: string): void {
  sessionId = id;
}

// ── Write path ──────────────────────────────────────────────────────────────

/**
 * Append a structured event to `.hootl/logs/events.jsonl`.
 *
 * - Creates the log directory if it doesn't exist
 * - Never throws — logging must never crash the completion loop
 */
export async function logEvent(
  logDir: string,
  event: LogEvent,
  deps: LoggerDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.mkdirFn(logDir, { recursive: true });
    const entry: LogEntry = {
      timestamp: deps.now(),
      sessionId: getSessionId(),
      ...event,
    };
    await deps.appendFn(join(logDir, "events.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // Logging failures must never crash the loop
  }
}
