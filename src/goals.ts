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
