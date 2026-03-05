import { z } from "zod";

export const TaskState = z.enum(["proposed", "ready", "in_progress", "review", "blocked", "done"]);
export type TaskState = z.infer<typeof TaskState>;

export const TaskPriority = z.enum(["critical", "high", "medium", "low"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: TaskPriority,
  state: TaskState,
  dependencies: z.array(z.string()),
  backend: z.string(),
  backendRef: z.string().nullable(),
  confidence: z.number().min(0).max(100),
  attempts: z.number().min(0),
  totalCost: z.number().min(0),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  userPriority: z.number().nullable().default(null),
  blockers: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export interface CreateTaskInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  dependencies?: string[];
}

export interface TaskFilter {
  state?: TaskState;
  priority?: TaskPriority;
}

export interface TaskBackend {
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
}
