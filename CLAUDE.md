# hootl — Human Out Of The Loop

Autonomous task completion engine that orchestrates `claude -p` calls in a 3-phase loop (plan, execute, review) to complete coding tasks without constant human attention. Tasks that hit blockers park themselves; the system moves on.

TypeScript, ESM, Node.js >= 20.

## Build & Run

```bash
npm run build       # Compile TypeScript (tsc)
npm run dev         # Watch mode (tsc --watch)
npm run start       # Run the CLI (node dist/index.js)
npm run lint        # Type-check without emitting (tsc --noEmit)
npm run test        # Run tests (node --test dist/test/*.test.js)
npm run test:build  # Build then run tests
```

## Project Structure

```
src/
  index.ts            CLI entry point (commander). Commands: init, plan, run, status, clarify, discuss, prioritize
  parse-tasks.ts      Robust JSON array extraction from Claude plan responses (bracket-matching)
  dependencies.ts     Post-planning dependency inference and index-to-ID resolution
  selection.ts        Dependency-aware task selection (findRunnableTask)
  discuss.ts          Interactive Claude session launcher (stdio: 'inherit' for full TTY control)
  config.ts           Zod-validated config. 3-layer merge: ~/.hootl/config.json < .hootl/config.json < env vars
  context.ts          Project context gathering for plan command (spec, structure, tasks, git log)
  budget.ts           Global daily budget enforcement (reads cost.csv, checks against budgets.global)
  loop.ts             Core completion loop (preflight -> plan -> execute -> review). Budget/attempt tracking
  invoke.ts           Wrapper around `claude -p` via execa. Parses cost from JSON output
  git.ts              Git operations: task branches, auto-commit, branch switching, merged-branch detection
  sync.ts             Review-task sync: auto-promotes tasks to done when branches are merged externally
  guided.ts           Interactive goal clarification (generates questions via Claude, collects answers via gum)
  ui.ts               Terminal UI helpers using `gum` with stdin fallback
  plan-memory.ts      Planning memory: records lessons from task outcomes, injects into plan prompts
  plan-review.ts      Plan critique pass (self-review before task creation)
  plan-summary.ts     TL;DR plan summary with Accept/Revise/Cancel confirmation
  hooks.ts            Hook execution engine (filter, prompt resolution, run, orchestrate)
  logger.ts           Structured JSONL event logger (phase_start/end, state_change, decision, error, hook_run, budget_check)
  notify.ts           OS notifications (macOS osascript, Linux notify-send) for task events
  status.ts           Status summary writer (grouped by state)
  tasks/
    types.ts           Zod schemas for Task, TaskState, TaskBackend interface
    local.ts           Local filesystem task backend (.hootl/tasks/ directory)
  test/               Tests (see src/test/CLAUDE.md for coverage details)
templates/
  preflight.md         System prompt for preflight validation phase (Phase 0)
  plan.md              System prompt for planning phase
  execute.md           System prompt for execution phase
  review.md            System prompt for review phase
  validate-simplify.md System prompt template for the simplify skill (default on_confidence_met hook)
docs/
  spec.md              Full project specification
  architecture.md      Detailed architecture documentation
.hootl/                Runtime data directory (tasks, logs, status)
```

## Detailed Documentation

- **[Architecture](docs/architecture.md)** — Completion loop, crash recovery, task claiming, worktrees, hooks, state machine, CLI commands, and all subsystem details
- **[Test Coverage](src/test/CLAUDE.md)** — Per-file test documentation (auto-loaded when working in `src/test/`)

## Key Conventions

### TypeScript

- Strict mode, ESM (`"type": "module"`)
- No `any` -- use `unknown` with type narrowing
- `noUncheckedIndexedAccess: true` -- always handle possible `undefined` from indexed access
- Zod for all schema validation (config, tasks)
- File imports use `.js` extension (Node16 module resolution)
- Atomic file writes via tmp + rename pattern (see `local.ts`)
- Error handling: catch `unknown`, narrow with `instanceof Error`

### claude -p Invocation

All `claude -p` calls go through `invokeClaude()` in `src/invoke.ts`. Critical details:

- **Always** use `--output-format json` to capture cost data (text output extracted from `result` field)
- **Always** use `--dangerously-skip-permissions` (non-interactive mode)
- **Always** use `--no-session-persistence` (fresh context each call)
- System prompt flag is `--system-prompt` (not `-s`)
- Cost field in JSON output is `total_cost_usd` (not `cost_usd`)
- Must `delete env["CLAUDECODE"]` before calling `claude -p` (otherwise it refuses to start inside Claude Code)
- Must pass `stdin: "ignore"` to execa (otherwise subprocess hangs)
- Timeout: 5 minutes per call (exit code 124 on timeout)
- `is_error: true` in JSON response is treated as exit code 1
- **Transient error retry**: Timeouts (exit code 124), rate limits (429/"rate limit"), and network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ECONNRESET) are retried with exponential backoff (1s, 2s, 4s) up to 3 times inside `invokeClaude()`. Cost is accumulated across retries for accurate budget tracking. The `sleep` function is injectable via `InvokeClaudeDeps` for testability. The loop in `src/loop.ts` still handles transient errors as a fallback if all invoke-level retries are exhausted.

### UI / gum Integration

All interactive TUI calls go through helpers in `src/ui.ts` (`uiChoose`, `uiConfirm`, `uiInput`). Critical details:

- **All `execa("gum", ...)` calls must use `{ stdin: "inherit", stderr: "inherit" }`** -- gum renders its TUI to stderr and reads keypresses from stdin; piping these (execa's default) makes the UI invisible and the process appears stuck
- `stdout` must stay as `"pipe"` (the default) so the user's selection can be captured via `result.stdout`
- gum follows the Unix convention: interactive UI to stderr, result to stdout -- this is the opposite of `claude -p` which uses `stdin: "ignore"`
- Each helper has a non-gum fallback (numbered list on stdin) for environments without gum installed

### Interactive Claude Sessions (discuss command)

- Uses `stdio: "inherit"` — the third stdio pattern alongside `stdin: "ignore"` (invoke.ts) and `stdin/stderr: "inherit"` (gum)
- `stdio: "inherit"` gives the user full interactive control of the Claude session (keyboard input, terminal rendering)
- Must still delete `CLAUDECODE` env var via `getClaudeEnv()` to avoid nested-Claude-Code refusal
- No cost tracking — manual interactive sessions are outside the completion loop

### Git Integration

- Task branch naming: `hootl/<task-id>-<slug>` (prefix configurable via `config.git.branchPrefix`)
- Auto-commit after each execute phase with Claude-generated commit messages
- `generateCommitMessage()` generates commit messages via Claude from staged diffs (`git diff --cached` + `git diff --cached --stat`). Falls back to `[taskId] phase: automated changes` on failure. Uses DI via `CommitMessageDeps` for testability. Diffs truncated to 8K chars by default. Output constrained to single line, max 120 characters (before task ID prefix).
- All git operations wrapped in try/catch -- warn on failure, never crash
- Switches back to base branch (main/master) when loop finishes
- `getMergedOrGoneBranches()` uses `--format "%(refname:short)"` for robust branch name parsing (avoids regex on `*` prefix)

## Dependencies

- **commander** -- CLI framework
- **execa** -- subprocess execution (for `claude -p`)
- **zod** -- schema validation
