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
  verbose?: boolean;
}

export interface InvokeResult {
  output: string;
  costUsd: number;
  exitCode: number;
  durationMs: number;
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
  startMs: number,
): Promise<InvokeResult> {
  const result = await execa("claude", args, {
    reject: false,
    timeout: 300_000,
    env: getClaudeEnv(),
    stdin: "ignore",
  });
  const stdout = result.stdout;
  const exitCode = result.exitCode ?? 1;
  const durationMs = Date.now() - startMs;
  const costUsd = parseCostFromOutput(stdout);
  const output = extractTextOutput(stdout, "json");

  let isError = false;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      isError = (parsed as Record<string, unknown>)["is_error"] === true;
    }
  } catch { /* ignore */ }

  return { output, costUsd, exitCode: isError ? 1 : exitCode, durationMs };
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

  const child = execa("claude", args, {
    reject: false,
    timeout: 300_000,
    env: getClaudeEnv(),
    stdin: "ignore",
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

  return { output, costUsd, exitCode: isError ? 1 : exitCode, durationMs };
}

export async function invokeClaude(
  options: InvokeOptions,
): Promise<InvokeResult> {
  const startMs = Date.now();

  try {
    if (options.verbose) {
      return await invokeClaudeVerbose(options, startMs);
    }
    return await invokeClaudeStandard(buildArgs(options), startMs);
  } catch (error: unknown) {
    const durationMs = Date.now() - startMs;
    const isTimeout = typeof error === "object" && error !== null && "timedOut" in error && (error as Record<string, unknown>)["timedOut"] === true;
    const message = isTimeout
      ? `claude -p timed out after ${Math.round(durationMs / 1000)}s`
      : error instanceof Error ? error.message : String(error);
    return {
      output: message,
      costUsd: 0,
      exitCode: isTimeout ? 124 : 1,
      durationMs,
    };
  }
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
