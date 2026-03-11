import { existsSync, realpathSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { uiInfo, uiWarn, errorMsg } from "./ui.js";
import { invokeClaude } from "./invoke.js";
import type { InvokeOptions, InvokeResult } from "./invoke.js";

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

/** Artifact files that are removed when a stale branch is reset. */
const STALE_ARTIFACTS = [
  "understanding.md",
  "plan.md",
  "progress.md",
  "blockers.md",
  "test_results.md",
  "last_confidence.txt",
  "last_review_sha.txt",
] as const;

export interface StaleBranchOpts {
  taskDir?: string;
  staleBranchThreshold?: number;
  baseBranch?: string;
}

export async function createTaskBranch(
  taskId: string,
  taskTitle: string,
  prefix: string,
  opts?: StaleBranchOpts,
): Promise<string> {
  const slug = slugify(taskTitle);
  const branchName = `${prefix}${taskId}-${slug}`;

  if (await branchExists(branchName)) {
    // Check if the branch is stale (far behind the base branch)
    if (opts?.staleBranchThreshold !== undefined && opts.baseBranch && opts.taskDir) {
      const threshold = opts.staleBranchThreshold;
      try {
        const result = await execa("git", ["rev-list", "--count", `${branchName}..${opts.baseBranch}`]);
        const behindCount = parseInt(result.stdout.trim(), 10);

        if (!Number.isNaN(behindCount) && behindCount > threshold) {
          uiInfo(
            `Branch ${branchName} is ${behindCount} commits behind ${opts.baseBranch} (threshold: ${threshold}) — resetting stale branch`,
          );

          // Switch to base branch first (can't delete the current branch)
          await execa("git", ["checkout", opts.baseBranch]);

          // Force-delete the stale branch (it won't be merged into base)
          await execa("git", ["branch", "-D", branchName]);

          // Remove stale task artifacts
          for (const artifact of STALE_ARTIFACTS) {
            try {
              await unlink(join(opts.taskDir, artifact));
            } catch {
              // File may not exist — that's fine
            }
          }

          // Create a fresh branch from the current base
          uiInfo(`Creating fresh branch: ${branchName}`);
          await execa("git", ["checkout", "-b", branchName]);
          return branchName;
        }
      } catch (err: unknown) {
        // If staleness check fails, fall through to normal checkout
        uiWarn(`Stale branch check failed: ${errorMsg(err)} — proceeding with existing branch`);
      }
    }

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

// ---------------------------------------------------------------------------
// Staged merge flow — attemptMerge / abortMerge / completeMerge
// ---------------------------------------------------------------------------

export type MergeAttemptResult =
  | { status: "success" }
  | { status: "conflict"; conflictedFiles: string[] }
  | { status: "error"; message: string };

/**
 * Attempts to merge taskBranch into baseBranch. Returns a rich result so the
 * caller can inspect conflicted files before deciding whether to abort or resolve.
 * On success the working tree is on baseBranch with the merge committed.
 * On conflict the merge is left in progress so conflict markers can be read.
 */
export async function attemptMerge(taskBranch: string, baseBranch: string, cwd?: string): Promise<MergeAttemptResult> {
  const execOpts = cwd ? { cwd } : {};
  try {
    await execa("git", ["checkout", baseBranch], execOpts);
  } catch (err: unknown) {
    return { status: "error", message: `checkout failed: ${errorMsg(err)}` };
  }
  try {
    await execa("git", ["merge", taskBranch], execOpts);
    return { status: "success" };
  } catch (mergeErr: unknown) {
    // Check for conflicted files via the unmerged filter
    try {
      const diffResult = await execa("git", ["diff", "--name-only", "--diff-filter=U"], execOpts);
      const files = diffResult.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      if (files.length > 0) {
        return { status: "conflict", conflictedFiles: files };
      }
    } catch {
      // diff command failed — treat as generic error
    }
    return { status: "error", message: `merge failed: ${errorMsg(mergeErr)}` };
  }
}

/**
 * Aborts an in-progress merge and switches back to taskBranch. Best-effort — never throws.
 */
export async function abortMerge(taskBranch: string, cwd?: string): Promise<void> {
  const execOpts = cwd ? { cwd } : {};
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
}

/**
 * Stages resolved files and completes a merge commit. Returns true on success.
 */
export async function completeMerge(files: string[], message: string, cwd?: string): Promise<boolean> {
  const execOpts = cwd ? { cwd } : {};
  try {
    await execa("git", ["add", "--", ...files], execOpts);
    await execa("git", ["commit", "-m", message], execOpts);
    return true;
  } catch (err: unknown) {
    uiWarn(`completeMerge failed: ${errorMsg(err)}`);
    return false;
  }
}

/**
 * Convenience wrapper preserving the original boolean return API.
 * Existing callers (and tests) continue to work unchanged.
 */
export async function mergeBranch(taskBranch: string, baseBranch: string, cwd?: string): Promise<boolean> {
  const result = await attemptMerge(taskBranch, baseBranch, cwd);
  if (result.status === "success") return true;
  uiWarn(`Merge failed: ${result.status === "error" ? result.message : `conflict in ${result.conflictedFiles.join(", ")}`}`);
  await abortMerge(taskBranch, cwd);
  return false;
}

// ---------------------------------------------------------------------------
// Claude-assisted merge conflict resolution
// ---------------------------------------------------------------------------

/** Known binary file extensions — skip Claude resolution for these. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".class", ".jar", ".pyc", ".wasm",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Checks whether a file contains null bytes (likely binary).
 * Returns true if the file is binary, false if text.
 */
async function isBinaryContent(filePath: string): Promise<boolean> {
  try {
    const content = await fsReadFile(filePath);
    // Check first 8KB for null bytes
    const checkLength = Math.min(content.length, 8192);
    for (let i = 0; i < checkLength; i++) {
      if (content[i] === 0) return true;
    }
    return false;
  } catch {
    return true; // If we can't read it, treat as binary (skip resolution)
  }
}

/** Dependency injection interface for resolveConflicts (testability). */
export interface MergeResolveDeps {
  invoke: (options: InvokeOptions) => Promise<InvokeResult>;
}

/**
 * Attempts to resolve merge conflicts using Claude. For each conflicted text file,
 * reads the conflict markers, invokes Claude to produce resolved content, writes it
 * back, and completes the merge.
 *
 * Returns { success, costUsd, resolvedFiles }. On any failure the caller should
 * run abortMerge().
 */
export async function resolveConflicts(
  conflictedFiles: string[],
  taskBranch: string,
  baseBranch: string,
  taskTitle: string,
  taskDescription: string,
  deps?: MergeResolveDeps,
  cwd?: string,
): Promise<{ success: boolean; costUsd: number; resolvedFiles: string[] }> {
  let costUsd = 0;
  const resolvedFiles: string[] = [];

  // Load the conflict resolution system prompt
  let systemPrompt: string;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const templatesDir = join(dirname(thisFile), "..", "templates");
    systemPrompt = await fsReadFile(join(templatesDir, "resolve-conflicts.md"), "utf-8");
  } catch (err: unknown) {
    uiWarn(`Could not load resolve-conflicts template: ${errorMsg(err)}`);
    return { success: false, costUsd, resolvedFiles };
  }

  const invoke = deps?.invoke ?? invokeClaude;
  const root = cwd ?? process.cwd();

  // Filter to text files only
  const textFiles: string[] = [];
  for (const file of conflictedFiles) {
    if (isBinaryPath(file)) {
      uiWarn(`Skipping binary file from conflict resolution: ${file}`);
      continue;
    }
    const fullPath = join(root, file);
    if (await isBinaryContent(fullPath)) {
      uiWarn(`Skipping binary file from conflict resolution: ${file}`);
      continue;
    }
    textFiles.push(file);
  }

  if (textFiles.length === 0) {
    uiWarn("No text files to resolve — all conflicts are in binary files");
    return { success: false, costUsd, resolvedFiles };
  }

  for (const file of textFiles) {
    const fullPath = join(root, file);
    let content: string;
    try {
      content = await fsReadFile(fullPath, "utf-8");
    } catch (err: unknown) {
      uiWarn(`Could not read conflicted file ${file}: ${errorMsg(err)}`);
      return { success: false, costUsd, resolvedFiles };
    }

    const prompt = [
      `# Merge Conflict Resolution`,
      ``,
      `## Task`,
      `- **Title:** ${taskTitle}`,
      `- **Description:** ${taskDescription}`,
      `- **Task branch:** ${taskBranch}`,
      `- **Base branch:** ${baseBranch}`,
      ``,
      `## Conflicted File: ${file}`,
      ``,
      `The file below contains conflict markers. Resolve all conflicts and output the complete resolved file content.`,
      ``,
      content,
    ].join("\n");

    try {
      const result = await invoke({
        prompt,
        systemPrompt,
        maxTurns: 1,
        ...(cwd ? { cwd } : {}),
      });
      costUsd += result.costUsd;

      const resolved = result.output.trim();
      if (!resolved || resolved.includes("<<<<<<<") || resolved.includes("=======\n") || resolved.includes(">>>>>>>")) {
        uiWarn(`Claude resolution for ${file} still contains conflict markers or is empty`);
        return { success: false, costUsd, resolvedFiles };
      }

      await fsWriteFile(fullPath, resolved, "utf-8");

      // Stage the resolved file
      const execOpts = cwd ? { cwd } : {};
      await execa("git", ["add", "--", file], execOpts);
      resolvedFiles.push(file);
    } catch (err: unknown) {
      uiWarn(`Claude resolution failed for ${file}: ${errorMsg(err)}`);
      return { success: false, costUsd, resolvedFiles };
    }
  }

  // Complete the merge commit
  const commitMessage = `Merge branch '${taskBranch}' into ${baseBranch} (conflict resolved by hootl)`;
  const execOpts = cwd ? { cwd } : {};
  try {
    await execa("git", ["commit", "-m", commitMessage], execOpts);
  } catch (err: unknown) {
    uiWarn(`Merge commit failed after conflict resolution: ${errorMsg(err)}`);
    return { success: false, costUsd, resolvedFiles: [] };
  }

  return { success: true, costUsd, resolvedFiles };
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

/**
 * Returns true if taskBranch has any diff compared to baseBranch.
 * Uses three-dot diff with --stat for efficiency (only needs non-empty check).
 * Returns true on error (conservative — don't skip validation on git failure).
 */
export async function hasBranchDiff(baseBranch: string, taskBranch: string, cwd?: string): Promise<boolean> {
  try {
    const result = await execa("git", ["diff", `${baseBranch}...${taskBranch}`, "--stat"], cwd ? { cwd } : {});
    return result.stdout.trim().length > 0;
  } catch {
    return true;
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
