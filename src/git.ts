import { existsSync, realpathSync } from "node:fs";
import { execa } from "execa";
import { uiInfo, uiWarn, errorMsg } from "./ui.js";
import { invokeClaude } from "./invoke.js";
import type { InvokeResult } from "./invoke.js";

/** Dependency injection interface for generateCommitMessage (testability). */
export interface CommitMessageDeps {
  invoke: (options: { prompt: string; systemPrompt?: string; maxTurns?: number; cwd?: string }) => Promise<InvokeResult>;
}

const DEFAULT_MAX_DIFF_LENGTH = 8000;

/**
 * Generate a commit message for task changes using Claude.
 * Falls back to a static message if Claude invocation fails or returns empty.
 * Accepts both full diff and optional stat summary for richer context.
 * Output is constrained to a single line, max 120 characters (before task prefix).
 */
export async function generateCommitMessage(
  taskId: string,
  phase: string,
  diff: string,
  deps?: CommitMessageDeps,
  maxDiffLength?: number,
  stat?: string,
  cwd?: string,
): Promise<string> {
  const fallback = `[${taskId}] ${phase}: automated changes`;
  const limit = maxDiffLength ?? DEFAULT_MAX_DIFF_LENGTH;

  try {
    const truncatedDiff = diff.length > limit ? diff.slice(0, limit) : diff;
    const invoke = deps?.invoke ?? invokeClaude;

    const statSection = stat ? `File summary:\n${stat}\n\n` : "";
    const result = await invoke({
      prompt: `Write a concise git commit message (one line, no prefix, no quotes) summarizing these changes:\n\n${statSection}${truncatedDiff}`,
      systemPrompt: "You are a commit message generator. Output ONLY the commit message text, nothing else. No quotes, no explanation. Single line only.",
      maxTurns: 1,
      ...(cwd ? { cwd } : {}),
    });

    const rawMessage = result.output.trim();
    if (!rawMessage) {
      uiWarn(`Commit message generation returned empty (exit=${result.exitCode}, dur=${result.durationMs}ms), using fallback`);
      return fallback;
    }

    // Enforce single-line output and cap at 120 characters
    const firstLine = rawMessage.split("\n")[0] ?? rawMessage;
    const capped = firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;

    return `[${taskId}] ${capped}`;
  } catch (err: unknown) {
    uiWarn(`Commit message generation failed, using fallback: ${errorMsg(err)}`);
    return fallback;
  }
}

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

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const result = await execa("git", ["branch", "--show-current"], cwd ? { cwd } : {});
  return result.stdout.trim();
}

/**
 * Verifies the working tree is on the expected branch. If claude -p drifted
 * to another branch (e.g. `git checkout main`), switches back and logs a warning.
 * Returns true if a correction was needed.
 */
export async function ensureBranch(expected: string, cwd?: string): Promise<boolean> {
  const current = await getCurrentBranch(cwd);
  if (current === expected) return false;
  await execa("git", ["checkout", expected], cwd ? { cwd } : {});
  return true;
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

/**
 * Parses `git status --porcelain` output into a set of file paths.
 * Handles rename format ("R  old -> new" — includes both paths).
 */
export function parseDirtyFiles(porcelainOutput: string): Set<string> {
  const files = new Set<string>();
  for (const line of porcelainOutput.split("\n")) {
    if (line.length < 4) continue; // porcelain format: "XY filename" (2 chars + space + path)
    const rest = line.slice(3);
    // Rename format: "R  old -> new"
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx !== -1) {
      files.add(rest.slice(0, arrowIdx));
      files.add(rest.slice(arrowIdx + 4));
    } else {
      files.add(rest);
    }
  }
  return files;
}

/**
 * Returns the set of dirty (modified, untracked, renamed) file paths in the working tree.
 * Used to snapshot pre-existing changes before execute phase so they can be excluded from staging.
 */
export async function getDirtyFiles(cwd?: string): Promise<Set<string>> {
  const result = await execa("git", ["status", "--porcelain"], cwd ? { cwd } : {});
  return parseDirtyFiles(result.stdout);
}

export async function commitTaskChanges(taskId: string, phase: string, message?: string, deps?: CommitMessageDeps, cwd?: string, excludeFiles?: Set<string>): Promise<boolean> {
  const execOpts = cwd ? { cwd } : {};

  // Check if there are any changes to commit
  const status = await execa("git", ["status", "--porcelain"], execOpts);
  if (status.stdout.trim() === "") {
    return false; // Nothing to commit
  }

  if (excludeFiles !== undefined && excludeFiles.size > 0) {
    // Targeted staging: only stage files that weren't dirty before the execute phase.
    // Reuse the status output we already have instead of spawning another subprocess.
    const currentDirty = parseDirtyFiles(status.stdout);
    const newFiles: string[] = [];
    for (const file of currentDirty) {
      if (!excludeFiles.has(file)) {
        newFiles.push(file);
      }
    }
    if (newFiles.length === 0) {
      return false; // All changes are pre-existing
    }
    await execa("git", ["add", "--", ...newFiles], execOpts);
  } else {
    // Stage all changes (worktree mode or recovery — safe to capture everything)
    await execa("git", ["add", "-A"], execOpts);
  }

  let commitMessage: string;
  if (message) {
    commitMessage = message;
  } else {
    // Read the staged diff (full + stat summary) and generate a meaningful commit message via Claude
    try {
      const [diffResult, statResult] = await Promise.all([
        execa("git", ["diff", "--cached"], execOpts),
        execa("git", ["diff", "--cached", "--stat"], execOpts),
      ]);
      commitMessage = await generateCommitMessage(taskId, phase, diffResult.stdout, deps, undefined, statResult.stdout, cwd);
    } catch (err: unknown) {
      uiWarn(`Could not read staged diff for commit message: ${errorMsg(err)}`);
      commitMessage = `[${taskId}] ${phase}: automated changes`;
    }
  }

  await execa("git", ["commit", "-m", commitMessage], execOpts);
  uiInfo(`Committed: ${commitMessage}`);
  return true;
}

export async function getHeadSha(cwd?: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "HEAD"], cwd ? { cwd } : {});
  return result.stdout.trim();
}

export async function resetToSha(sha: string, cwd?: string): Promise<void> {
  await execa("git", ["reset", "--hard", sha], cwd ? { cwd } : {});
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

export async function mergeBranch(taskBranch: string, baseBranch: string, cwd?: string): Promise<boolean> {
  const execOpts = cwd ? { cwd } : {};
  try {
    await execa("git", ["checkout", baseBranch], execOpts);
    await execa("git", ["merge", taskBranch], execOpts);
    return true;
  } catch (err: unknown) {
    uiWarn(`Merge failed: ${errorMsg(err)}`);
    // Abort any in-progress merge and try to get back to a clean state
    try {
      await execa("git", ["merge", "--abort"], execOpts);
    } catch {
      // merge --abort may fail if there's no merge in progress
    }
    try {
      await execa("git", ["checkout", taskBranch], execOpts);
    } catch {
      // best effort to get back to task branch
    }
    return false;
  }
}

export async function deleteBranch(branchName: string, cwd?: string): Promise<void> {
  try {
    await execa("git", ["branch", "-d", branchName], cwd ? { cwd } : {});
  } catch (err: unknown) {
    uiWarn(`Could not delete branch ${branchName}: ${errorMsg(err)}`);
  }
}

export async function pushBranch(branchName: string, cwd?: string): Promise<boolean> {
  try {
    await execa("git", ["push", "-u", "origin", branchName], cwd ? { cwd } : {});
    return true;
  } catch (err: unknown) {
    uiWarn(`Push failed: ${errorMsg(err)}`);
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

/** Check if the working tree has uncommitted changes (staged or unstaged). */
export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  try {
    const result = await execa("git", ["status", "--porcelain"], cwd ? { cwd } : {});
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function isGhAvailable(): Promise<boolean> {
  try {
    await execa("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git Worktree support
// ---------------------------------------------------------------------------

/**
 * Creates a git worktree at the specified path on a new or existing branch.
 * If the worktree path already exists (resume case), logs and returns.
 * If the branch already exists, attaches the worktree to it.
 * Otherwise, creates a new branch from baseBranch.
 */
export async function createWorktree(baseBranch: string, branchName: string, worktreePath: string): Promise<void> {
  if (existsSync(worktreePath)) {
    uiInfo(`Worktree already exists at ${worktreePath} — reusing`);
    return;
  }

  if (await branchExists(branchName)) {
    uiInfo(`Creating worktree at ${worktreePath} for existing branch ${branchName}`);
    await execa("git", ["worktree", "add", worktreePath, branchName]);
  } else {
    uiInfo(`Creating worktree at ${worktreePath} with new branch ${branchName} from ${baseBranch}`);
    await execa("git", ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
  }
}

/**
 * Removes a git worktree at the specified path. Wrapped in try/catch for safety.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  try {
    await execa("git", ["worktree", "remove", worktreePath, "--force"]);
    uiInfo(`Removed worktree at ${worktreePath}`);
  } catch (err: unknown) {
    uiWarn(`Could not remove worktree at ${worktreePath}: ${errorMsg(err)}`);
  }
}

/**
 * Checks if a path is a valid git worktree by checking the filesystem
 * and verifying it appears in `git worktree list`.
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    const result = await execa("git", ["worktree", "list", "--porcelain"]);
    // Resolve symlinks for comparison (macOS /var → /private/var)
    const resolvedTarget = realpathSync(worktreePath);
    // Porcelain output has "worktree <path>" lines
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const listedPath = line.slice(9).trim();
        // Compare both raw and resolved paths to handle symlinks
        if (listedPath === worktreePath || listedPath === resolvedTarget) {
          return true;
        }
        // Also resolve the listed path in case it's the one with symlinks
        try {
          if (existsSync(listedPath) && realpathSync(listedPath) === resolvedTarget) {
            return true;
          }
        } catch {
          // Ignore resolution failures for individual entries
        }
      }
    }
    return false;
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
    uiWarn(`PR creation failed: ${errorMsg(err)}`);
    return false;
  }
}
