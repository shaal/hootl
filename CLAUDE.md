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
  index.ts            CLI entry point (commander). Commands: init, plan, run, status, clarify
  config.ts           Zod-validated config. 3-layer merge: ~/.hootl/config.json < .hootl/config.json < env vars
  loop.ts             Core 3-phase completion loop (plan -> execute -> review). Budget/attempt tracking
  invoke.ts           Wrapper around `claude -p` via execa. Parses cost from JSON output
  git.ts              Git operations: task branches, auto-commit, branch switching
  ui.ts               Terminal UI helpers using `gum` with stdin fallback
  status.ts           Status summary writer (grouped by state)
  tasks/
    types.ts           Zod schemas for Task, TaskState, TaskBackend interface
    local.ts           Local filesystem task backend (.hootl/tasks/ directory)
  test/
    config.test.ts     Config loading, merging, env overrides
    invoke.test.ts     Arg building, cost parsing, output extraction
    invoke-robustness.test.ts  Edge cases for invoke (timeouts, errors, is_error)
    local-backend.test.ts      CRUD operations on local task backend
    loop.test.ts       Review result parsing, prompt building
    git.test.ts        Slugify, branch naming
templates/
  plan.md              System prompt for planning phase
  execute.md           System prompt for execution phase
  review.md            System prompt for review phase
docs/
  spec.md              Full project specification
.hootl/                Runtime data directory (tasks, logs, status)
```

## Architecture

### 3-Phase Completion Loop

Each task runs through repeated attempts of:

1. **PLAN** -- Claude analyzes the task, prior progress, and blockers to produce `plan.md`
2. **EXECUTE** -- Claude implements the plan; output appended to `progress.md`; changes auto-committed
3. **REVIEW** -- Claude runs tests, examines `git diff`, produces a JSON confidence assessment

The loop continues until:
- Confidence >= target (default 95%) --> task moves to `review` state
- Blockers detected --> task moves to `blocked` state
- Budget or max attempts exhausted --> task moves to `blocked` state
- Permanent error --> task stays `in_progress` for later resume

Context bridges between fresh `claude -p` calls via files in `.hootl/tasks/<id>/`: `plan.md`, `progress.md`, `test_results.md`, `blockers.md`.

### Config Hierarchy

Three layers, merged with deep-merge (later wins):
1. `~/.hootl/config.json` (global)
2. `.hootl/config.json` (project)
3. `HOOTL_*` environment variables

Key defaults: perSession=$0.50, perTask=$5.00, global=$50.00, maxAttempts=10, confidenceTarget=95%.

### Task State Machine

```
proposed --> ready --> in_progress --> review --> done
                          |
                          +--> blocked (budget, max attempts, or review blockers)
                          |       |
                          +-------+ (human resolves via `hootl clarify`)
```

### CLI Commands

```
hootl              Interactive TUI menu (gum-powered)
hootl init         Initialize .hootl/ directory
hootl plan         Plan tasks (analyze codebase, break down goal, suggest next)
hootl run [id]     Run a task (or next ready task) through the completion loop
hootl status       View tasks grouped by state
hootl clarify      Resolve blockers on blocked tasks
```

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

### Git Integration

- Task branch naming: `hootl/<task-id>-<slug>` (prefix configurable via `config.git.branchPrefix`)
- Auto-commit after each execute phase
- All git operations wrapped in try/catch -- warn on failure, never crash
- Switches back to base branch (main/master) when loop finishes

## Testing

Tests use Node.js built-in test runner (`node:test`). Test files live in `src/test/` and compile to `dist/test/`.

```bash
npm run test:build   # build + run all tests
npm run test         # run tests (requires prior build)
```

Test coverage:
- **config.test.ts** -- Config loading, 3-layer merging, env variable overrides, coercion
- **invoke.test.ts** -- Arg building, cost parsing (`total_cost_usd` / `cost_usd`), text extraction from JSON
- **invoke-robustness.test.ts** -- Timeout handling, `is_error` detection, edge cases
- **local-backend.test.ts** -- Task CRUD, filtering, atomic writes
- **loop.test.ts** -- Review JSON parsing (inline, code-block, nested), prompt building
- **git.test.ts** -- Slugify edge cases, branch name construction

## Dependencies

- **commander** -- CLI framework
- **execa** -- subprocess execution (for `claude -p`)
- **zod** -- schema validation
