# Commit Message Investigation Findings

## Problem
Commit messages are generic (`[task-001] hook-fix-1: automated changes` or `[task-001] Apply code quality fixes (re-verify 1)`) instead of Claude-generated descriptive messages.

## Root Cause (confirmed via diagnostic logging)

### The test suite is making real git commits during the simplify hook

The simplify hook's `claude -p` session runs `npm test` as part of its workflow. The test suite (`loop.test.ts`) calls `handleConfidenceMet()` with **no `hookDeps`**, which causes:

1. `handleConfidenceMet` injects the default simplify hook (since `config.hooks` is empty)
2. `runHooks` uses `defaultDeps` which includes the **real `logCost`** function
3. `logCost` writes to the **real** `.hootl/logs/cost.csv` (using `process.cwd()`)
4. The test fixtures use `task-001` as the task ID
5. The test processes call `commitTaskChanges` which runs `git add -A` and `git commit` on the **real working tree**

This is why:
- Cost CSV shows `task-001,hook:on_confidence_met,0` entries interleaved with real task work
- Git commits say `[task-001]` even when the real task is task-012 or task-013
- Commits happen in groups of 5-6 at the exact same timestamp (one per test case)
- The real task's execute commit IS Claude-generated and works fine (e.g., `[task-012] Document init --template CLI option`)

### Evidence from debug logging

Added `pid` and stack traces to `runHooks`:
- All `task-001` entries come from **test runner PIDs** (37411, 47224, 98889)
- Stack traces show `loop.test.js` → `handleConfidenceMet` → `runHooks`
- The real hootl run (pid 25508/74361) correctly calls hooks for the actual task (task-012, task-013)
- Only ONE `runHooks` call per real task run — the 5+ entries are all from the test suite

### Why `--allowedTools` and `--disallowedTools` didn't fix it

- `--dangerously-skip-permissions` (required for non-interactive `claude -p`) likely **overrides** `--disallowedTools`
- `--allowedTools` whitelist was tried but the test suite runs inside the `claude -p` session's subprocess — it doesn't go through Claude Code's tool system, it's a direct `npm test` command that Claude executes via Bash

## What works correctly

- `generateCommitMessage()` works when called — produces good messages (confirmed via diagnostic log: `exit=0, cost=0.107, dur=5638ms, output="Add commit-msg-debug log entry..."`)
- The execute phase commit uses `generateCommitMessage` successfully
- The simplify hook's `claude -p` session itself works (real cost, real output)

## Fixes applied so far (partial)

### 1. `src/git.ts` — Warning logging on fallback paths
- `generateCommitMessage` catch block now logs the actual error via `uiWarn`
- Empty output path also logs exit code and duration

### 2. `src/invoke.ts` — `getClaudeEnv()` strips additional env vars
- Now deletes `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in addition to `CLAUDECODE`
- Newer Claude Code versions use these for nesting detection

### 3. `src/loop.ts:447` — Hook-fix commits use descriptive static messages
- Changed from `commitTaskChanges(task.id, "hook-fix-N")` (which calls `generateCommitMessage`)
- To `commitTaskChanges(task.id, "hook-fix-N", "[task.id] Apply code quality fixes (re-verify N)")`
- This avoids the nesting detection issue for commit message generation after hooks

### 4. `templates/validate-simplify.md` — Added "do not git commit" instruction
- Soft guard — Claude can ignore it (and does)

### 5. `src/hooks.ts` — Simplify hook uses `allowedTools` whitelist
- Attempted to prevent git write commands via `--allowedTools` whitelist
- Did NOT fix the issue because the test suite runs as a subprocess of Claude's Bash tool, not through Claude's tool system

### 6. `src/hooks.ts` and `src/invoke.ts` — `disallowedTools` support
- Added `disallowedTools` field to `InvokeOptions` and `buildArgs`
- `--dangerously-skip-permissions` overrides it, making it ineffective

## What still needs to be fixed

### Primary fix needed: Test isolation

The `loop.test.ts` tests that call `handleConfidenceMet` without `hookDeps` must be fixed to not pollute the real working tree:

**Option A (recommended):** Pass mock `hookDeps` to ALL `handleConfidenceMet` test calls:
```typescript
const hookDeps: HookDeps = {
  invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 50 }),
  log: async () => {},
  warn: () => {},
};
```
The tests at lines 494-673 in `loop.test.ts` (the `"handleConfidenceMet"` describe block) don't pass `hookDeps`, so they trigger real `invokeClaude` + real `logCost`. These need `hookDeps` added.

**Option B:** Change `defaultDeps` to use a no-op logger when running inside a test context (fragile, not recommended).

**Option C:** Change `runHooks`/`logCost` to use a scoped log directory from the task dir instead of `process.cwd()` (bigger refactor).

### Secondary: Remove debug logging

- Remove the `hooks-debug.log` debug trace from `src/hooks.ts` (the `appendFile` call in `runHooks`)
- Remove `.hootl/hooks-debug.log` and `.hootl/commit-msg-debug.log` files
- The `disallowedTools` field in `InvokeOptions` can stay (useful for future use)

### Tertiary: Prevent test suite from committing

Even after fixing test isolation, the simplify hook's `claude -p` session can still run `npm test` which runs the test suite. If any test creates files in the working tree, `commitTaskChanges` (called by the re-verification loop) will commit them. Consider:

- Adding `.hootl/hooks-debug.log` and similar diagnostic files to `.gitignore`
- Or ensuring the re-verification loop only commits files that the hook actually intended to change (e.g., by taking a snapshot of changed files before/after the hook)

## Process chain (when running via Happy)

```
Happy (--yolo) → Claude Code (sets CLAUDE_CODE_ENTRYPOINT=sdk-ts)
  → hootl run (inherits env)
    → claude -p (execute phase) — works, env vars cleaned by getClaudeEnv()
    → claude -p (simplify hook) — works, makes fixes
      → npm test (inside claude -p session)
        → loop.test.ts → handleConfidenceMet (no hookDeps)
          → runHooks with defaultDeps → logCost to real CSV
          → invokeClaude (fails, nesting) → parseHookResult("") → pass:true
    → commitTaskChanges (re-verify) — commits test artifacts as [task-001]
    → claude -p (commit message) — may fail due to nesting race condition
```

## Key files

- `src/git.ts` — `generateCommitMessage`, `commitTaskChanges`
- `src/invoke.ts` — `invokeClaude`, `getClaudeEnv`, `buildArgs`
- `src/hooks.ts` — `runHooks`, `runSkillHook`, simplify skill definition
- `src/loop.ts` — `handleConfidenceMet`, re-verification loop (line 440+)
- `src/test/loop.test.ts` — Tests that call `handleConfidenceMet` without hookDeps (lines 494-673)
- `templates/validate-simplify.md` — Simplify hook system prompt
- `.hootl/logs/cost.csv` — Polluted by test runner
