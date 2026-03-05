import { execa } from "execa";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface InvokeOptions {
  prompt: string;
  systemPrompt?: string;
  maxTurns?: number;
  outputFormat?: "text" | "json";
  permissionMode?: string;
  allowedTools?: string[];
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

export async function invokeClaude(
  options: InvokeOptions,
): Promise<InvokeResult> {
  const args = buildArgs(options);
  const startMs = Date.now();

  let stdout = "";
  let exitCode = 0;

  try {
    // Unset CLAUDECODE to allow running claude -p from within Claude Code sessions
    const env = { ...process.env };
    delete env["CLAUDECODE"];

    const result = await execa("claude", args, {
      reject: false,
      timeout: 300_000, // 5 minute timeout per call
      env,
      stdin: "ignore",
    });
    stdout = result.stdout;
    exitCode = result.exitCode ?? 1;
  } catch (error: unknown) {
    const durationMs = Date.now() - startMs;
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      output: message,
      costUsd: 0,
      exitCode: 1,
      durationMs,
    };
  }

  const durationMs = Date.now() - startMs;
  const costUsd = parseCostFromOutput(stdout);
  const output = extractTextOutput(stdout, "json");

  return {
    output,
    costUsd,
    exitCode,
    durationMs,
  };
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
