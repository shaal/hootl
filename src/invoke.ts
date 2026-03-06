import { execa } from "execa";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StreamFormatter, dim } from "./format.js";

export interface InvokeOptions {
  prompt: string;
  systemPrompt?: string;
  maxTurns?: number;
  outputFormat?: "text" | "json";
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  verbose?: boolean;
  cwd?: string;
}

export interface InvokeResult {
  output: string;
  costUsd: number;
  exitCode: number;
  durationMs: number;
  contextWindowPercent: number;
}

export function buildArgs(options: InvokeOptions): string[] {
  const args: string[] = ["-p", options.prompt, "--no-session-persistence"];

  // Always use JSON output format to capture cost data
  // The actual text output is extracted from the "result" field
  args.push("--output-format", "json");

  // In -p mode, we must skip permissions to avoid hanging on interactive prompts
  args.push("--dangerously-skip-permissions");

  if (options.systemPrompt !== undefined) {
    args.push("--system-prompt", options.systemPrompt);
  }

  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }

  return args;
}

export function parseCostFromOutput(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      // claude -p outputs total_cost_usd in --output-format json
      const cost = Number(record["total_cost_usd"] ?? record["cost_usd"] ?? 0);
      return Number.isFinite(cost) ? cost : 0;
    }
  } catch {
    // Not valid JSON or missing cost fields — fall through
  }
  return 0;
}

export function parseContextWindowPercent(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const pct = Number(record["context_window_percent"] ?? 0);
      return Number.isFinite(pct) ? pct : 0;
    }
  } catch {
    // Not valid JSON — fall through
  }
  return 0;
}

export function extractTextOutput(raw: string, format: "text" | "json"): string {
  if (format !== "json") {
    return raw;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed
    ) {
      const record = parsed as Record<string, unknown>;
      return typeof record["result"] === "string"
        ? record["result"]
        : raw;
    }
  } catch {
    // Return raw output if parsing fails
  }
  return raw;
}

export function getClaudeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  // Remove all env vars that Claude Code uses to detect nested sessions
  delete env["CLAUDECODE"];
  delete env["CLAUDE_CODE_ENTRYPOINT"];
  delete env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];
  return env;
}

async function invokeClaudeStandard(
  args: string[],
  cwd: string | undefined,
  startMs: number,
): Promise<InvokeResult> {
  const result = await execa("claude", args, {
    reject: false,
    timeout: 300_000,
    env: getClaudeEnv(),
    stdin: "ignore",
    detached: true,
    ...(cwd ? { cwd } : {}),
  });
  const stdout = result.stdout;
  const exitCode = result.exitCode ?? 1;
  const durationMs = Date.now() - startMs;
  const costUsd = parseCostFromOutput(stdout);
  const contextWindowPercent = parseContextWindowPercent(stdout);
  const output = extractTextOutput(stdout, "json");

  let isError = false;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      isError = (parsed as Record<string, unknown>)["is_error"] === true;
    }
  } catch { /* ignore */ }

  return { output, costUsd, exitCode: isError ? 1 : exitCode, durationMs, contextWindowPercent };
}

async function invokeClaudeVerbose(
  options: InvokeOptions,
  startMs: number,
): Promise<InvokeResult> {
  const args: string[] = [
    "-p", options.prompt,
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (options.systemPrompt !== undefined) {
    args.push("--system-prompt", options.systemPrompt);
  }
  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }

  const child = execa("claude", args, {
    reject: false,
    timeout: 300_000,
    env: getClaudeEnv(),
    stdin: "ignore",
    detached: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  let resultLine = "";
  let lastAssistantText = "";
  const formatter = new StreamFormatter();

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      try {
        const event: unknown = JSON.parse(line);
        if (typeof event !== "object" || event === null) continue;
        const record = event as Record<string, unknown>;
        const type = record["type"];

        if (type === "assistant") {
          // Extract text content from assistant messages
          const msg = record["message"] as Record<string, unknown> | undefined;
          if (msg && Array.isArray(msg["content"])) {
            for (const block of msg["content"] as unknown[]) {
              if (typeof block === "object" && block !== null) {
                const b = block as Record<string, unknown>;
                if (b["type"] === "text" && typeof b["text"] === "string") {
                  const newText = b["text"] as string;
                  // Print only the new part (incremental), with markdown formatting
                  if (newText.length > lastAssistantText.length && newText.startsWith(lastAssistantText)) {
                    const formatted = formatter.write(newText.slice(lastAssistantText.length));
                    if (formatted) process.stderr.write(formatted);
                  } else if (newText !== lastAssistantText) {
                    const formatted = formatter.write(newText);
                    if (formatted) process.stderr.write(formatted);
                  }
                  lastAssistantText = newText;
                }
                if (b["type"] === "tool_use") {
                  const flushed = formatter.flush();
                  if (flushed) process.stderr.write(flushed);
                  const toolName = typeof b["name"] === "string" ? b["name"] : "tool";
                  process.stderr.write(`\n  ${dim(`[${toolName}]`)} `);
                  lastAssistantText = "";
                }
              }
            }
          }
        } else if (type === "tool_result") {
          process.stderr.write(dim("done") + "\n");
          lastAssistantText = "";
        } else if (type === "result") {
          resultLine = line;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  const result = await child;
  const exitCode = result.exitCode ?? 1;
  const durationMs = Date.now() - startMs;

  // Flush any remaining buffered text
  const remaining = formatter.flush();
  if (remaining) process.stderr.write(remaining);
  if (lastAssistantText.length > 0) {
    process.stderr.write("\n");
  }

  // Parse the result line (same format as non-verbose JSON output)
  const costUsd = resultLine ? parseCostFromOutput(resultLine) : 0;
  const contextWindowPercent = resultLine ? parseContextWindowPercent(resultLine) : 0;
  const output = resultLine ? extractTextOutput(resultLine, "json") : result.stdout;

  let isError = false;
  if (resultLine) {
    try {
      const parsed: unknown = JSON.parse(resultLine);
      if (typeof parsed === "object" && parsed !== null) {
        isError = (parsed as Record<string, unknown>)["is_error"] === true;
      }
    } catch { /* ignore */ }
  }

  return { output, costUsd, exitCode: isError ? 1 : exitCode, durationMs, contextWindowPercent };
}

/** Maximum number of retries for transient errors (timeouts, rate limits, network errors). */
export const MAX_RETRIES = 3;

/** Initial delay in milliseconds for exponential backoff (doubles each retry: 1s, 2s, 4s). */
export const INITIAL_DELAY_MS = 1000;

/** Default sleep implementation — returns a promise that resolves after `ms` milliseconds. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether an InvokeResult represents a transient error that should be retried.
 * Transient errors include timeouts, rate limits, and network failures.
 */
export function isTransientError(result: InvokeResult): boolean {
  if (result.exitCode === 0) return false;

  const output = result.output.toLowerCase();
  // Timeout: exit code 124 or "timed out" message (set by the catch block)
  if (result.exitCode === 124) return true;
  if (output.includes("timed out")) return true;
  // Rate limits
  if (output.includes("rate limit") || output.includes("429")) return true;
  // Network errors
  if (
    output.includes("econnrefused") ||
    output.includes("enotfound") ||
    output.includes("etimedout") ||
    output.includes("econnreset")
  ) return true;

  return false;
}

export interface InvokeClaudeDeps {
  sleep: (ms: number) => Promise<void>;
}

export async function invokeClaude(
  options: InvokeOptions,
  deps?: InvokeClaudeDeps,
): Promise<InvokeResult> {
  const sleep = deps?.sleep ?? defaultSleep;
  const startMs = Date.now();
  let accumulatedCost = 0;
  let lastResult: InvokeResult | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Backoff delay before retries (not before the first attempt)
    if (attempt > 0) {
      const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }

    try {
      if (options.verbose) {
        lastResult = await invokeClaudeVerbose(options, startMs);
      } else {
        lastResult = await invokeClaudeStandard(buildArgs(options), options.cwd, startMs);
      }
    } catch (error: unknown) {
      const durationMs = Date.now() - startMs;
      const isTimeout = typeof error === "object" && error !== null && "timedOut" in error && (error as Record<string, unknown>)["timedOut"] === true;
      const message = isTimeout
        ? `claude -p timed out after ${Math.round(durationMs / 1000)}s`
        : error instanceof Error ? error.message : String(error);
      lastResult = {
        output: message,
        costUsd: 0,
        exitCode: isTimeout ? 124 : 1,
        durationMs,
        contextWindowPercent: 0,
      };
    }

    accumulatedCost += lastResult.costUsd;

    // If success or non-transient error, return immediately
    if (lastResult.exitCode === 0 || !isTransientError(lastResult)) {
      return { ...lastResult, costUsd: accumulatedCost };
    }

    // Transient error — will retry (unless this was the last attempt)
    if (attempt < MAX_RETRIES) {
      const retryNum = attempt + 1;
      process.stderr.write(
        `Transient error (attempt ${retryNum}/${MAX_RETRIES + 1}), retrying in ${INITIAL_DELAY_MS * Math.pow(2, attempt)}ms: ${lastResult.output.slice(0, 100)}\n`
      );
    }
  }

  // All retries exhausted — return last failure with accumulated cost
  return { ...lastResult!, costUsd: accumulatedCost };
}

export async function logCost(
  logDir: string,
  taskId: string,
  phase: string,
  cost: number,
): Promise<void> {
  await mkdir(logDir, { recursive: true });
  const filePath = join(logDir, "cost.csv");
  const timestamp = new Date().toISOString();
  const line = `${timestamp},${taskId},${phase},${cost}\n`;
  await appendFile(filePath, line);
}
