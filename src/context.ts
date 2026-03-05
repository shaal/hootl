import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { TaskBackend } from "./tasks/types.js";

export interface ProjectContext {
  spec: string | null;
  readme: string | null;
  claudeMd: string | null;
  structure: string;
  existingTasks: string;
  recentGitLog: string;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function getSourceStructure(): Promise<string> {
  try {
    const result = await execa("find", ["src", "-type", "f", "-name", "*.ts"], {
      cwd: process.cwd(),
      stdin: "ignore",
    });
    const files = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
    return files.join("\n");
  } catch {
    return "";
  }
}

async function getRecentGitLog(): Promise<string> {
  try {
    const result = await execa("git", ["log", "--oneline", "-20"], {
      cwd: process.cwd(),
      stdin: "ignore",
    });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function gatherProjectContext(backend: TaskBackend): Promise<ProjectContext> {
  const cwd = process.cwd();

  const [spec, readme, claudeMd, structure, recentGitLog, tasks] = await Promise.all([
    readOptionalFile(join(cwd, "docs", "spec.md")),
    readOptionalFile(join(cwd, "README.md")),
    readOptionalFile(join(cwd, "CLAUDE.md")),
    getSourceStructure(),
    getRecentGitLog(),
    backend.listTasks(),
  ]);

  const existingTasks =
    tasks.length > 0
      ? tasks.map((t) => `- [${t.state}] ${t.id}: ${t.title}`).join("\n")
      : "";

  return { spec, readme, claudeMd, structure, existingTasks, recentGitLog };
}

export function formatContextForPrompt(ctx: ProjectContext): string {
  const sections: string[] = [];

  if (ctx.spec !== null) {
    sections.push("## Project Specification");
    sections.push(ctx.spec);
  }

  if (ctx.readme !== null) {
    sections.push("## README");
    sections.push(ctx.readme);
  }

  if (ctx.claudeMd !== null) {
    sections.push("## CLAUDE.md");
    sections.push(ctx.claudeMd);
  }

  if (ctx.structure.length > 0) {
    sections.push("## Project Structure");
    sections.push(ctx.structure);
  }

  if (ctx.existingTasks.length > 0) {
    sections.push("## Existing Tasks");
    sections.push(ctx.existingTasks);
  }

  if (ctx.recentGitLog.length > 0) {
    sections.push("## Recent Git History");
    sections.push(ctx.recentGitLog);
  }

  return sections.join("\n\n");
}
