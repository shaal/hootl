# hootl Architecture

Detailed architecture documentation for the hootl autonomous task completion engine. For quick-start info, see the root [CLAUDE.md](../CLAUDE.md).

## Completion Loop (Phase 0 + 3-Phase Attempts)

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

**Context window exceeded**: After the plan phase, if `contextWindowPercent >= budgets.contextWindowLimit` (default 60%), the attempt restarts (plan is already saved to disk, so no work lost). There is intentionally **no** context window check after the execute phase — the review must always run. Each phase is a separate `claude -p` call with a fresh context window, so execute's usage doesn't affect review quality. Skipping review would create a plan→execute loop with no confidence evaluation, where the task can only exit via budget exhaustion.

Context bridges between fresh `claude -p` calls via files in `.hootl/tasks/<id>/`: `understanding.md`, `plan.md`, `progress.md`, `test_results.md`, `blockers.md`, `last_confidence.txt`, `checkpoint.json`.

## Crash Recovery

On restart, the loop detects interrupted phases via `checkpoint.json` in the task directory. Before each phase (preflight, plan, execute, review), `writeCheckpoint()` atomically writes the current phase name and attempt number. On resume:

- `readCheckpoint()` detects the interrupted phase and logs a recovery message
- If the execute phase was interrupted, `hasUncommittedChanges()` checks for leftover changes and auto-commits them with a recovery message (appended to `progress.md`). In worktree mode, `task.worktree` is used as `cwd` for these operations.
- If a plan exists from an interrupted execute/review phase, the log notes it will skip re-planning
- The stale checkpoint is cleared before the loop writes fresh ones
- `clearCheckpoint()` runs on normal exit to clean up

All checkpoint operations are wrapped in try/catch — checkpoint failures never block the loop. Uses the same atomic tmp + rename pattern as `local.ts`.

## Task Claiming (Parallel Instance Safety)

When two `hootl auto` (or `hootl run`) instances run simultaneously, a file-based atomic claim mechanism prevents them from picking the same task.

**Claim file:** `.hootl/tasks/<id>/.claim` — created with `fs.writeFileSync(..., { flag: 'wx' })` (POSIX `O_EXCL`, atomic exclusive create). Contains `{ pid: number, startedAt: string }`.

**`claimTask(id): Promise<boolean>`** — On `TaskBackend` interface, implemented in `LocalTaskBackend`. Attempts the exclusive create; returns `true` on success (also transitions task to `in_progress`), `false` on conflict. Before returning `false` on `EEXIST`, reads the existing claim's PID and checks liveness via `process.kill(pid, 0)`. If the PID is dead (stale claim from a crashed instance), removes the file and retries once.

**`releaseTask(id): Promise<void>`** — Removes the `.claim` file. No-op if already absent.

**Task selection:** `findAndClaimTask()` in `src/selection.ts` iterates candidates (checking dependencies first), then calls `claimTask`. If the claim fails, the task is skipped with reason `"claimed by another instance"` and the next candidate is tried. Used by `selectFromState()` in `src/index.ts`. For explicit `hootl run <taskId>`, `claimTask` is called directly and the command aborts if the claim fails.

**Release points:**
- End of `runCompletionLoop` (after checkpoint cleanup, covers all terminal states: done, blocked, review)
- Early returns in `runCompletionLoop` (preflight verdicts: too_broad, unclear, cannot_reproduce; branch-switch failures)
- Process exit handlers: `process.on('exit')`, `process.on('SIGINT')`, `process.on('SIGTERM')` — synchronous `unlinkSync` cleanup of all claims tracked in a module-level `Set<string>`

**Known limitations:** `O_EXCL` is atomic on local POSIX filesystems but not guaranteed on NFS. PID reuse is theoretically possible but extremely unlikely given the large PID space.

## Git Worktree Mode

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

**Git functions with `cwd` support:** `commitTaskChanges`, `getHeadSha`, `resetToSha`, `hasUncommittedChanges`, `pushBranch`, `mergeBranch`, `deleteBranch`, `generateCommitMessage`, `getCurrentBranch`, `ensureBranch`. All default to `undefined` (current directory) for backward compatibility.

**Targeted staging:** `commitTaskChanges` accepts an optional `excludeFiles?: Set<string>` parameter. When provided, only files NOT in the set are staged (via `git add -- file1 file2 ...`). When omitted, existing `git add -A` behavior is preserved (backward compatible, safe for worktree mode). The `getDirtyFiles(cwd?)` helper in `src/git.ts` returns the set of dirty file paths from `git status --porcelain`, handling rename format (`R  old -> new`). In the completion loop, `preExistingDirty` is captured once after branch creation (non-worktree mode only) and passed to all `commitTaskChanges` calls except crash recovery (which should capture everything).

## Branch-Switch Safety (non-worktree mode only)

Before the loop begins, `runCompletionLoop` creates or switches to the task branch. If the branch switch fails (e.g., uncommitted changes would be overwritten), the task moves to `blocked` with a descriptive message and the loop returns immediately — no phases run on the wrong branch. The blocker message distinguishes dirty-worktree errors ("Commit or stash your changes") from other git failures. The user can resolve the issue and re-run. In worktree mode, this safety check is unnecessary since the main working tree is never modified.

## Branch Drift Guard (non-worktree mode only)

`claude -p` with `--dangerously-skip-permissions` can run `git checkout main` during execution, leaving the working tree on the wrong branch. Without correction, subsequent `commitTaskChanges` would commit directly to main — bypassing the review, hook, and merge gates entirely.

**Fix:** `ensureBranch(expected, cwd?)` in `src/git.ts` checks the current branch and switches back if drifted. In `runCompletionLoop`, a `guardBranch()` closure wraps this with error handling and is called after every `invokeClaude`/`runHooks` call in non-worktree mode. If drift is detected, it logs a warning and restores the task branch.

**Guard points (6):** after preflight, after plan, after on_execute_start hooks, before auto-commit (critical), after review, after on_review_complete hooks.

**Known gap:** Hooks inside `handleConfidenceMet` (the `on_confidence_met` simplify hook) invoke Claude but are not guarded — `guardBranch()` is a closure in `runCompletionLoop` and isn't passed into `handleConfidenceMet`. Worktree mode is immune to all branch drift since `cwd` isolates the worktree.

## Rollback Safety (confidence regression)

Before each Phase 2 (execute), the loop records the current git HEAD SHA via `getHeadSha()`. After Phase 3 (review), if confidence is lower than the previous attempt's confidence, the loop:

1. **Rolls back** -- `git reset --hard <saved-sha>` reverts the execute phase's changes
2. **Logs** -- Appends a "ROLLED BACK" entry to `progress.md` noting the regression
3. **Blocks** -- Moves the task to `blocked` state with a descriptive blocker message

Confidence is tracked across runs via `last_confidence.txt` in the task directory. The `isConfidenceRegression(current, previous)` helper returns `true` only when `previous !== null && current < previous` — first attempts and equal scores never trigger rollback.

Git helpers: `getHeadSha()` returns the 40-char HEAD SHA; `resetToSha(sha)` runs `git reset --hard`. Both are in `src/git.ts`.

## Auto-merge / Auto-PR on Confidence Met

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

## Autonomous Mode (`hootl auto`)

The `auto` command runs tasks sequentially until the queue drains or the global budget is exhausted. It wraps the same building blocks as `runCommand()`:

1. **Sync** — calls `syncReviewTasks()` to promote externally merged branches
2. **Budget gate** — calls `checkGlobalBudget()` and breaks if exceeded
3. **Task selection** — prefers `in_progress` tasks (resume), then `ready` tasks, both via `selectFromState()` which enforces dependencies
4. **Execution** — calls `runCompletionLoop()` which handles per-task budget, max attempts, blocking, and state transitions
5. **Loop** — repeats until no runnable tasks remain

Currently only the `conservative` level is implemented (sequential, no parallelism). Other levels (`moderate`, `proactive`, `full`) log a warning and fall back to conservative. The `--level` flag overrides `config.auto.defaultLevel`.

The function is exported as `autoCommand()` for testability. CLI flags `--merge`/`--no-merge` are forwarded to `runCompletionLoop` identically to the `run` command.

## Review Task Sync (externally merged branches)

When `onConfidence` is `pr` or `none`, or when merge fails, tasks land in `review` state. If the user then merges those branches manually (via GitHub, `git merge`, etc.), the tasks would otherwise stay in `review` forever. `syncReviewTasks()` in `src/sync.ts` detects this and auto-promotes them to `done`.

**How it works:** For all `review`-state tasks that have a `branch` recorded, it runs a batch check via `getMergedOrGoneBranches()` in `src/git.ts`:
- Calls `git branch --format "%(refname:short)"` once to get all local branches
- Calls `git branch --merged <base> --format "%(refname:short)"` once to get all merged branches
- Returns two sets: `merged` (branch exists but is merged into base) and `gone` (branch no longer exists locally)
- Tasks in either set are promoted to `done`

This is O(2) git subprocesses regardless of how many review tasks exist. Called at the start of `statusCommand()` and `runCommand()`.

**Edge case:** A force-deleted (never-merged) branch will be detected as "gone" and the task promoted. The UI message distinguishes "branch merged" from "branch removed" so the user can spot this.

## Planning Memory

The system learns from its own history via `src/plan-memory.ts`. After a task reaches a terminal state (done or blocked), a short memory entry is appended to `.hootl/planning-patterns.md` summarizing what worked or went wrong. Before planning, the last ~20 entries plus aggregate metrics are injected into the plan prompt as "Lessons from Previous Tasks".

- **Entry generation** (`generateMemoryEntry`) — Pure analysis of task state, attempt count, and blocker messages. No Claude call. Pattern-matches on common blocker types (budget, confidence regression, max attempts) to produce actionable insights.
- **Rotation** — File capped at 50 entries (FIFO). Oldest entries age out naturally via `appendMemoryEntry`.
- **Metrics** (`computeMetrics`) — Parses entries to compute: average attempts per task, completion rate, top 3 blocker reasons.
- **Prompt injection** (`formatPlanningMemoryContext`) — Called in `planCommand()` after context gathering. Appends metrics summary + recent patterns to the context block, affecting all 4 planning modes equally.
- **Failure safety** — All memory operations are wrapped in try/catch. Memory recording never crashes the completion loop or blocks planning.

## Remediation Plan Flow (confidence < target)

When the review phase scores confidence below the target, it does two additional things **in the same session** (while context is fresh):

1. **Updates documentation** -- Captures architectural decisions, patterns, and learnings in project docs (CLAUDE.md, README, inline comments)
2. **Writes a remediation plan** -- A concrete, actionable plan returned in the `remediationPlan` JSON field, written directly to `plan.md`

On the next attempt, the **plan phase is skipped** and the execute phase runs directly from the review's remediation plan. This avoids information loss at session boundaries -- the reviewer already knows exactly what's needed and prescribes it directly, rather than relying on a fresh planner to re-derive it.

The `hasRemediationPlan` flag in the loop controls plan-skipping. It resets to `false` after use and on transient errors to prevent stale plans from persisting.

## Global Daily Budget Enforcement

The global daily budget ($50.00 default) prevents runaway spend across all tasks. It is checked at two points:

1. **Pre-run gate** (`src/index.ts` → `runCommand()`) -- Before selecting a task, reads `.hootl/logs/cost.csv`, sums today's entries, and refuses to start if `>= budgets.global`. Prints an error and returns.
2. **Mid-loop gate** (`src/loop.ts` → `runCompletionLoop()`) -- At the top of each while-loop iteration (alongside the per-task budget check), re-reads the CSV. If the global budget is hit during execution, the current task moves to `blocked` with the blocker `"Global daily budget exhausted"`.

Cost data comes from `logCost()` in `src/invoke.ts`, which appends to `cost.csv` after each phase. Both writer (`toISOString()`) and reader (`toISOString().slice(0,10)`) use UTC for consistent daily boundaries. The budget logic lives in `src/budget.ts` with three functions: `getTodaysCost()`, `isGlobalBudgetExceeded()`, and `checkGlobalBudget()`.

## Config Hierarchy

Three layers, merged with deep-merge (later wins):
1. `~/.hootl/config.json` (global)
2. `.hootl/config.json` (project)
3. `HOOTL_*` environment variables

Key defaults: contextWindowLimit=60%, perTask=$5.00, global=$50.00, maxAttempts=10, confidenceTarget=95%. `git.onConfidence` defaults to null (inferred from `auto.defaultLevel`). Env var: `HOOTL_GIT_ON_CONFIDENCE`. `git.useWorktrees` defaults to `false`. Env var: `HOOTL_GIT_USE_WORKTREES`. `notifications.webhook` — webhook URL for state transition notifications (default: null). Env var: `HOOTL_NOTIFICATIONS_WEBHOOK`.

## Hooks & Skills

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

**Hook result JSON schema**: Hooks can output either the old format (`pass`, `remediationActions`) or the new format (`passed`, `confidence`, `fixes_applied`). `parseHookResult` accepts both, with new field names taking precedence when both are present. Uses a multi-candidate extraction strategy: (1) code-block regex, (2) reverse brace-matching from last `}`, (3) forward brace-matching from first `{`. The first candidate that parses as valid JSON wins. Reverse matching is critical because hooks (especially simplify) produce prose/code with curly braces before the result JSON at the end. When no candidates parse successfully, defaults to `pass: false` (fail-closed). **Diagnostic logging**: `runSkillHook` logs a warning with the output length and last 300 chars when parsing fails with no issues or remediation — this surfaces what Claude actually said instead of the opaque "no details provided" blocker.

Optional fields: `conditions.minConfidence` (number), `prompt` (inline string or file path, used if no `skill`).

When `blocking: true`, hook behavior at `on_confidence_met` depends on whether fixes were applied:
- **Failure with fixes** (`remediationActions` non-empty): keeps task `in_progress` for another attempt (the fixes may resolve the issue on retry)
- **Failure without fixes** (empty `remediationActions`): moves task to `blocked` via `moveToBlocked()` (retrying identical code won't change the outcome)
- **Hook execution error** (exception): moves task to `blocked` (errors are typically not self-healing)

Advisory hooks (`blocking: false`) log warnings but don't block.

Hook integration in the completion loop (`src/loop.ts`):
- **`on_execute_start`** — fired before Phase 2 (execute). Fire-and-forget; errors are caught and logged.
- **`on_review_complete`** — fired after Phase 3 review parsing and confidence update. Fire-and-forget.
- **`on_confidence_met`** — fired inside `handleConfidenceMet()` before merge/PR/state-transition. When no hooks are configured, the default simplify hook runs here as a blocking validator. Blocking failures with fixes return `in_progress` (retry); failures without fixes or errors move task to `blocked` (no point retrying identical code).
- **`on_blocked`** — fired before each blocked-state transition (budget, max attempts, confidence regression, review blockers). Fire-and-forget via `moveToBlocked()` helper.

All hook calls receive a `HookContext` with task, branch info, confidence, and config. Hook costs are logged by `runHooks` with phase label `hook:<trigger>`. `HookDeps` provides injectable dependencies for testing: `invoke`, `log`, `warn`, and optional `commit` (used by the re-verification loop to avoid real git commits during tests).

## Task State Machine

```
proposed --> ready --> in_progress --> review --> done
                          |              |
                          |              +--> done (auto-sync: branch merged/deleted externally)
                          |
                          +--> blocked (budget, max attempts, branch-switch failure, or review blockers)
                          |       |
                          +-------+ (human resolves via `hootl clarify`)
```

## Task Selection & Priority

Tasks have two priority fields: `priority` (planner-assigned: critical/high/medium/low) and `userPriority` (user override: number or null). Sort order for `listTasks()`:
1. `userPriority` non-null first, ascending (1 before 2)
2. `priority` (critical→low)
3. `createdAt`

When `hootl run` selects the next task, it enforces dependencies: a task is skipped if any of its `dependencies` are not in `done` or `review` state. The logic lives in `findRunnableTask()` in `src/selection.ts`.

## CLI Commands

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

## Plan Command Context Gathering

The plan command gathers project context via `src/context.ts` before calling Claude:

- **File references** (not content) for `docs/spec.md`, `README.md`, `CLAUDE.md` -- Claude reads these itself via tools
- **Source file listing** -- `find src -type f -name "*.ts"` for project structure
- **Existing tasks** -- formatted summary from the task backend
- **Recent git log** -- last 20 commits (one-line format)

This keeps prompts small (~2K chars) while giving Claude full access to explore the codebase. The "From spec" mode compares the spec against existing code to generate gap-filling tasks with priorities.

## Auto-detected Task Dependencies

When the planner generates a batch of tasks, dependencies are automatically wired up via a two-pass process in `planCommand()`:

1. **Planner prompts** request a `dependsOn` field — an optional array of 0-based indices referencing other tasks in the same batch (e.g., `"dependsOn": [0, 2]`).
2. **`inferDependencies()`** in `src/dependencies.ts` processes the batch: uses Claude's explicit `dependsOn` when provided, falls back to heuristic keyword matching (scanning descriptions for references to other task titles) when omitted. Circular dependencies are detected and removed via DFS.
3. **Two-pass creation**: all tasks are created first (collecting `index → id` mapping), then dependencies are wired via `backend.updateTask()` in a second pass using `resolveIndicesToIds()`.

The existing `findRunnableTask()` in `src/selection.ts` enforces these dependencies at runtime — tasks whose dependencies aren't in `done` or `review` state are skipped.

## Planning Philosophy: Concrete First

The plan system prompt (`templates/plan.md`) enforces two key constraints:

1. **Concrete first** -- Task 1 must deliver the specific thing the user asked for, even if hardcoded. Abstraction and generalization come in later tasks. This prevents the planner from jumping to framework design before solving the actual problem.
2. **Plan size scrutiny** -- Plans exceeding 5-6 tasks should be questioned. Large plans often indicate premature abstraction. Tasks that only serve generalization or future-proofing should be pushed to the end or dropped.

## Plan Self-Review (Critique Pass)

After the planner generates tasks, a second `claude -p` call critiques the plan before writing tasks to disk (`src/plan-review.ts`). The critique checks:

1. Does every task map to something the user asked for?
2. Is the plan over-engineered (abstractions before concrete delivery)?
3. Did the planner miss specific things the user mentioned?
4. Should any tasks be merged or split?

The critique returns a revised task list (or the original unchanged). If the critique call fails or returns unparseable output, the original plan is used — graceful degradation, never destructive.

- **Cost**: ~$0.05 per critique call
- **Skip with**: `--no-critique` flag on the plan command
- **Integration point**: Called after initial plan JSON parsing, before `inferDependencies()`
