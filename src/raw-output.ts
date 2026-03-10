import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Save the full raw output from a claude -p invocation to the task's logs/ directory.
 * Acts as a 'black box recorder' — preserves exact Claude responses for debugging,
 * separate from processed context files (plan.md, progress.md, etc.) which may be
 * truncated, parsed, or overwritten.
 *
 * File naming: `<phase>-<attempt>.txt` (e.g., `plan-1.txt`, `execute-2.txt`, `preflight-0.txt`)
 * Wraps in try/catch so logging failures never crash the completion loop.
 */
export async function saveRawOutput(
  taskDir: string,
  phase: string,
  attempt: number,
  output: string,
): Promise<void> {
  try {
    const logsDir = join(taskDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, `${phase}-${attempt}.txt`), output, "utf-8");
  } catch {
    // Logging must never crash the loop — same pattern as logEvent
  }
}
