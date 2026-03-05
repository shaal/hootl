import { invokeClaude } from "./invoke.js";

export interface PlannedTask {
  title: string;
  description: string;
  priority?: string;
  dependsOn?: number[];
}

const CRITIQUE_SYSTEM_PROMPT =
  `You are a plan reviewer for an AI task planner. Your job is to catch drift between what the user asked for and what the planner produced.\n\n` +
  `Review the proposed task list against the original goal using these checks:\n` +
  `1. Does every task clearly map to something the user asked for? Remove tasks that don't serve the goal.\n` +
  `2. Is the plan over-engineered? Are there tasks that build abstractions before delivering the concrete ask? Task 1 should deliver the specific thing requested, even if hardcoded.\n` +
  `3. Did the planner miss any specific tools, skills, concepts, or features the user mentioned? Add tasks for anything missed.\n` +
  `4. Are there tasks that should be merged (too granular) or split (too large)?\n\n` +
  `If the plan is good, return it unchanged. Do not add unnecessary tasks.\n\n` +
  `Return ONLY a JSON array of objects with "title", "description", "priority", and optionally "dependsOn" fields.\n` +
  `Priority must be one of: "critical", "high", "medium", "low".\n` +
  `"dependsOn" is an array of 0-based indices referencing other tasks in the revised list.`;

export function buildCritiquePrompt(
  goalDescription: string,
  tasks: PlannedTask[],
): string {
  const taskListJson = JSON.stringify(
    tasks.map((t, i) => ({
      index: i,
      title: t.title,
      description: t.description,
      priority: t.priority ?? "medium",
      ...(t.dependsOn !== undefined && t.dependsOn.length > 0
        ? { dependsOn: t.dependsOn }
        : {}),
    })),
    null,
    2,
  );

  return (
    `## Original Goal\n${goalDescription}\n\n` +
    `## Proposed Task List\n${taskListJson}\n\n` +
    `Review this task list against the original goal. Return the revised (or unchanged) task list as a JSON array.`
  );
}

export function parseCritiqueTasks(output: string): PlannedTask[] | null {
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (jsonMatch === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const tasks: PlannedTask[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["title"] === "string" &&
      typeof (item as Record<string, unknown>)["description"] === "string"
    ) {
      const record = item as Record<string, unknown>;
      const task: PlannedTask = {
        title: record["title"] as string,
        description: record["description"] as string,
      };
      if (typeof record["priority"] === "string") {
        task.priority = record["priority"] as string;
      }
      if (Array.isArray(record["dependsOn"])) {
        task.dependsOn = (record["dependsOn"] as unknown[]).filter(
          (v): v is number => typeof v === "number" && Number.isInteger(v),
        );
      }
      tasks.push(task);
    }
  }

  return tasks.length > 0 ? tasks : null;
}

export async function critiquePlan(
  goalDescription: string,
  tasks: PlannedTask[],
  verbose: boolean,
): Promise<PlannedTask[]> {
  if (tasks.length === 0) {
    return tasks;
  }

  const prompt = buildCritiquePrompt(goalDescription, tasks);

  let result;
  try {
    result = await invokeClaude({
      prompt,
      systemPrompt: CRITIQUE_SYSTEM_PROMPT,
      verbose,
    });
  } catch {
    return tasks;
  }

  if (result.exitCode !== 0) {
    return tasks;
  }

  const revised = parseCritiqueTasks(result.output);
  return revised ?? tasks;
}
