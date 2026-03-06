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
  notify.ts           OS notifications (macOS osascript, Linux notify-send) for task events
  status.ts           Status summary writer (grouped by state)
  tasks/
    types.ts           Zod schemas for Task, TaskState, TaskBackend interface
    local.ts           Local filesystem task backend (.hootl/tasks/ directory)
  test/
    budget.test.ts     Global budget: CSV parsing, date filtering, threshold checks
    config.test.ts     Config loading, merging, env overrides
    context.test.ts    Context formatting, section inclusion/omission, ordering
    invoke.test.ts     Arg building, cost parsing, output extraction
    plan-memory.test.ts  Memory entry generation, append/rotation, pattern loading, metrics computation
    preflight.test.ts    Preflight template existence and content assertions
    extract-tasks.test.ts JSON array extraction (clean, code-block, bracket-matching, edge cases)
    plan-review.test.ts  Critique prompt building, task parsing, fallback paths
    plan-summary.test.ts Plan summary generation, priority counting, truncation
    invoke-robustness.test.ts  Edge cases for invoke (timeouts, errors, is_error, transient retry)
    local-backend.test.ts      CRUD operations on local task backend
    loop.test.ts       Review result parsing, prompt building
    git.test.ts        Slugify, branch naming, commit message generation
    discuss.test.ts    buildDiscussArgs, system prompt construction
    checkpoint.test.ts Checkpoint read/write/clear, round-trip, error resilience
    prioritize.test.ts userPriority sort, dependency enforcement, schema backward compat
    sync.test.ts       Review task sync integration tests (real git repo + LocalTaskBackend)
    branch-block.test.ts  Branch-switch failure blocks task (dirty worktree integration test)
    notify.test.ts     OS notification config gating, platform dispatch, error resilience, webhook notifications
templates/
  preflight.md         System prompt for preflight validation phase (Phase 0)
  plan.md              System prompt for planning phase
  execute.md           System prompt for execution phase
  review.md            System prompt for review phase
  validate-simplify.md System prompt template for the simplify skill (default on_confidence_met hook)
docs/
  spec.md              Full project specification
.hootl/                Runtime data directory (tasks, logs, status)
```

## Architecture

### Completion Loop (Phase 0 + 3-Phase Attempts)

Each task begins with a one-time preflight validation, then runs through repeated attempts of plan/execute/review:

0. **PREFLIGHT** (once per task) -- Claude validates the task's clarity, scope, and reproducibility. Produces `understanding.md` for context bridging. Based on the verdict:
   - `proceed` → continue to the attempt loop
   - `too_broad` → subtasks auto-created via `backend.createTask()` in `ready` state; inter-subtask dependencies inferred via `inferDependencies()` (same heuristic as the plan command). If the parent has a `userPriority`, subtasks inherit fractional slots right after it (e.g. parent=16 → subtasks get 16.2, 16.4, 16.6, 16.8) so they're worked on before lower-priority tasks. Parent moves back to `ready` with subtask IDs as dependencies (so it's picked up again after subtasks complete). `understanding.md` is deleted so preflight runs fresh on re-run. Falls back to `blocked` if no subtasks provided.
   - `unclear` → task moves to `blocked` with clarification questions
   - `cannot_reproduce` → task moves to `blocked` with reproduction failure details
   - Skipped if `understanding.md` already exists (task is resuming after human resolved a blocker)
   - On preflight failure (timeout, error, empty output): graceful degradation — proceed to the loop anyway
1. **PLAN** -- Claude analyzes the task, prior progress, and blockers to produce `plan.md`
2. **EXECUTE** -- Claude implements the plan; output appended to `progress.md`; changes auto-committed
3. **REVIEW** -- Claude runs tests, examines `git diff`, produces a JSON confidence assessment

The loop continues until:
- Confidence >= target (default 95%) --> handled by `handleConfidenceMet()` (see below)
- Confidence regression detected --> task moves to `blocked` state (changes rolled back)
- Blockers detected --> task moves to `blocked` state
- Budget or max attempts exhausted --> task moves to `blocked` state
- Permanent error --> task stays `in_progress` for later resume

Context bridges between fresh `claude -p` calls via files in `.hootl/tasks/<id>/`: `understanding.md`, `plan.md`, `progress.md`, `test_results.md`, `blockers.md`, `last_confidence.txt`, `checkpoint.json`.

### Crash Recovery

On restart, the loop detects interrupted phases via `checkpoint.json` in the task directory. Before each phase (preflight, plan, execute, review), `writeCheckpoint()` atomically writes the current phase name and attempt number. On resume:

- `readCheckpoint()` detects the interrupted phase and logs a recovery message
- If the execute phase was interrupted, `hasUncommittedChanges()` checks for leftover changes and auto-commits them with a recovery message (appended to `progress.md`). In worktree mode, `task.worktree` is used as `cwd` for these operations.
- If a plan exists from an interrupted execute/review phase, the log notes it will skip re-planning
- The stale checkpoint is cleared before the loop writes fresh ones
- `clearCheckpoint()` runs on normal exit to clean up

All checkpoint operations are wrapped in try/catch — checkpoint failures never block the loop. Uses the same atomic tmp + rename pattern as `local.ts`.

### Git Worktree Mode

When `config.git.useWorktrees` is `true`, tasks run in isolated git worktrees instead of switching branches in the main working tree. This allows multiple tasks to run without affecting the developer's checkout.

**How it works:**
- `runCompletionLoop` creates a worktree at `.hootl/worktrees/<taskId>/` via `createWorktree()` in `src/git.ts`
- All `invokeClaude()` calls (preflight, plan, execute, review, hooks) receive `cwd: worktreePath`
- All git operations (`commitTaskChanges`, `getHeadSha`, `resetToSha`) receive `cwd: worktreePath`
- The main working tree is **never touched** — no branch switching, no dirty-worktree risk
- Task metadata (`.hootl/tasks/<id>/`) stays in the main tree (gitignored, persists across worktree lifecycle)
- The `task.worktree` field stores the worktree path for crash recovery

**Worktree lifecycle:**
- Created when the task starts (or reused if already exists — resume case)
- `merge` mode: worktree removed after successful merge + branch deletion
- `pr` mode: worktree kept alive until PR is merged (user may get review feedback)
- `blocked` state: worktree kept alive (user may want to inspect)
- Crash recovery uses `task.worktree` to pass `cwd` to `hasUncommittedChanges()` and `commitTaskChanges()`

**Config:** `git.useWorktrees: true` (default: `false`). Env var: `HOOTL_GIT_USE_WORKTREES`.

**Git functions with `cwd` support:** `commitTaskChanges`, `getHeadSha`, `resetToSha`, `hasUncommittedChanges`, `pushBranch`, `mergeBranch`, `deleteBranch`, `generateCommitMessage`. All default to `undefined` (current directory) for backward compatibility.

### Branch-Switch Safety (non-worktree mode only)

Before the loop begins, `runCompletionLoop` creates or switches to the task branch. If the branch switch fails (e.g., uncommitted changes would be overwritten), the task moves to `blocked` with a descriptive message and the loop returns immediately — no phases run on the wrong branch. The blocker message distinguishes dirty-worktree errors ("Commit or stash your changes") from other git failures. The user can resolve the issue and re-run. In worktree mode, this safety check is unnecessary since the main working tree is never modified.

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

**Re-verification after hook fixes**: When an `on_confidence_met` hook reports `fixes_applied` (non-empty `remediationActions`), `handleConfidenceMet()` enters a re-verification loop: (1) auto-commits the hook's changes via `hookDeps.commit` (or `commitTaskChanges` in production), (2) re-runs Phase 3 (review) to get an updated confidence score, (3) if confidence is still >= target, re-runs hooks to check for more fixes, (4) if confidence dropped below target, writes a remediation plan to `plan.md` and returns `in_progress` so the main loop continues. The loop is capped at `MAX_REVERIFICATIONS` (2) to prevent infinite hook↔review cycles. Re-verification costs are logged with the `"re-verify"` phase label. When `hookDeps` is injected (testing), invoke, log, and commit calls route through the injected dependencies.

### Autonomous Mode (`hootl auto`)

The `auto` command runs tasks sequentially until the queue drains or the global budget is exhausted. It wraps the same building blocks as `runCommand()`:

1. **Sync** — calls `syncReviewTasks()` to promote externally merged branches
2. **Budget gate** — calls `checkGlobalBudget()` and breaks if exceeded
3. **Task selection** — prefers `in_progress` tasks (resume), then `ready` tasks, both via `selectFromState()` which enforces dependencies
4. **Execution** — calls `runCompletionLoop()` which handles per-task budget, max attempts, blocking, and state transitions
5. **Loop** — repeats until no runnable tasks remain

Currently only the `conservative` level is implemented (sequential, no parallelism). Other levels (`moderate`, `proactive`, `full`) log a warning and fall back to conservative. The `--level` flag overrides `config.auto.defaultLevel`.

The function is exported as `autoCommand()` for testability. CLI flags `--merge`/`--no-merge` are forwarded to `runCompletionLoop` identically to the `run` command.

### Review Task Sync (externally merged branches)

When `onConfidence` is `pr` or `none`, or when merge fails, tasks land in `review` state. If the user then merges those branches manually (via GitHub, `git merge`, etc.), the tasks would otherwise stay in `review` forever. `syncReviewTasks()` in `src/sync.ts` detects this and auto-promotes them to `done`.

**How it works:** For all `review`-state tasks that have a `branch` recorded, it runs a batch check via `getMergedOrGoneBranches()` in `src/git.ts`:
- Calls `git branch --format "%(refname:short)"` once to get all local branches
- Calls `git branch --merged <base> --format "%(refname:short)"` once to get all merged branches
- Returns two sets: `merged` (branch exists but is merged into base) and `gone` (branch no longer exists locally)
- Tasks in either set are promoted to `done`

This is O(2) git subprocesses regardless of how many review tasks exist. Called at the start of `statusCommand()` and `runCommand()`.

**Edge case:** A force-deleted (never-merged) branch will be detected as "gone" and the task promoted. The UI message distinguishes "branch merged" from "branch removed" so the user can spot this.

### Planning Memory

The system learns from its own history via `src/plan-memory.ts`. After a task reaches a terminal state (done or blocked), a short memory entry is appended to `.hootl/planning-patterns.md` summarizing what worked or went wrong. Before planning, the last ~20 entries plus aggregate metrics are injected into the plan prompt as "Lessons from Previous Tasks".

- **Entry generation** (`generateMemoryEntry`) — Pure analysis of task state, attempt count, and blocker messages. No Claude call. Pattern-matches on common blocker types (budget, confidence regression, max attempts) to produce actionable insights.
- **Rotation** — File capped at 50 entries (FIFO). Oldest entries age out naturally via `appendMemoryEntry`.
- **Metrics** (`computeMetrics`) — Parses entries to compute: average attempts per task, completion rate, top 3 blocker reasons.
- **Prompt injection** (`formatPlanningMemoryContext`) — Called in `planCommand()` after context gathering. Appends metrics summary + recent patterns to the context block, affecting all 4 planning modes equally.
- **Failure safety** — All memory operations are wrapped in try/catch. Memory recording never crashes the completion loop or blocks planning.

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

Key defaults: perSession=$0.50, perTask=$5.00, global=$50.00, maxAttempts=10, confidenceTarget=95%. `git.onConfidence` defaults to null (inferred from `auto.defaultLevel`). Env var: `HOOTL_GIT_ON_CONFIDENCE`. `git.useWorktrees` defaults to `false`. Env var: `HOOTL_GIT_USE_WORKTREES`. `notifications.webhook` — webhook URL for state transition notifications (default: null). Env var: `HOOTL_NOTIFICATIONS_WEBHOOK`.

### Hooks & Skills

Hooks run at trigger points in the completion loop. Skills are named prompt templates in the skill registry (`src/hooks.ts`). Configure hooks in `.hootl/config.json`:

```json
{
  "hooks": [
    {
      "trigger": "on_confidence_met",
      "skill": "simplify",
      "blocking": true
    }
  ]
}
```

Available triggers: `on_confidence_met`, `on_review_complete`, `on_blocked`, `on_execute_start`.

Built-in skills: `simplify` (runs `git diff <baseBranch>..HEAD`, reviews changed code for reuse/quality/efficiency, fixes issues, runs tests). Uses the `templates/validate-simplify.md` template with variable substitution (`{{baseBranch}}`, `{{taskTitle}}`, `{{taskDescription}}`, `{{branchName}}`). Falls back to an inline prompt if the template file cannot be read. Skill definitions may be async (e.g. for file I/O); `runSkillHook` awaits them.

**Default simplify hook**: When no hooks are configured (`config.hooks` is empty), `handleConfidenceMet()` injects a default `{ trigger: "on_confidence_met", skill: "simplify", blocking: true }` hook. This ensures every task that reaches confidence target gets a code quality review before merging. To disable, configure an explicit hook list (even an empty one won't work — use a no-op advisory hook or set a custom `on_confidence_met` hook).

**Hook result JSON schema**: Hooks can output either the old format (`pass`, `remediationActions`) or the new format (`passed`, `confidence`, `fixes_applied`). `parseHookResult` accepts both, with new field names taking precedence when both are present.

Optional fields: `conditions.minConfidence` (number), `prompt` (inline string or file path, used if no `skill`).

When `blocking: true`, a hook failure at `on_confidence_met` keeps the task `in_progress` for another attempt (rather than transitioning). Advisory hooks (`blocking: false`) log warnings but don't block.

Hook integration in the completion loop (`src/loop.ts`):
- **`on_execute_start`** — fired before Phase 2 (execute). Fire-and-forget; errors are caught and logged.
- **`on_review_complete`** — fired after Phase 3 review parsing and confidence update. Fire-and-forget.
- **`on_confidence_met`** — fired inside `handleConfidenceMet()` before merge/PR/state-transition. When no hooks are configured, the default simplify hook runs here as a blocking validator. Blocking failures return `in_progress` so the task gets another attempt.
- **`on_blocked`** — fired before each blocked-state transition (budget, max attempts, confidence regression, review blockers). Fire-and-forget via `moveToBlocked()` helper.

All hook calls receive a `HookContext` with task, branch info, confidence, and config. Hook costs are logged by `runHooks` with phase label `hook:<trigger>`. `HookDeps` provides injectable dependencies for testing: `invoke`, `log`, `warn`, and optional `commit` (used by the re-verification loop to avoid real git commits during tests).

### Task State Machine

```
proposed --> ready --> in_progress --> review --> done
                          |              |
                          |              +--> done (auto-sync: branch merged/deleted externally)
                          |
                          +--> blocked (budget, max attempts, branch-switch failure, or review blockers)
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
hootl init --template <name>   Initialize with preset config (web-app, cli-tool, library)
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
hootl auto                     Autonomous mode — run tasks until queue drains or budget exhausted
hootl auto --level <level>     Automation level (conservative|moderate|proactive|full; default from config)
hootl auto --merge             Force auto-merge on confidence met
hootl auto --no-merge          Disable auto-merge/PR on confidence met
hootl status                   View tasks grouped by state
hootl clarify                  Resolve blockers on blocked tasks
hootl discuss [taskId]         Launch interactive Claude session, optionally with task context
hootl hooks add                Interactively add a new hook to the project config
hootl hooks list               List all configured hooks
hootl hooks remove [index]     Remove a hook from project config (1-based index or interactive)
hootl hooks test --skill <name>  Test a hook against the current branch (real Claude invocation)
hootl hooks test --prompt <text> Test a hook with an inline prompt or file path
hootl hooks test ... --confidence <n>  Set confidence value for hook context (default: 95)
hootl hooks test ... --dry-run   Show resolved prompt without invoking Claude
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
- **invoke-robustness.test.ts** -- Timeout handling, `is_error` detection, edge cases, `isTransientError` detection (timeout exit code, rate limit, 429, ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ECONNRESET, success bypass, non-transient bypass, case insensitivity), retry constants and backoff pattern verification
- **local-backend.test.ts** -- Task CRUD, filtering, atomic writes
- **loop.test.ts** -- Review JSON parsing (inline, code-block, nested, remediationPlan), prompt building, preflight integration (understanding.md in execute prompt), confidence regression detection, global budget integration, preflight subtask priority parsing, too_broad subtask auto-creation (priority inheritance, ready state, parent ready with dependencies, understanding.md cleanup, dependency accumulation), handleConfidenceMet hook integration (blocking failure returns in_progress without state update, context forwarding, cost logging with trigger label, re-verification on fixes_applied with above-target confidence, re-verify confidence drop returns in_progress with remediation plan, re-verification capped at MAX_REVERIFICATIONS, no re-verification when no fixes_applied, re-verify auto-commits hook changes via hookDeps.commit, re-verify cost logged with re-verify phase label), fireHooks (context propagation, no-op on empty hooks, error swallowing), moveToBlocked (on_blocked hook firing, error resilience, blocker forwarding)
- **git.test.ts** -- Slugify edge cases, branch name construction, getHeadSha, resetToSha rollback, getMergedOrGoneBranches (gone, merged, unmerged, mixed batch, empty input), generateCommitMessage (Claude-generated with prefix, whitespace stripping, fallback on throw/empty, diff truncation, multi-line enforcement, 120-char cap, stat summary in prompt, phase in fallback), commitTaskChanges (DI-based diff capture, fallback on failure, no-op on clean, explicit message bypass), createWorktree (new branch, existing branch, reuse existing path), removeWorktree (removes existing, no-op on missing), worktreeExists (valid worktree, non-existent path, non-worktree directory), git operations with cwd (commitTaskChanges via worktree, getHeadSha/resetToSha via worktree)
- **sync.test.ts** -- Review task sync: branch merged+deleted promotes to done, branch merged but exists promotes to done, unmerged branch stays review, null branch skipped, no review tasks returns 0
- **discuss.test.ts** -- buildDiscussArgs, system prompt construction, section ordering
- **dependencies.test.ts** -- Dependency inference (explicit indices, heuristic fallback, cycle detection, out-of-range filtering), keyword extraction, index-to-ID resolution
- **guided.test.ts** -- Clarification prompt building, question JSON parsing (valid, malformed, capped), constraints formatting, edge cases
- **plan-memory.test.ts** -- Memory entry generation (success/blocked variants, blocker categorization, truncation), append/rotation (50-entry cap, FIFO), pattern loading (recent count, empty file), metrics computation (averages, completion rate, blocker reasons), prompt formatting
- **preflight.test.ts** -- Template existence, role declaration, verdict values, JSON output fields, no-implementation constraints, bug reproduction instructions, scope assessment
- **extract-tasks.test.ts** -- JSON array extraction from Claude plan responses: clean JSON, markdown code blocks (with/without json tag), preamble text, [bracketed] prose after JSON (the original bug), [bracketed] prose before JSON, escaped quotes in descriptions, nested dependsOn arrays, null cases (empty string, no JSON, empty array, non-array)
- **plan-review.test.ts** -- Critique prompt building (goal inclusion, task JSON, indices, dependsOn), task parsing (valid, markdown-wrapped, missing fields, non-integer deps), fallback on invalid input
- **plan-summary.test.ts** -- Summary generation (single/multiple/many tasks, truncation), priority counting (mixed, default-to-medium), empty array, priority ordering
- **hooks.test.ts** -- Trigger filtering (condition evaluation, minConfidence), prompt resolution (inline vs file path, fallback), result parsing (JSON extraction, brace-matching, graceful degradation, new field aliases: passed/fixes_applied/confidence), system prompt construction, runHook integration (pass/fail, cost, context forwarding), runHooks orchestration (blocking short-circuit, advisory continues, cost logging, trigger filtering), validate-simplify template (existence, content markers, variable substitution), buildTestHookContext (synthetic task defaults, parameter passthrough, config forwarding, ISO timestamps, edge confidence values), formatHookLabel (skill/prompt display, truncation, 1-based numbering, skill precedence), validateRemoveIndex (valid/invalid/boundary indices, NaN, empty list, single-hook), saveProjectConfig (hooks splice, last-hook removal, empty config, JSON formatting), hooks add config mutation (append to existing array, create array when absent, conditions with minConfidence, preserve existing config keys), HOOK_TRIGGERS export (values, HookSchema acceptance)
- **prioritize.test.ts** -- userPriority schema backward compat, sort order (userPriority before auto), dependency enforcement (findRunnableTask)
- **checkpoint.test.ts** -- Checkpoint write (valid JSON, atomic overwrite, error resilience), read (valid file, missing file, invalid JSON, missing fields, wrong types), clear (removes file, no-op if missing), round-trip (write+read, clear+read)
- **auto-init.test.ts** -- Init directory creation, no-op on existing, config defaults, interactive hook prompt (accept/decline), hooks-example.json content, template presets (web-app lower confidence + agent-browser hook, cli-tool standard defaults, library higher confidence + more attempts), unknown template rejection, template hook prompt skipping, TEMPLATE_NAMES export
- **auto.test.ts** -- Auto command task selection loop (empty queue, sequential picks, in_progress preference, dependency skipping), budget gate (exceeded stops, headroom continues, missing CSV), level validation (all four levels accepted by config schema)
- **branch-block.test.ts** -- Integration test: dirty worktree blocks task on branch switch (real git repo), dirty worktree does NOT block in worktree mode (isolation verification), clean worktree proceeds past branch creation
- **notify.test.ts** -- OS notification: config gating (osNotify false → no-op), platform detection (darwin → osascript, linux → notify-send, win32 → no-op), error resilience (execa failure swallowed), osascript quote/backslash escaping, linux raw passthrough. Webhook: no-op on null/empty webhook URL, correct POST payload and headers, error resilience (fetch throw, non-2xx), null confidence handling

## Dependencies

- **commander** -- CLI framework
- **execa** -- subprocess execution (for `claude -p`)
- **zod** -- schema validation
