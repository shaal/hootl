import { readdir, readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  TaskSchema,
  type Task,
  type TaskState,
  type TaskPriority,
  type CreateTaskInput,
  type TaskFilter,
  type TaskBackend,
} from "./types.js";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function getNextTaskId(baseDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return "task-001";
  }

  const taskDirs = entries.filter((e) => /^task-\d{3,}$/.test(e));
  if (taskDirs.length === 0) {
    return "task-001";
  }

  const maxNum = taskDirs.reduce((max, dir) => {
    const num = parseInt(dir.replace("task-", ""), 10);
    return num > max ? num : max;
  }, 0);

  const next = maxNum + 1;
  const padded = String(next).padStart(3, "0");
  return `task-${padded}`;
}

export class LocalTaskBackend implements TaskBackend {
  private baseDir: string;
  private onUpdate?: (tasks: Task[]) => Promise<void>;

  constructor(baseDir: string, onUpdate?: (tasks: Task[]) => Promise<void>) {
    this.baseDir = baseDir;
    this.onUpdate = onUpdate;
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const taskDirs = entries.filter((e) => /^task-\d{3,}$/.test(e));
    const tasks: Task[] = [];

    for (const dir of taskDirs) {
      const taskPath = join(this.baseDir, dir, "task.json");
      try {
        const raw = await readFile(taskPath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        const task = TaskSchema.parse(parsed);
        tasks.push(task);
      } catch {
        // Skip invalid or unreadable task files
        continue;
      }
    }

    const filtered = tasks.filter((task) => {
      if (filter?.state !== undefined && task.state !== filter.state) {
        return false;
      }
      if (filter?.priority !== undefined && task.priority !== filter.priority) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      // userPriority non-null first, ascending
      const aHasUp = a.userPriority !== null;
      const bHasUp = b.userPriority !== null;
      if (aHasUp && !bHasUp) return -1;
      if (!aHasUp && bHasUp) return 1;
      if (aHasUp && bHasUp) {
        const upDiff = (a.userPriority as number) - (b.userPriority as number);
        if (upDiff !== 0) return upDiff;
      }
      // Then by priority (critical→low), then createdAt
      const priDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priDiff !== 0) return priDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return filtered;
  }

  async getTask(id: string): Promise<Task> {
    const taskPath = join(this.baseDir, id, "task.json");
    let raw: string;
    try {
      raw = await readFile(taskPath, "utf-8");
    } catch {
      throw new Error(`Task not found: ${id}`);
    }
    const parsed = JSON.parse(raw) as unknown;
    return TaskSchema.parse(parsed);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await mkdir(this.baseDir, { recursive: true });

    const id = await getNextTaskId(this.baseDir);
    const taskDir = join(this.baseDir, id);
    await mkdir(taskDir, { recursive: true });

    const now = new Date().toISOString();

    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
      type: input.type ?? "feature",
      state: "ready",
      dependencies: input.dependencies ?? [],
      backend: "local",
      backendRef: null,
      confidence: 0,
      attempts: 0,
      totalCost: 0,
      branch: null,
      worktree: null,
      userPriority: null,
      blockers: [],
      createdAt: now,
      updatedAt: now,
    };

    const validated = TaskSchema.parse(task);
    await atomicWriteJson(join(taskDir, "task.json"), validated);

    await writeFile(join(taskDir, "plan.md"), "", "utf-8");
    await writeFile(join(taskDir, "progress.md"), "", "utf-8");
    await writeFile(join(taskDir, "test_results.md"), "", "utf-8");
    await writeFile(join(taskDir, "blockers.md"), "", "utf-8");

    return validated;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const existing = await this.getTask(id);

    const merged = {
      ...existing,
      ...updates,
      id: existing.id, // prevent ID override
      updatedAt: new Date().toISOString(),
    };

    const validated = TaskSchema.parse(merged);
    const taskPath = join(this.baseDir, id, "task.json");
    await atomicWriteJson(taskPath, validated);

    if (this.onUpdate && existing.state !== validated.state) {
      const allTasks = await this.listTasks();
      await this.onUpdate(allTasks).catch(() => {}); // Don't fail on status write errors
    }

    return validated;
  }

  async deleteTask(id: string): Promise<void> {
    const taskDir = join(this.baseDir, id);
    try {
      await rm(taskDir, { recursive: true, force: true });
    } catch {
      throw new Error(`Failed to delete task: ${id}`);
    }
  }
}

async function atomicWriteJson(filePath: string, data: Task): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}
