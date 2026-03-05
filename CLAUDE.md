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
  dependencies.ts     Post-planning dependency inference and index-to-ID resolution
  selection.ts        Dependency-aware task selection (findRunnableTask)
  discuss.ts          Interactive Claude session launcher (stdio: 'inherit' for full TTY control)
  config.ts           Zod-validated config. 3-layer merge: ~/.hootl/config.json < .hootl/config.json < env vars
  context.ts          Project context gathering for plan command (spec, structure, tasks, git log)
  budget.ts           Global daily budget enforcement (reads cost.csv, checks against budgets.global)
  loop.ts             Core 3-phase completion loop (plan -> execute -> review). Budget/attempt tracking
  invoke.ts           Wrapper around `claude -p` via execa. Parses cost from JSON output
  git.ts              Git operations: task branches, auto-commit, branch switching
  guided.ts           Interactive goal clarification (generates questions via Claude, collects answers via gum)
  ui.ts               Terminal UI helpers using `gum` with stdin fallback
  plan-review.ts      Plan critique pass (self-review before task creation)
  plan-summary.ts     TL;DR plan summary with Accept/Revise/Cancel confirmation
  status.ts           Status summary writer (grouped by state)
  tasks/
    types.ts           Zod schemas for Task, TaskState, TaskBackend interface
    local.ts           Local filesystem task backend (.hootl/tasks/ directory)
  test/
    budget.test.ts     Global budget: CSV parsing, date filtering, threshold checks
    config.test.ts     Config loading, merging, env overrides
    context.test.ts    Context formatting, section inclusion/omission, ordering
    invoke.test.ts     Arg building, cost parsing, output extraction
    plan-review.test.ts  Critique prompt building, task parsing, fallback paths
    plan-summary.test.ts Plan summary generation, priority counting, truncation
    invoke-robustness.test.ts  Edge cases for invoke (timeouts, errors, is_error)
    local-backend.test.ts      CRUD operations on local task backend
    loop.test.ts       Review result parsing, prompt building
    git.test.ts        Slugify, branch naming
    discuss.test.ts    buildDiscussArgs, system prompt construction
    prioritize.test.ts userPriority sort, dependency enforcement, schema backward compat
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
- Confidence >= target (default 95%) --> handled by `handleConfidenceMet()` (see below)
- Confidence regression detected --> task moves to `blocked` state (changes rolled back)
- Blockers detected --> task moves to `blocked` state
- Budget or max attempts exhausted --> task moves to `blocked` state
- Permanent error --> task stays `in_progress` for later resume

Context bridges between fresh `claude -p` calls via files in `.hootl/tasks/<id>/`: `plan.md`, `progress.md`, `test_results.md`, `blockers.md`, `last_confidence.txt`.

### Rollback Safety (confidence regression)

Before each Phase 2 (execute), the loop records the current git HEAD SHA via `getHeadSha()`. After Phase 3 (review), if confidence is lower than the previous attempt's confidence, the loop:

1. **Rolls back** -- `git reset --hard <saved-sha>` reverts the execute phase's changes
2. **Logs** -- Appends a "ROLLED BACK" entry to `progress.md` noting the regression
3. **Blocks** -- Moves the task to `blocked` state with a descriptive blocker message

Confidence is tracked across runs via `last_confidence.txt` in the task directory. The `isConfidenceRegression(current, previous)` helper returns `true` only when `previous !== null && current < previous` — first attempts and equal scores never trigger rollback.

Git helpers: `getHeadSha()` returns the 40-char HEAD SHA; `resetToSha(sha)` runs `git reset --hard`. Both are in `src/git.ts`.

### Auto-merge / Auto-PR on Confidence Met

When a task reaches the confidence target, `handleConfidenceMet()` in `src/loop.ts` determines what to do based on the `git.onConfidence` config:

- **`merge`** — Merges the task branch into the base branch (`git checkout <base> && git merge <branch>`), deletes the task branch, moves task to `done`. Zero-friction solo dev flow.
- **`pr`** — Pushes the branch to remote, creates a draft PR via `gh pr create --draft` with task context. Moves task to `review`. Falls back gracefully if `gh` is not installed.
- **`none`** — Current behavior: just moves task to `review` state.

**Mode resolution priority** (highest first):
1. CLI flags: `--merge` forces merge, `--no-merge` forces none
2. Explicit `git.onConfidence` config value
3. Inference from `auto.defaultLevel`: conservative→none, moderate→pr, proactive→merge, full→merge

**Default is null** (infer from auto level). Since `auto.defaultLevel` defaults to `proactive`, the effective default is `merge` — meaning tasks that reach confidence will auto-merge unless overridden.

All git operations (`mergeBranch`, `deleteBranch`, `pushBranch`, `createDraftPR`) are wrapped in try/catch. On failure, they warn and fall back to `none` behavior (task moves to `review`). The `resolveOnConfidenceMode()` helper in `src/config.ts` is a pure function that encapsulates the priority logic.

### Remediation Plan Flow (confidence < target)

When the review phase scores confidence below the target, it does two additional things **in the same session** (while context is fresh):

1. **Updates documentation** -- Captures architectural decisions, patterns, and learnings in project docs (CLAUDE.md, README, inline comments)
2. **Writes a remediation plan** -- A concrete, actionable plan returned in the `remediationPlan` JSON field, written directly to `plan.md`

On the next attempt, the **plan phase is skipped** and the execute phase runs directly from the review's remediation plan. This avoids information loss at session boundaries -- the reviewer already knows exactly what's needed and prescribes it directly, rather than relying on a fresh planner to re-derive it.

The `hasRemediationPlan` flag in the loop controls plan-skipping. It resets to `false` after use and on transient errors to prevent stale plans from persisting.

### Global Daily Budget Enforcement

The global daily budget ($50.00 default) prevents runaway spend across all tasks. It is checked at two points:

1. **Pre-run gate** (`src/index.ts` → `runCommand()`) -- Before selecting a task, reads `.hootl/logs/cost.csv`, sums today's entries, and refuses to start if `>= budgets.global`. Prints an error and returns.
2. **Mid-loop gate** (`src/loop.ts` → `runCompletionLoop()`) -- At the top of each while-loop iteration (alongside the per-task budget check), re-reads the CSV. If the global budget is hit during execution, the current task moves to `blocked` with the blocker `"Global daily budget exhausted"`.

Cost data comes from `logCost()` in `src/invoke.ts`, which appends to `cost.csv` after each phase. Both writer (`toISOString()`) and reader (`toISOString().slice(0,10)`) use UTC for consistent daily boundaries. The budget logic lives in `src/budget.ts` with three functions: `getTodaysCost()`, `isGlobalBudgetExceeded()`, and `checkGlobalBudget()`.

### Config Hierarchy

Three layers, merged with deep-merge (later wins):
1. `~/.hootl/config.json` (global)
2. `.hootl/config.json` (project)
3. `HOOTL_*` environment variables

Key defaults: perSession=$0.50, perTask=$5.00, global=$50.00, maxAttempts=10, confidenceTarget=95%. `git.onConfidence` defaults to null (inferred from `auto.defaultLevel`). Env var: `HOOTL_GIT_ON_CONFIDENCE`.

### Task State Machine

```
proposed --> ready --> in_progress --> review --> done
                          |
                          +--> blocked (budget, max attempts, or review blockers)
                          |       |
                          +-------+ (human resolves via `hootl clarify`)
```

### Task Selection & Priority

Tasks have two priority fields: `priority` (planner-assigned: critical/high/medium/low) and `userPriority` (user override: number or null). Sort order for `listTasks()`:
1. `userPriority` non-null first, ascending (1 before 2)
2. `priority` (critical→low)
3. `createdAt`

When `hootl run` selects the next task, it enforces dependencies: a task is skipped if any of its `dependencies` are not in `done` or `review` state. The logic lives in `findRunnableTask()` in `src/selection.ts`.

### CLI Commands

```
hootl                          Interactive TUI menu (gum-powered)
hootl init                     Initialize .hootl/ directory
hootl plan                     Plan tasks (interactive mode selector)
hootl plan --from-spec         Auto-detect spec gaps and create tasks
hootl plan --goal "..."        Break down a specific goal into tasks
hootl plan --goal "..." --guided  Interactive clarification before planning (2-4 questions via gum)
hootl plan --goal "..." --no-critique  Skip the plan self-review pass
hootl plan --goal "..." --yes          Auto-accept plan without confirmation (for scripting/CI)
hootl plan --analyze           Analyze codebase for improvements
hootl plan --next              Suggest what to work on next
hootl run [id]                 Run a task (or next ready task) through the completion loop
hootl run [id] --merge         Force auto-merge on confidence met (overrides config)
hootl run [id] --no-merge      Disable auto-merge/PR on confidence met (overrides config)
hootl status                   View tasks grouped by state
hootl clarify                  Resolve blockers on blocked tasks
hootl discuss [taskId]         Launch interactive Claude session, optionally with task context
hootl prioritize               Interactive: select and order tasks via gum multi-select
hootl prioritize t1 t2 t3      Set userPriority by argument order (t1=#1, t2=#2, t3=#3)
hootl prioritize --clear       Remove all userPriority overrides
```

### Plan Command Context Gathering

The plan command gathers project context via `src/context.ts` before calling Claude:

- **File references** (not content) for `docs/spec.md`, `README.md`, `CLAUDE.md` -- Claude reads these itself via tools
- **Source file listing** -- `find src -type f -name "*.ts"` for project structure
- **Existing tasks** -- formatted summary from the task backend
- **Recent git log** -- last 20 commits (one-line format)

This keeps prompts small (~2K chars) while giving Claude full access to explore the codebase. The "From spec" mode compares the spec against existing code to generate gap-filling tasks with priorities.

### Auto-detected Task Dependencies

When the planner generates a batch of tasks, dependencies are automatically wired up via a two-pass process in `planCommand()`:

1. **Planner prompts** request a `dependsOn` field — an optional array of 0-based indices referencing other tasks in the same batch (e.g., `"dependsOn": [0, 2]`).
2. **`inferDependencies()`** in `src/dependencies.ts` processes the batch: uses Claude's explicit `dependsOn` when provided, falls back to heuristic keyword matching (scanning descriptions for references to other task titles) when omitted. Circular dependencies are detected and removed via DFS.
3. **Two-pass creation**: all tasks are created first (collecting `index → id` mapping), then dependencies are wired via `backend.updateTask()` in a second pass using `resolveIndicesToIds()`.

The existing `findRunnableTask()` in `src/selection.ts` enforces these dependencies at runtime — tasks whose dependencies aren't in `done` or `review` state are skipped.

### Planning Philosophy: Concrete First

The plan system prompt (`templates/plan.md`) enforces two key constraints:

1. **Concrete first** -- Task 1 must deliver the specific thing the user asked for, even if hardcoded. Abstraction and generalization come in later tasks. This prevents the planner from jumping to framework design before solving the actual problem.
2. **Plan size scrutiny** -- Plans exceeding 5-6 tasks should be questioned. Large plans often indicate premature abstraction. Tasks that only serve generalization or future-proofing should be pushed to the end or dropped.

### Plan Self-Review (Critique Pass)

After the planner generates tasks, a second `claude -p` call critiques the plan before writing tasks to disk (`src/plan-review.ts`). The critique checks:

1. Does every task map to something the user asked for?
2. Is the plan over-engineered (abstractions before concrete delivery)?
3. Did the planner miss specific things the user mentioned?
4. Should any tasks be merged or split?

The critique returns a revised task list (or the original unchanged). If the critique call fails or returns unparseable output, the original plan is used — graceful degradation, never destructive.

- **Cost**: ~$0.05 per critique call
- **Skip with**: `--no-critique` flag on the plan command
- **Integration point**: Called after initial plan JSON parsing, before `inferDependencies()`

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

### Interactive Claude Sessions (discuss command)

- Uses `stdio: "inherit"` — the third stdio pattern alongside `stdin: "ignore"` (invoke.ts) and `stdin/stderr: "inherit"` (gum)
- `stdio: "inherit"` gives the user full interactive control of the Claude session (keyboard input, terminal rendering)
- Must still delete `CLAUDECODE` env var via `getClaudeEnv()` to avoid nested-Claude-Code refusal
- No cost tracking — manual interactive sessions are outside the completion loop

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
- **loop.test.ts** -- Review JSON parsing (inline, code-block, nested, remediationPlan), prompt building, confidence regression detection, global budget integration
- **git.test.ts** -- Slugify edge cases, branch name construction, getHeadSha, resetToSha rollback
- **discuss.test.ts** -- buildDiscussArgs, system prompt construction, section ordering
- **dependencies.test.ts** -- Dependency inference (explicit indices, heuristic fallback, cycle detection, out-of-range filtering), keyword extraction, index-to-ID resolution
- **guided.test.ts** -- Clarification prompt building, question JSON parsing (valid, malformed, capped), constraints formatting, edge cases
- **plan-review.test.ts** -- Critique prompt building (goal inclusion, task JSON, indices, dependsOn), task parsing (valid, markdown-wrapped, missing fields, non-integer deps), fallback on invalid input
- **plan-summary.test.ts** -- Summary generation (single/multiple/many tasks, truncation), priority counting (mixed, default-to-medium), empty array, priority ordering
- **prioritize.test.ts** -- userPriority schema backward compat, sort order (userPriority before auto), dependency enforcement (findRunnableTask)

## Dependencies

- **commander** -- CLI framework
- **execa** -- subprocess execution (for `claude -p`)
- **zod** -- schema validation
