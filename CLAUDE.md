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
  context.ts          Project context gathering for plan command (spec, structure, tasks, git log)
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
    context.test.ts    Context formatting, section inclusion/omission, ordering
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

### Remediation Plan Flow (confidence < target)

When the review phase scores confidence below the target, it does two additional things **in the same session** (while context is fresh):

1. **Updates documentation** -- Captures architectural decisions, patterns, and learnings in project docs (CLAUDE.md, README, inline comments)
2. **Writes a remediation plan** -- A concrete, actionable plan returned in the `remediationPlan` JSON field, written directly to `plan.md`

On the next attempt, the **plan phase is skipped** and the execute phase runs directly from the review's remediation plan. This avoids information loss at session boundaries -- the reviewer already knows exactly what's needed and prescribes it directly, rather than relying on a fresh planner to re-derive it.

The `hasRemediationPlan` flag in the loop controls plan-skipping. It resets to `false` after use and on transient errors to prevent stale plans from persisting.

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
hootl                          Interactive TUI menu (gum-powered)
hootl init                     Initialize .hootl/ directory
hootl plan                     Plan tasks (interactive mode selector)
hootl plan --from-spec         Auto-detect spec gaps and create tasks
hootl plan --goal "..."        Break down a specific goal into tasks
hootl plan --analyze           Analyze codebase for improvements
hootl plan --next              Suggest what to work on next
hootl run [id]                 Run a task (or next ready task) through the completion loop
hootl status                   View tasks grouped by state
hootl clarify                  Resolve blockers on blocked tasks
```

### Plan Command Context Gathering

The plan command gathers project context via `src/context.ts` before calling Claude:

- **File references** (not content) for `docs/spec.md`, `README.md`, `CLAUDE.md` -- Claude reads these itself via tools
- **Source file listing** -- `find src -type f -name "*.ts"` for project structure
- **Existing tasks** -- formatted summary from the task backend
- **Recent git log** -- last 20 commits (one-line format)

This keeps prompts small (~2K chars) while giving Claude full access to explore the codebase. The "From spec" mode compares the spec against existing code to generate gap-filling tasks with priorities.

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

### UI / gum Integration

All interactive TUI calls go through helpers in `src/ui.ts` (`uiChoose`, `uiConfirm`, `uiInput`). Critical details:

- **All `execa("gum", ...)` calls must use `{ stdin: "inherit", stderr: "inherit" }`** -- gum renders its TUI to stderr and reads keypresses from stdin; piping these (execa's default) makes the UI invisible and the process appears stuck
- `stdout` must stay as `"pipe"` (the default) so the user's selection can be captured via `result.stdout`
- gum follows the Unix convention: interactive UI to stderr, result to stdout -- this is the opposite of `claude -p` which uses `stdin: "ignore"`
- Each helper has a non-gum fallback (numbered list on stdin) for environments without gum installed

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
- **context.test.ts** -- Context formatting, section inclusion/omission based on null/empty fields, ordering
- **invoke.test.ts** -- Arg building, cost parsing (`total_cost_usd` / `cost_usd`), text extraction from JSON
- **invoke-robustness.test.ts** -- Timeout handling, `is_error` detection, edge cases
- **local-backend.test.ts** -- Task CRUD, filtering, atomic writes
- **loop.test.ts** -- Review JSON parsing (inline, code-block, nested, remediationPlan), prompt building
- **git.test.ts** -- Slugify edge cases, branch name construction

## Dependencies

- **commander** -- CLI framework
- **execa** -- subprocess execution (for `claude -p`)
- **zod** -- schema validation
