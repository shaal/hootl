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

export async function getHeadSha(): Promise<string> {
  const result = await execa("git", ["rev-parse", "HEAD"]);
  return result.stdout.trim();
}

export async function resetToSha(sha: string): Promise<void> {
  await execa("git", ["reset", "--hard", sha]);
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

export async function mergeBranch(taskBranch: string, baseBranch: string): Promise<boolean> {
  try {
    await execa("git", ["checkout", baseBranch]);
    await execa("git", ["merge", taskBranch]);
    return true;
  } catch (err: unknown) {
    uiWarn(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    // Abort any in-progress merge and try to get back to a clean state
    try {
      await execa("git", ["merge", "--abort"]);
    } catch {
      // merge --abort may fail if there's no merge in progress
    }
    try {
      await execa("git", ["checkout", taskBranch]);
    } catch {
      // best effort to get back to task branch
    }
    return false;
  }
}

export async function deleteBranch(branchName: string): Promise<void> {
  try {
    await execa("git", ["branch", "-d", branchName]);
  } catch (err: unknown) {
    uiWarn(`Could not delete branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pushBranch(branchName: string): Promise<boolean> {
  try {
    await execa("git", ["push", "-u", "origin", branchName]);
    return true;
  } catch (err: unknown) {
    uiWarn(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Given a set of branch names, return those that are either merged into baseBranch
 * or no longer exist locally. Runs at most 2 git subprocesses regardless of input size.
 */
export async function getMergedOrGoneBranches(branchNames: string[], baseBranch: string): Promise<{ merged: Set<string>; gone: Set<string> }> {
  const merged = new Set<string>();
  const gone = new Set<string>();
  if (branchNames.length === 0) return { merged, gone };

  // One call to get all local branches
  let localBranches: Set<string>;
  try {
    const listResult = await execa("git", ["branch", "--format", "%(refname:short)"]);
    localBranches = new Set(listResult.stdout.split("\n").map((b) => b.trim()).filter((b) => b.length > 0));
  } catch {
    return { merged, gone };
  }

  // One call to get all branches merged into base
  let mergedBranches: Set<string>;
  try {
    const mergedResult = await execa("git", ["branch", "--merged", baseBranch, "--format", "%(refname:short)"]);
    mergedBranches = new Set(mergedResult.stdout.split("\n").map((b) => b.trim()).filter((b) => b.length > 0));
  } catch {
    mergedBranches = new Set();
  }

  for (const name of branchNames) {
    if (!localBranches.has(name)) {
      gone.add(name);
    } else if (mergedBranches.has(name)) {
      merged.add(name);
    }
  }
  return { merged, gone };
}

async function isGhAvailable(): Promise<boolean> {
  try {
    await execa("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function createDraftPR(title: string, body: string): Promise<boolean> {
  if (!(await isGhAvailable())) {
    uiWarn("gh CLI not installed — skipping PR creation. Install from https://cli.github.com/");
    return false;
  }
  try {
    await execa("gh", ["pr", "create", "--draft", "--title", title, "--body", body]);
    uiInfo(`Draft PR created: ${title}`);
    return true;
  } catch (err: unknown) {
    uiWarn(`PR creation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
