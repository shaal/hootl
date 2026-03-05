import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads .hootl/logs/cost.csv and sums cost entries for today (UTC).
 *
 * CSV format (written by logCost in invoke.ts):
 *   timestamp,taskId,phase,cost
 *   2026-03-05T14:30:00.000Z,task-1,plan,0.0042
 *
 * Returns 0 if the file doesn't exist or is empty.
 */
export async function getTodaysCost(logDir: string): Promise<number> {
  const filePath = join(logDir, "cost.csv");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return 0;
    }
    throw err;
  }

  if (content.trim().length === 0) {
    return 0;
  }

  // Match today's date prefix in UTC (same timezone logCost uses via toISOString())
  const todayPrefix = new Date().toISOString().slice(0, 10);

  let total = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Each line: timestamp,taskId,phase,cost
    if (!trimmed.startsWith(todayPrefix)) continue;

    const lastComma = trimmed.lastIndexOf(",");
    if (lastComma === -1) continue;

    const costStr = trimmed.slice(lastComma + 1);
    const cost = Number(costStr);
    if (Number.isFinite(cost)) {
      total += cost;
    }
    // Malformed cost values are silently skipped
  }

  return total;
}

/**
 * Returns true if today's accumulated cost meets or exceeds the global limit.
 */
export function isGlobalBudgetExceeded(
  todayCost: number,
  globalLimit: number,
): boolean {
  return todayCost >= globalLimit;
}

/**
 * Convenience wrapper: reads today's cost and checks against the global budget.
 */
export async function checkGlobalBudget(
  logDir: string,
  globalLimit: number,
): Promise<{ exceeded: boolean; todayCost: number }> {
  const todayCost = await getTodaysCost(logDir);
  return { exceeded: isGlobalBudgetExceeded(todayCost, globalLimit), todayCost };
}
