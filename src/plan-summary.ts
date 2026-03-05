import { uiChoose, uiInfo } from "./ui.js";

export interface PlannedTask {
  title: string;
  description: string;
  priority?: string;
  dependsOn?: number[];
}

/**
 * Generates a concise TL;DR summary of a planned task list.
 * Line 1: task count and first few titles.
 * Line 2: priority breakdown.
 */
export function generatePlanSummary(tasks: PlannedTask[]): string {
  if (tasks.length === 0) {
    return "No tasks to create.";
  }

  // Line 1: task titles summary
  const maxTitles = 3;
  const titles = tasks.slice(0, maxTitles).map((t) => t.title);
  let titleSummary: string;
  if (tasks.length <= maxTitles) {
    titleSummary = titles.join(", then ");
  } else {
    titleSummary =
      titles.join(", then ") + `, ...and ${tasks.length - maxTitles} more`;
  }
  const line1 = `Will create ${tasks.length} task(s): ${titleSummary}.`;

  // Line 2: priority breakdown
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const p = task.priority ?? "medium";
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const level of ["critical", "high", "medium", "low"]) {
    const count = counts.get(level);
    if (count !== undefined && count > 0) {
      parts.push(`${count} ${level}`);
    }
  }
  const line2 =
    parts.length > 0
      ? `Priority breakdown: ${parts.join(", ")}.`
      : "Priority breakdown: none specified.";

  return `${line1}\n${line2}`;
}

/**
 * Displays the plan summary and asks the user to Accept, Revise, or Cancel.
 */
export async function confirmPlan(
  summary: string,
): Promise<"accept" | "revise" | "cancel"> {
  uiInfo("\n--- Plan Summary ---");
  uiInfo(summary);
  uiInfo("--------------------\n");

  const choice = await uiChoose("How would you like to proceed?", [
    "Accept",
    "Revise",
    "Cancel",
  ]);

  switch (choice) {
    case "Revise":
      return "revise";
    case "Cancel":
      return "cancel";
    default:
      return "accept";
  }
}
