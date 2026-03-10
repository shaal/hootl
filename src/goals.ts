import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
});

export type Goal = z.infer<typeof GoalSchema>;

const GoalsArraySchema = z.array(GoalSchema);

/**
 * Load goals from `.hootl/goals.json`.
 * Returns an empty array if the file is missing or contains invalid data.
 */
export async function loadGoals(hootlDir: string): Promise<Goal[]> {
  try {
    const raw = await readFile(join(hootlDir, "goals.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return GoalsArraySchema.parse(parsed);
  } catch {
    return [];
  }
}

/**
 * Atomically write goals to `.hootl/goals.json`.
 * Creates the directory if it doesn't exist.
 */
export async function saveGoals(hootlDir: string, goals: Goal[]): Promise<void> {
  await mkdir(hootlDir, { recursive: true });
  const filePath = join(hootlDir, "goals.json");
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(goals, null, 2) + "\n";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Convert a goal title to a URL-safe slug ID.
 * Lowercases, replaces non-alphanumeric characters with hyphens,
 * collapses consecutive hyphens, and trims leading/trailing hyphens.
 * Returns "ungrouped" for empty/whitespace-only input.
 */
export function slugifyGoalId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return slug === "" ? "ungrouped" : slug;
}

/**
 * Create goals from task group labels and assign tasks to their corresponding goals.
 * Loads existing goals to avoid duplicates, creates new ones for unknown groups,
 * and updates each task's `goal` field via the backend.
 *
 * @param tasks - Parsed plan tasks (with optional `group` field)
 * @param indexToId - Map from task index to created task ID
 * @param backend - Task backend for updating task goal assignments
 * @param hootlDir - Path to the .hootl directory (for goals.json)
 * @returns The number of new goals created
 */
export async function createGoalsFromGroups(
  tasks: ReadonlyArray<Record<string, unknown> & { group?: string }>,
  indexToId: ReadonlyMap<number, string>,
  backend: { updateTask: (id: string, updates: { goal: string }) => Promise<unknown> },
  hootlDir: string,
): Promise<{ created: string[]; assigned: number }> {
  // Collect unique group labels from tasks that have one
  const groupLabels = new Map<string, string>(); // slug -> original title
  for (const task of tasks) {
    if (typeof task.group === "string" && task.group.trim() !== "") {
      const slug = slugifyGoalId(task.group);
      if (!groupLabels.has(slug)) {
        groupLabels.set(slug, task.group.trim());
      }
    }
  }

  if (groupLabels.size === 0) {
    return { created: [], assigned: 0 };
  }

  // Load existing goals to avoid duplicates
  const existingGoals = await loadGoals(hootlDir);
  const existingIds = new Set(existingGoals.map((g) => g.id));

  const newGoals: Goal[] = [];
  for (const [slug, title] of groupLabels) {
    if (!existingIds.has(slug)) {
      newGoals.push({ id: slug, title, description: "" });
    }
  }

  // Save merged goals (existing + new)
  if (newGoals.length > 0) {
    await saveGoals(hootlDir, [...existingGoals, ...newGoals]);
  }

  // Assign each task to its goal
  let assigned = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task !== undefined && typeof task.group === "string" && task.group.trim() !== "") {
      const slug = slugifyGoalId(task.group);
      const taskId = indexToId.get(i);
      if (taskId !== undefined) {
        await backend.updateTask(taskId, { goal: slug });
        assigned++;
      }
    }
  }

  return { created: newGoals.map((g) => g.id), assigned };
}
