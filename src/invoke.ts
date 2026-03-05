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

function buildArgs(options: InvokeOptions): string[] {
  const args: string[] = ["-p", options.prompt, "--no-session-persistence"];

  const format = options.outputFormat ?? "text";
  args.push("--output-format", format);

  const permissionMode = options.permissionMode ?? "default";
  args.push("--permission-mode", permissionMode);

  if (options.systemPrompt !== undefined) {
    args.push("-s", options.systemPrompt);
  }

  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  return args;
}

function parseCostFromOutput(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "cost_usd" in parsed
    ) {
      const record = parsed as Record<string, unknown>;
      const cost = Number(record["cost_usd"]);
      return Number.isFinite(cost) ? cost : 0;
    }
  } catch {
    // Not valid JSON or missing cost_usd — fall through
  }
  return 0;
}

function extractTextOutput(raw: string, format: "text" | "json"): string {
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
  const format = options.outputFormat ?? "text";
  const startMs = Date.now();

  let stdout = "";
  let exitCode = 0;

  try {
    const result = await execa("claude", args, {
      reject: false,
      timeout: 0,
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
  const output = extractTextOutput(stdout, format);

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
