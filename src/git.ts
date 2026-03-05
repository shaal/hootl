import { execa } from "execa";
import { uiInfo, uiWarn } from "./ui.js";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function isGitRepo(): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(): Promise<string> {
  const result = await execa("git", ["branch", "--show-current"]);
  return result.stdout.trim();
}

export async function branchExists(branchName: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--verify", branchName]);
    return true;
  } catch {
    return false;
  }
}

export async function createTaskBranch(taskId: string, taskTitle: string, prefix: string): Promise<string> {
  const slug = slugify(taskTitle);
  const branchName = `${prefix}${taskId}-${slug}`;

  if (await branchExists(branchName)) {
    uiInfo(`Branch ${branchName} already exists — switching to it`);
    await execa("git", ["checkout", branchName]);
  } else {
    uiInfo(`Creating branch: ${branchName}`);
    await execa("git", ["checkout", "-b", branchName]);
  }

  return branchName;
}

export async function commitTaskChanges(taskId: string, phase: string, message?: string): Promise<boolean> {
  // Check if there are any changes to commit
  const status = await execa("git", ["status", "--porcelain"]);
  if (status.stdout.trim() === "") {
    return false; // Nothing to commit
  }

  // Stage all changes
  await execa("git", ["add", "-A"]);

  const commitMessage = message ?? `[${taskId}] ${phase}: automated changes`;
  await execa("git", ["commit", "-m", commitMessage]);
  uiInfo(`Committed: ${commitMessage}`);
  return true;
}

export async function switchBranch(branchName: string): Promise<void> {
  await execa("git", ["checkout", branchName]);
}

export async function getBaseBranch(): Promise<string> {
  // Try common base branch names
  for (const name of ["main", "master"]) {
    if (await branchExists(name)) {
      return name;
    }
  }
  // Fallback: return current branch
  return getCurrentBranch();
}
