import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  slugify,
  isGitRepo,
  getCurrentBranch,
  createTaskBranch,
  commitTaskChanges,
  getBaseBranch,
  getHeadSha,
  resetToSha,
  mergeBranch,
  deleteBranch,
  pushBranch,
  createDraftPR,
  getMergedOrGoneBranches,
  generateCommitMessage,
} from "../git.js";
import type { CommitMessageDeps } from "../git.js";
import type { InvokeResult } from "../invoke.js";

// ---------------------------------------------------------------------------
// Unit tests: slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("strips non-alphanumeric characters", () => {
    assert.equal(slugify("fix: add-validation!"), "fix-add-validation");
  });

  it("removes leading and trailing dashes", () => {
    assert.equal(slugify("--hello--"), "hello");
  });

  it("collapses consecutive non-alphanumeric chars into a single dash", () => {
    assert.equal(slugify("a   b...c"), "a-b-c");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(60);
    assert.equal(slugify(long).length, 40);
  });

  it("returns empty string for empty input", () => {
    assert.equal(slugify(""), "");
  });

  it("returns empty string for string of only special chars", () => {
    assert.equal(slugify("!@#$%^&*()"), "");
  });

  it("handles numbers", () => {
    assert.equal(slugify("Task 42 Done"), "task-42-done");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: generateCommitMessage
// ---------------------------------------------------------------------------

function makeInvokeResult(output: string): InvokeResult {
  return { output, costUsd: 0.001, exitCode: 0, durationMs: 100 };
}

describe("generateCommitMessage", () => {
  it("returns Claude-generated message with task ID prefix", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => makeInvokeResult("refactor auth middleware for clarity"),
    };
    const result = await generateCommitMessage("T-1", "execute", "diff content", deps);
    assert.equal(result, "[T-1] refactor auth middleware for clarity");
  });

  it("strips surrounding whitespace and newlines from Claude output", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => makeInvokeResult("\n  add validation logic  \n"),
    };
    const result = await generateCommitMessage("T-1", "execute", "diff content", deps);
    assert.equal(result, "[T-1] add validation logic");
  });

  it("falls back to static message when invoke throws", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => { throw new Error("Claude unavailable"); },
    };
    const result = await generateCommitMessage("T-1", "execute", "diff content", deps);
    assert.equal(result, "[T-1] execute: automated changes");
  });

  it("falls back to static message when invoke returns empty string", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => makeInvokeResult(""),
    };
    const result = await generateCommitMessage("T-1", "execute", "diff content", deps);
    assert.equal(result, "[T-1] execute: automated changes");
  });

  it("falls back to static message when invoke returns only whitespace", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => makeInvokeResult("   \n  "),
    };
    const result = await generateCommitMessage("T-1", "execute", "diff content", deps);
    assert.equal(result, "[T-1] execute: automated changes");
  });

  it("truncates large diffs to the configured limit before sending to Claude", async () => {
    let capturedPrompt = "";
    const deps: CommitMessageDeps = {
      invoke: async (options) => {
        capturedPrompt = options.prompt;
        return makeInvokeResult("fix large file");
      },
    };
    const largeDiff = "x".repeat(20_000);
    await generateCommitMessage("T-1", "execute", largeDiff, deps, 5_000);

    // The prompt should contain the truncated diff (5000 chars), not the full 20000
    assert.ok(capturedPrompt.length < 20_000, "prompt should not contain the full 20k diff");
    assert.ok(capturedPrompt.includes("x".repeat(5_000)), "prompt should contain exactly 5000 x chars");
    assert.ok(!capturedPrompt.includes("x".repeat(5_001)), "prompt should not contain 5001 x chars");
  });

  it("uses the full diff when under the truncation limit", async () => {
    let capturedPrompt = "";
    const deps: CommitMessageDeps = {
      invoke: async (options) => {
        capturedPrompt = options.prompt;
        return makeInvokeResult("small change");
      },
    };
    const smallDiff = "abc".repeat(30); // 90 chars
    await generateCommitMessage("T-1", "execute", smallDiff, deps, 5_000);

    assert.ok(capturedPrompt.includes(smallDiff), "prompt should contain the full diff");
  });

  it("prepends task ID prefix correctly for various task IDs", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => makeInvokeResult("update config handling"),
    };

    const r1 = await generateCommitMessage("task-abc-123", "execute", "diff", deps);
    assert.equal(r1, "[task-abc-123] update config handling");

    const r2 = await generateCommitMessage("T-42", "plan", "diff", deps);
    assert.equal(r2, "[T-42] update config handling");
  });

  it("uses correct phase in fallback message", async () => {
    const deps: CommitMessageDeps = {
      invoke: async () => { throw new Error("fail"); },
    };

    const r1 = await generateCommitMessage("T-1", "plan", "diff", deps);
    assert.equal(r1, "[T-1] plan: automated changes");

    const r2 = await generateCommitMessage("T-1", "review", "diff", deps);
    assert.equal(r2, "[T-1] review: automated changes");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: git functions (require a temp git repo)
// ---------------------------------------------------------------------------

describe("git integration", () => {
  let tmpDir: string;
  let originalCwd: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-git-test-"));
    // Initialize a git repo in the temp directory
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    // Create an initial commit so the repo has a HEAD
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("isGitRepo", () => {
    it("returns true inside a git repository", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const result = await isGitRepo();
        assert.equal(result, true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns false in a non-git directory", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "hootl-no-git-"));
      const originalCwd = process.cwd();
      try {
        process.chdir(nonGitDir);
        const result = await isGitRepo();
        assert.equal(result, false);
      } finally {
        process.chdir(originalCwd);
        await rm(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const branch = await getCurrentBranch();
        assert.equal(branch, "main");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("createTaskBranch", () => {
    it("creates and switches to a new branch", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const branchName = await createTaskBranch("T-1", "Add Login Page", "task/");
        assert.equal(branchName, "task/T-1-add-login-page");
        const current = await getCurrentBranch();
        assert.equal(current, "task/T-1-add-login-page");
      } finally {
        // Switch back to main for subsequent tests
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        process.chdir(originalCwd);
      }
    });

    it("switches to an existing branch if it already exists", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        // The branch was created in the previous test
        const branchName = await createTaskBranch("T-1", "Add Login Page", "task/");
        assert.equal(branchName, "task/T-1-add-login-page");
        const current = await getCurrentBranch();
        assert.equal(current, "task/T-1-add-login-page");
      } finally {
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        process.chdir(originalCwd);
      }
    });
  });

  describe("commitTaskChanges", () => {
    it("generates commit message from staged diff via DI", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await writeFile(join(tmpDir, "newfile.txt"), "hello");

        let capturedPrompt = "";
        const mockDeps: CommitMessageDeps = {
          invoke: async ({ prompt }) => {
            capturedPrompt = prompt;
            return { output: "add newfile with greeting", costUsd: 0 } as InvokeResult;
          },
        };

        const committed = await commitTaskChanges("T-2", "execute", undefined, mockDeps);
        assert.equal(committed, true);

        // Verify the diff was captured and forwarded to the generator
        assert.ok(capturedPrompt.includes("newfile.txt"), "prompt should contain the diff with the filename");

        // Verify the commit message uses the generated text with task prefix
        const log = await execa("git", ["log", "--oneline", "-1"], { cwd: tmpDir });
        assert.ok(log.stdout.includes("[T-2] add newfile with greeting"));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("falls back to static message when generation fails", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await writeFile(join(tmpDir, "fallback.txt"), "fallback content");

        const failingDeps: CommitMessageDeps = {
          invoke: async () => {
            throw new Error("invoke failed");
          },
        };

        const committed = await commitTaskChanges("T-2b", "execute", undefined, failingDeps);
        assert.equal(committed, true);

        const log = await execa("git", ["log", "--oneline", "-1"], { cwd: tmpDir });
        assert.ok(log.stdout.includes("[T-2b] execute: automated changes"));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns false when there are no changes to commit", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const committed = await commitTaskChanges("T-3", "execute");
        assert.equal(committed, false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("uses a custom message when provided and skips generation", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await writeFile(join(tmpDir, "custom.txt"), "custom content");

        let invokeCalled = false;
        const mockDeps: CommitMessageDeps = {
          invoke: async () => {
            invokeCalled = true;
            return { output: "should not be used", costUsd: 0 } as InvokeResult;
          },
        };

        const committed = await commitTaskChanges("T-4", "plan", "custom commit msg", mockDeps);
        assert.equal(committed, true);
        assert.equal(invokeCalled, false, "generateCommitMessage should not be called when message is provided");

        const log = await execa("git", ["log", "--oneline", "-1"], { cwd: tmpDir });
        assert.ok(log.stdout.includes("custom commit msg"));
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("getBaseBranch", () => {
    it("returns 'main' when main branch exists", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const base = await getBaseBranch();
        assert.equal(base, "main");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("getHeadSha", () => {
    it("returns a 40-character hex SHA", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const sha = await getHeadSha();
        assert.equal(sha.length, 40);
        assert.match(sha, /^[0-9a-f]{40}$/);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("resetToSha", () => {
    it("resets the working tree to a previous commit", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);

        // Record the current SHA (after initial commits from earlier tests)
        const sha1 = await getHeadSha();

        // Create a new file and commit
        await writeFile(join(tmpDir, "rollback-test.txt"), "should be removed");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "commit to rollback"], { cwd: tmpDir });

        const sha2 = await getHeadSha();
        assert.notEqual(sha1, sha2);

        // Reset to the first SHA
        await resetToSha(sha1);

        // Verify HEAD matches the first SHA
        const currentSha = await getHeadSha();
        assert.equal(currentSha, sha1);

        // Verify the file created in the second commit is gone
        const { existsSync } = await import("node:fs");
        assert.equal(existsSync(join(tmpDir, "rollback-test.txt")), false);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("mergeBranch", () => {
    it("merges a task branch into the base branch", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);

        // Ensure we're on main
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        // Create a feature branch and add a commit
        await execa("git", ["checkout", "-b", "feature-merge-test"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "merge-test.txt"), "merge content");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "feature commit"], { cwd: tmpDir });

        // Merge back into main
        const result = await mergeBranch("feature-merge-test", "main");
        assert.equal(result, true);

        // Verify we're on main now
        const branch = await getCurrentBranch();
        assert.equal(branch, "main");

        // Verify the file exists on main
        const { existsSync } = await import("node:fs");
        assert.equal(existsSync(join(tmpDir, "merge-test.txt")), true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns false on merge conflict", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);

        // Ensure we're on main
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        // Create a common ancestor file
        await writeFile(join(tmpDir, "conflict.txt"), "original content");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "common ancestor"], { cwd: tmpDir });

        // Create a branch and modify the file there
        await execa("git", ["checkout", "-b", "feature-conflict-test"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "conflict.txt"), "branch content\nline2\nline3");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "branch side"], { cwd: tmpDir });

        // Go back to main and make a conflicting change to the same file
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "conflict.txt"), "main content\nline2\nline3");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "main side"], { cwd: tmpDir });

        // Try to merge — should fail due to conflict
        const result = await mergeBranch("feature-conflict-test", "main");
        assert.equal(result, false);
      } finally {
        // Clean up: get back to main
        try { await execa("git", ["merge", "--abort"], { cwd: tmpDir }); } catch { /* ok */ }
        try { await execa("git", ["checkout", "main"], { cwd: tmpDir }); } catch { /* ok */ }
        process.chdir(originalCwd);
      }
    });
  });

  describe("deleteBranch", () => {
    it("deletes a merged branch", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        // Create and immediately merge a branch so it can be safely deleted
        await execa("git", ["checkout", "-b", "branch-to-delete"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "del-test.txt"), "delete me");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "to delete"], { cwd: tmpDir });
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        await execa("git", ["merge", "branch-to-delete"], { cwd: tmpDir });

        // Delete the branch
        await deleteBranch("branch-to-delete");

        // Verify it no longer exists
        const { branchExists } = await import("../git.js");
        const exists = await branchExists("branch-to-delete");
        assert.equal(exists, false);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("getMergedOrGoneBranches", () => {
    it("returns gone for branches that do not exist", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const { merged, gone } = await getMergedOrGoneBranches(["nonexistent-branch"], "main");
        assert.equal(gone.has("nonexistent-branch"), true);
        assert.equal(merged.has("nonexistent-branch"), false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns merged for branches that are merged into base", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        await execa("git", ["checkout", "-b", "merged-but-exists"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "merged-check.txt"), "merged");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "merged branch commit"], { cwd: tmpDir });
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        await execa("git", ["merge", "merged-but-exists"], { cwd: tmpDir });

        const { merged, gone } = await getMergedOrGoneBranches(["merged-but-exists"], "main");
        assert.equal(merged.has("merged-but-exists"), true);
        assert.equal(gone.has("merged-but-exists"), false);
      } finally {
        try { await execa("git", ["checkout", "main"], { cwd: tmpDir }); } catch { /* ok */ }
        try { await execa("git", ["branch", "-d", "merged-but-exists"], { cwd: tmpDir }); } catch { /* ok */ }
        process.chdir(originalCwd);
      }
    });

    it("returns neither for branches that exist but are not merged", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        await execa("git", ["checkout", "-b", "unmerged-branch"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "unmerged-check.txt"), "unmerged");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "unmerged branch commit"], { cwd: tmpDir });
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        const { merged, gone } = await getMergedOrGoneBranches(["unmerged-branch"], "main");
        assert.equal(merged.has("unmerged-branch"), false);
        assert.equal(gone.has("unmerged-branch"), false);
      } finally {
        try { await execa("git", ["checkout", "main"], { cwd: tmpDir }); } catch { /* ok */ }
        try { await execa("git", ["branch", "-D", "unmerged-branch"], { cwd: tmpDir }); } catch { /* ok */ }
        process.chdir(originalCwd);
      }
    });

    it("handles a batch of mixed branches in one call", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        // Create a merged branch
        await execa("git", ["checkout", "-b", "batch-merged"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "batch-m.txt"), "m");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "batch merged"], { cwd: tmpDir });
        await execa("git", ["checkout", "main"], { cwd: tmpDir });
        await execa("git", ["merge", "batch-merged"], { cwd: tmpDir });

        // Create an unmerged branch
        await execa("git", ["checkout", "-b", "batch-unmerged"], { cwd: tmpDir });
        await writeFile(join(tmpDir, "batch-u.txt"), "u");
        await execa("git", ["add", "-A"], { cwd: tmpDir });
        await execa("git", ["commit", "-m", "batch unmerged"], { cwd: tmpDir });
        await execa("git", ["checkout", "main"], { cwd: tmpDir });

        const { merged, gone } = await getMergedOrGoneBranches(
          ["batch-merged", "batch-unmerged", "batch-gone"],
          "main",
        );
        assert.equal(merged.has("batch-merged"), true);
        assert.equal(merged.has("batch-unmerged"), false);
        assert.equal(gone.has("batch-gone"), true);
        assert.equal(gone.has("batch-merged"), false);
      } finally {
        try { await execa("git", ["checkout", "main"], { cwd: tmpDir }); } catch { /* ok */ }
        try { await execa("git", ["branch", "-d", "batch-merged"], { cwd: tmpDir }); } catch { /* ok */ }
        try { await execa("git", ["branch", "-D", "batch-unmerged"], { cwd: tmpDir }); } catch { /* ok */ }
        process.chdir(originalCwd);
      }
    });

    it("returns empty sets for empty input", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const { merged, gone } = await getMergedOrGoneBranches([], "main");
        assert.equal(merged.size, 0);
        assert.equal(gone.size, 0);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("pushBranch", () => {
    it("returns false gracefully when no remote is configured", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        const result = await pushBranch("main");
        assert.equal(result, false);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("createDraftPR", () => {
    it("returns false gracefully when gh is not available or no remote", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        // This will fail either because gh is not installed or because there's no remote
        const result = await createDraftPR("Test PR", "Test body");
        assert.equal(result, false);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
