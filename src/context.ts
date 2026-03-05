import { existsSync } from "node:fs";
import { execa } from "execa";
import type { TaskBackend } from "./tasks/types.js";

export interface ProjectContext {
  specPath: string | null;
  readmePath: string | null;
  claudeMdPath: string | null;
  structure: string;
  existingTasks: string;
  recentGitLog: string;
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

function checkFilePath(relativePath: string): string | null {
  return existsSync(relativePath) ? relativePath : null;
}

export async function gatherProjectContext(backend: TaskBackend): Promise<ProjectContext> {
  const specPath = checkFilePath("docs/spec.md");
  const readmePath = checkFilePath("README.md");
  const claudeMdPath = checkFilePath("CLAUDE.md");

  const [structure, recentGitLog, tasks] = await Promise.all([
    getSourceStructure(),
    getRecentGitLog(),
    backend.listTasks(),
  ]);

  const existingTasks =
    tasks.length > 0
      ? tasks.map((t) => `- [${t.state}] ${t.id}: ${t.title}`).join("\n")
      : "";

  return { specPath, readmePath, claudeMdPath, structure, existingTasks, recentGitLog };
}

export function formatContextForPrompt(ctx: ProjectContext): string {
  const sections: string[] = [];

  if (ctx.specPath !== null) {
    sections.push("## Project Specification");
    sections.push(`Read the project spec at: ${ctx.specPath}`);
  }

  if (ctx.readmePath !== null) {
    sections.push("## README");
    sections.push(`Read the project README at: ${ctx.readmePath}`);
  }

  if (ctx.claudeMdPath !== null) {
    sections.push("## CLAUDE.md");
    sections.push(`Read the project conventions at: ${ctx.claudeMdPath}`);
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
