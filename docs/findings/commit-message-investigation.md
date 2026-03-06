# Commit Message Investigation Findings

## Problem
Commit messages are generic (`[task-001] Apply code quality fixes (re-verify 1)`) instead of Claude-generated descriptive messages. Every `npm test` run could vacuum up uncommitted changes and commit them under the `task-001` identity.

## Root Cause (confirmed via diagnostic logging)

### The test suite was making real git commits during `npm test`

When `npm test` runs (directly or inside a `claude -p` session), `loop.test.ts` calls `handleConfidenceMet()` which:

1. Injects the default simplify hook (since test config has no hooks)
2. Without mock `hookDeps`, uses `defaultDeps` → real `invokeClaude`
3. `invokeClaude` actually succeeds (because `getClaudeEnv()` strips nesting detection env vars)
4. The simplify hook finds real issues and returns `fixes_applied: [...]`
5. The re-verification loop calls `commitTaskChanges(task.id, ...)` where `task.id = "task-001"`
6. `commitTaskChanges` runs `git add -A` on the **real working tree** — staging ALL uncommitted changes
7. `git commit -m "[task-001] Apply code quality fixes (re-verify 1)"` commits everything

The `git add -A` is the key amplifier — it doesn't just commit test artifacts, it commits **whatever you were working on** under the wrong identity.

### Evidence from debug logging (since removed)

- All `task-001` entries came from **test runner PIDs**, not the real hootl run
- Stack traces showed `loop.test.js` → `handleConfidenceMet` → `runHooks`
- Commits appeared in groups of 5-6 at the exact same timestamp (one per test case)

## Resolution (applied)

### Fix 1: Mock `hookDeps` for all `handleConfidenceMet` tests

Added a shared `noopHookDeps` at the top of the `handleConfidenceMet` describe block:

```typescript
const noopHookDeps: HookDeps = {
  invoke: async () => ({ output: '{"pass": true}', costUsd: 0, exitCode: 0, durationMs: 50 } as InvokeResult),
  log: async () => {},
  warn: () => {},
  commit: async () => false,
};
```

Applied to the 5 tests (lines ~489-570) that previously called `handleConfidenceMet` without `hookDeps`.

### Fix 2: Injectable `commit` in `HookDeps` (defense-in-depth)

Added optional `commit` function to `HookDeps` interface:

```typescript
export interface HookDeps {
  invoke: typeof invokeClaude;
  log: typeof logCost;
  warn: typeof uiWarn;
  commit?: (taskId: string, phase: string, message?: string) => Promise<boolean>;
}
```

The re-verification loop in `handleConfidenceMet` now routes commits through it:

```typescript
const commitFn = hookDeps?.commit ?? commitTaskChanges;
await commitFn(task.id, ...);
```

All re-verification tests (6 total) now include `commit: async () => false` in their `hookDeps`.

### Fix 3: Removed debug logging

Removed the `appendFile` call to `.hootl/hooks-debug.log` from `src/hooks.ts` and deleted the debug log files.

### Verification

After the fix, `npm test` no longer creates any git commits:
```
$ git log --oneline -1   # before
5008614 [task-001] Apply code quality fixes (re-verify 1)
$ npm test               # 633 pass, 0 fail
$ git log --oneline -1   # after — same commit, no rogue commits
5008614 [task-001] Apply code quality fixes (re-verify 1)
```

## Earlier fixes (from previous sessions, still in place)

1. `src/git.ts` — `generateCommitMessage` catch block logs errors via `uiWarn`
2. `src/invoke.ts` — `getClaudeEnv()` strips `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
3. `src/loop.ts` — Re-verification commits use static messages (avoids nesting detection issue for commit message generation)
4. `templates/validate-simplify.md` — "do not git commit" instruction (soft guard)

## Why `--allowedTools` / `--disallowedTools` didn't work

- `--dangerously-skip-permissions` (required for non-interactive `claude -p`) overrides `--disallowedTools`
- `--allowedTools` whitelist doesn't prevent subprocess side effects — `npm test` runs as a subprocess of Claude's Bash tool, not through Claude's tool permission system

## Key files

- `src/git.ts` — `generateCommitMessage`, `commitTaskChanges`
- `src/hooks.ts` — `HookDeps` interface (with `commit`), `runHooks`, simplify skill definition
- `src/loop.ts` — `handleConfidenceMet`, re-verification loop
- `src/test/loop.test.ts` — All `handleConfidenceMet` tests with mock `hookDeps`
