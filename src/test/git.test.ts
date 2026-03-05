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
} from "../git.js";

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
    it("commits staged changes and returns true", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        // Create a file so there are changes
        await writeFile(join(tmpDir, "newfile.txt"), "hello");
        const committed = await commitTaskChanges("T-2", "execute");
        assert.equal(committed, true);
        // Verify the commit exists
        const log = await execa("git", ["log", "--oneline", "-1"], { cwd: tmpDir });
        assert.ok(log.stdout.includes("[T-2] execute: automated changes"));
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

    it("uses a custom message when provided", async () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        await writeFile(join(tmpDir, "custom.txt"), "custom content");
        const committed = await commitTaskChanges("T-4", "plan", "custom commit msg");
        assert.equal(committed, true);
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
});
