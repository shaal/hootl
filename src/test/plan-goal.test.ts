/**
 * Integration test: planCommand with --goal flag covering index.ts wiring.
 *
 * Verifies that the Commander CLI wiring in src/index.ts correctly passes the
 * --goal flag value through to planCommand, which constructs a "Break down a goal"
 * prompt containing the goal string, invokes Claude, and creates tasks from the
 * response. Uses the same fake-claude + real-git + real-LocalTaskBackend pattern
 * as loop-logging.test.ts.
 *
 * Covers:
 *   - Goal string appears in the prompt sent to Claude ("Break down" + "Goal: my-feature")
 *   - Tasks are created from the Claude response with correct titles and ready state
 *   - Goals are auto-created from group labels in the task response
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { planCommand } from "../index.js";
import { LocalTaskBackend } from "../tasks/local.js";

describe("planCommand --goal integration", () => {
  let tmpDir: string;
  let stateDir: string;
  let tasksDir: string;
  let backend: LocalTaskBackend;
  let originalCwd: string;
  let originalPath: string;
  let promptCapturePath: string;

  before(async () => {
    // Preserve process state first — before any fallible operations
    originalCwd = process.cwd();
    originalPath = process.env["PATH"] ?? "";

    tmpDir = await mkdtemp(join(tmpdir(), "hootl-plan-goal-test-"));
    stateDir = await mkdtemp(join(tmpdir(), "hootl-plan-goal-state-"));
    tasksDir = join(tmpDir, ".hootl", "tasks");
    const logsDir = join(tmpDir, ".hootl", "logs");
    const fakeBinDir = join(tmpDir, "fake-bin");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    backend = new LocalTaskBackend(tasksDir);

    promptCapturePath = join(stateDir, "captured-prompt.txt");

    // The fake Claude returns a JSON task array with 2 tasks, each with a group field.
    // It captures the prompt argument to a side-channel file for assertion.
    //
    // invokeClaude calls: claude -p <prompt> --no-session-persistence --output-format json ...
    // So the prompt is the argument immediately after "-p".
    const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const captureFile = ${JSON.stringify(promptCapturePath)};

// Capture the prompt: it follows the "-p" flag in process.argv
const args = process.argv.slice(2);
const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 && pIdx + 1 < args.length ? args[pIdx + 1] : "";
fs.writeFileSync(captureFile, prompt, "utf-8");

// Return two tasks with group labels, wrapped in the Claude JSON envelope
const tasks = [
  {
    title: "Set up authentication module",
    description: "Create the auth module with JWT support",
    priority: "high",
    group: "Auth System"
  },
  {
    title: "Add login endpoint",
    description: "Implement POST /login with credential validation",
    priority: "medium",
    group: "Auth System",
    dependsOn: [0]
  }
];

process.stdout.write(JSON.stringify({
  result: JSON.stringify(tasks),
  total_cost_usd: 0.001,
  context_window_percent: 5,
}));
`;
    await writeFile(join(fakeBinDir, "claude"), fakeClaude, { mode: 0o755 });

    // Real git repo — planCommand calls gatherProjectContext which reads git log
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
    await writeFile(join(tmpDir, ".gitignore"), ".hootl/\nfake-bin/\n");
    await writeFile(join(tmpDir, "README"), "init");
    await execa("git", ["add", "-A"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "init"], { cwd: tmpDir });

    process.chdir(tmpDir);
    process.env["PATH"] = `${fakeBinDir}:${originalPath}`;
  });

  after(async () => {
    process.chdir(originalCwd);
    process.env["PATH"] = originalPath;
    await rm(tmpDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("passes goal string in Claude prompt and creates tasks with goals", async () => {
    // Call planCommand with --goal "my-feature", --yes (skip confirmation), --no-critique (skip critique pass)
    await planCommand({ goal: "my-feature", yes: true, noCritique: true });

    // --- Verify the prompt sent to Claude contains the goal string ---
    const capturedPrompt = await readFile(promptCapturePath, "utf-8");

    assert.ok(
      capturedPrompt.includes("Break down"),
      "prompt should contain 'Break down' (the goal-mode prompt prefix)",
    );
    assert.ok(
      capturedPrompt.includes("my-feature"),
      "prompt should contain the goal string 'my-feature'",
    );
    assert.ok(
      capturedPrompt.includes("Goal: my-feature"),
      "prompt should contain 'Goal: my-feature' (exact format from planCommand)",
    );

    // --- Verify tasks were created from the Claude response ---
    const tasks = await backend.listTasks({});
    assert.equal(tasks.length, 2, "should create 2 tasks from fake Claude response");

    const titles = tasks.map((t) => t.title).sort();
    assert.ok(
      titles.includes("Set up authentication module"),
      "should create task with title 'Set up authentication module'",
    );
    assert.ok(
      titles.includes("Add login endpoint"),
      "should create task with title 'Add login endpoint'",
    );

    // All tasks should be in ready state (the default after creation)
    for (const task of tasks) {
      assert.equal(task.state, "ready", `task '${task.title}' should be in ready state`);
    }

    // --- Verify goals were auto-created from group labels ---
    const goalsPath = join(tmpDir, ".hootl", "goals.json");
    const goalsRaw = await readFile(goalsPath, "utf-8");
    const goals: Array<{ id: string; title: string }> = JSON.parse(goalsRaw);

    assert.ok(goals.length > 0, "should create at least one goal");
    const authGoal = goals.find((g) => g.id === "auth-system");
    assert.ok(authGoal !== undefined, "should create goal with slugified id 'auth-system'");
    assert.equal(authGoal?.title, "Auth System", "goal title should match group label");

    // Tasks should be assigned to the goal
    const updatedTasks = await backend.listTasks({});
    for (const task of updatedTasks) {
      assert.equal(task.goal, "auth-system", `task '${task.title}' should be assigned to 'auth-system' goal`);
    }

    // --- Verify dependencies were wired (task 1 depends on task 0) ---
    const loginTask = updatedTasks.find((t) => t.title === "Add login endpoint");
    const authTask = updatedTasks.find((t) => t.title === "Set up authentication module");
    assert.ok(loginTask !== undefined, "login task should exist");
    assert.ok(authTask !== undefined, "auth task should exist");
    assert.ok(
      loginTask!.dependencies !== undefined && loginTask!.dependencies.length > 0,
      "login task should have dependencies",
    );
    assert.ok(
      loginTask!.dependencies!.includes(authTask!.id),
      "login task should depend on auth task",
    );
  });
});
