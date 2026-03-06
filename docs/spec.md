# hootl — Human Out Of The Loop

## Specification v1.0

### Vision

hootl is an autonomous task completion engine that keeps projects moving forward without requiring constant human attention. It calls `claude -p` in structured loops to plan, execute, and verify work — only escalating to a human when genuinely stuck. Tasks that hit blockers don't stall the pipeline; they park themselves and the system moves on to the next item.

### Core Principles

1. **Human time is precious** — only ask when the alternative is worse
2. **Fresh context, always** — each `claude -p` call starts clean; knowledge bridges via files, not memory
3. **Test-anchored confidence** — self-assessment alone can't reach 95%; real test results are required
4. **Tasks are independent** — one blocked task never blocks another
5. **Progressive autonomy** — from conservative to full autopilot, the human chooses the level

---

## Architecture

### Language & Runtime

- **TypeScript** (strict mode, ESM, no `any`)
- **Node.js** runtime
- Dependencies (MVP): `commander`, `execa`, `zod`
- Additional dependencies added only when a feature demands them

### Interface

Three access modes:

1. **Interactive TUI** — `hootl` with no subcommand launches an interactive menu via `gum`
2. **CLI subcommands** — `hootl plan`, `hootl run`, `hootl clarify`, `hootl auto`, etc.
3. **Autonomous mode** — `hootl auto` picks what to do based on project state

All functionality is available through both TUI and CLI — the TUI is sugar, not a gate.

### CLI Commands

```
hootl                     # Interactive TUI menu
hootl init [--template]   # Initialize .hootl/ in current project
hootl plan                # Enter planning mode
hootl run                 # Run next ready task (or specific task by ID)
hootl status              # Show all tasks and their states
hootl clarify             # Show blocked tasks needing human input
hootl auto [--level]      # Autonomous mode (conservative|moderate|proactive|full)
hootl config              # View/edit configuration
```

### Autonomous Mode Levels

| Level | Behavior |
|-------|----------|
| `conservative` | Only works on tasks in "ready" state, never creates new tasks |
| `moderate` | Works on ready tasks; if queue empty, scans for obvious improvements (failing tests, TODOs, outdated docs) and creates tasks |
| `proactive` (default) | Like moderate, but also proposes new feature tasks based on codebase analysis. Auto-created tasks start in "proposed" state for human review |
| `full` | Works on everything, creates and executes improvement tasks, stops only when budget runs out or all tasks are at 95% |

---

## Directory Structure

### Per-Project: `.hootl/`

```
.hootl/
  config.json              # Project config (committed to git)
  .gitignore               # Auto-generated: ignores tasks/, logs/
  tasks/                   # Task work directories (gitignored)
    task-001/
      task.json            # Task metadata & state
      plan.md              # Current execution plan
      progress.md          # Session-by-session progress log
      test_results.md      # Latest test outcomes
      blockers.md          # Questions/blockers for human
    task-002/
      ...
  logs/                    # Cost logs, session logs (gitignored)
    cost.csv
    sessions.log
  status.md                # Human-readable summary of all tasks (gitignored)
```

### Global: `~/.hootl/`

```
~/.hootl/
  config.json              # Global defaults
```

### Configuration Hierarchy

`~/.hootl/config.json` < `.hootl/config.json` < environment variables

### Config Schema

```json
{
  "taskBackend": "local",
  "budgets": {
    "perSession": 0.50,
    "perTask": 5.00,
    "global": 50.00,
    "maxAttemptsPerTask": 10
  },
  "confidence": {
    "target": 95,
    "requireTests": true
  },
  "git": {
    "useWorktrees": false,
    "autoPR": true,
    "branchPrefix": "hootl/"
  },
  "auto": {
    "defaultLevel": "proactive",
    "maxParallel": 1
  },
  "hooks": [
    {
      "trigger": "on_confidence_met",
      "skill": "simplify",
      "blocking": true,
      "conditions": { "minConfidence": 90 }
    }
  ],
  "notifications": {
    "terminal": true,
    "osNotify": false,
    "summaryFile": true,
    "webhook": null
  },
  "permissionMode": "default"
}
```

Environment variable overrides follow the pattern: `HOOTL_BUDGET_PER_SESSION=1.00`, `HOOTL_AUTO_LEVEL=full`, etc.

---

## Task Lifecycle

### Task States

```
proposed → ready → in_progress → review → done
                 ↘ blocked ↗       ↘ blocked ↗
```

| State | Meaning |
|-------|---------|
| `proposed` | Auto-created by autonomous mode, awaiting human approval |
| `ready` | Approved and queued for execution |
| `in_progress` | Currently being worked on |
| `review` | Confidence hit 95%, draft PR created, awaiting human review |
| `blocked` | Needs human input — budget exceeded, max attempts reached, unclear requirements, or tests can't pass |
| `done` | Completed and merged |

### Task Schema (`task.json`)

```json
{
  "id": "task-001",
  "title": "Add input validation to user form",
  "description": "...",
  "priority": "high",
  "state": "ready",
  "dependencies": [],
  "backend": "local",
  "backendRef": null,
  "confidence": 0,
  "attempts": 0,
  "totalCost": 0,
  "branch": null,
  "worktree": null,
  "blockers": [],
  "createdAt": "2026-03-05T10:00:00Z",
  "updatedAt": "2026-03-05T10:00:00Z"
}
```

---

## Task Queue & Prioritization

The smart queue determines execution order:

1. **Priority ranking** — critical > high > medium > low
2. **Dependency resolution** — a task with unmet dependencies cannot be "ready"
3. **Effort estimation** — within the same priority, Claude estimates relative effort; configurable strategy:
   - `quick-wins-first` (default for autonomous mode)
   - `big-items-first`
   - `fifo`

Independent tasks can run in parallel up to the `maxParallel` limit, each in its own git worktree.

---

## Completion Loop (The Core Engine)

When a task moves to `in_progress`, hootl runs a 3-phase loop:

### Phase 1: Plan (fresh `claude -p` session)

**Input:** task description, `blockers.md`, `progress.md` (if resuming), codebase context
**Output:** `plan.md` — a concrete, step-by-step plan to reach 95% confidence
**Prompt strategy:** Use subagents for codebase exploration; main context stays lean

### Phase 2: Execute (fresh `claude -p` session)

**Input:** `plan.md`, task description, relevant source files
**Output:** Code changes, test additions/fixes, updated `progress.md`
**Prompt strategy:** Execute the plan. Use subagents for file exploration, test running, and agent-browser testing. Main session focuses on code changes.
**Documentation:** Docs are updated continuously as part of execution — not a separate phase.

### Phase 3: Review (fresh `claude -p` session)

**Input:** `git diff` of changes, `test_results.md`, `progress.md`, task description
**Output:** Confidence score (0-100), updated `test_results.md`, optionally updated `blockers.md`
**Rules:**
- Confidence MUST be backed by test results — self-assessment alone cannot exceed 80
- If web app detected: agent-browser test results required to score above 85
- If confidence >= 95: task moves to `review` state, draft PR is created
- If confidence < 95 and attempts < max: loop back to Phase 1
- If confidence < 95 and attempts >= max: task moves to `blocked`
- If confidence < 95 and budget exceeded: task moves to `blocked`

### Rollback Safety

Before each Phase 2 (execute), hootl records the current git state. If after execution:
- Tests that were passing before are now failing
- The review phase scores lower than the previous attempt

Then hootl automatically rolls back the changes (`git checkout` on the worktree/branch) and logs the failure in `progress.md`. The task moves to `blocked` with context about what went wrong.

### Hooks & Skills

Hooks are trigger-point callbacks that run `claude -p` calls at specific moments in the completion loop. They enable automated code quality checks, security scans, lint validation, and custom workflows without modifying the core loop.

#### Trigger Points

| Trigger | When it fires | Behavior |
|---------|--------------|----------|
| `on_execute_start` | Before Phase 2 (execute) | Fire-and-forget; errors caught and logged |
| `on_review_complete` | After Phase 3 review parsing | Fire-and-forget; errors caught and logged |
| `on_confidence_met` | Inside `handleConfidenceMet()`, before merge/PR/state-transition | Blocking failures keep task `in_progress` for another attempt |
| `on_blocked` | Before each blocked-state transition | Fire-and-forget via `moveToBlocked()` helper |

#### Configuration Format

Hooks are configured in the `hooks` array in `.hootl/config.json`:

```json
{
  "hooks": [
    {
      "trigger": "on_confidence_met",
      "skill": "simplify",
      "blocking": true,
      "conditions": {
        "minConfidence": 90
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trigger` | string | yes | One of the four trigger points above |
| `skill` | string | no | Named skill from the built-in registry (e.g. `"simplify"`) |
| `prompt` | string | no | Inline prompt text or file path (used when no `skill` is set) |
| `blocking` | boolean | no | Whether hook failure prevents state transition (default: `false`) |
| `conditions.minConfidence` | number | no | Hook only runs if current confidence >= this value |

Either `skill` or `prompt` must be provided. If both are present, `skill` takes precedence.

#### Blocking vs Advisory Semantics

- **Blocking** (`blocking: true`) — A hook failure at `on_confidence_met` keeps the task `in_progress` for another attempt rather than transitioning to `done`/`review`. This is the gate-keeping pattern: code must pass the hook's criteria before merging.
- **Advisory** (`blocking: false`) — Hook failures are logged as warnings but do not block the state transition. Useful for telemetry, notifications, or non-critical checks.

#### Built-in `simplify` Skill

The `simplify` skill is the only built-in skill. It reviews all changed code on the task branch for reuse opportunities, code quality issues, and efficiency improvements:

1. Runs `git diff <baseBranch>..HEAD` to get the full changeset
2. Reviews the diff for: duplicated logic, unnecessary complexity, missing error handling, opportunities to reuse existing code
3. Applies fixes directly (not just suggestions)
4. Runs the project's test suite to verify fixes don't break anything

Uses the `templates/validate-simplify.md` template with variable substitution (`{{baseBranch}}`, `{{taskTitle}}`, `{{taskDescription}}`, `{{branchName}}`). Falls back to an inline prompt if the template file cannot be read.

#### Default Hook Behavior

When no hooks are configured (`config.hooks` is empty), `handleConfidenceMet()` automatically injects a default blocking `simplify` hook:

```json
{ "trigger": "on_confidence_met", "skill": "simplify", "blocking": true }
```

This ensures every task that reaches the confidence target gets a code quality review before merging. To use a different hook instead, configure an explicit `hooks` array.

#### Re-verification Loop

When an `on_confidence_met` hook applies fixes (`fixes_applied` is non-empty in the hook result), the system enters a re-verification loop:

1. Auto-commits the hook's changes
2. Re-runs Phase 3 (review) to get an updated confidence score
3. If confidence is still >= target, re-runs hooks to check for more fixes
4. If confidence dropped below target, writes a remediation plan to `plan.md` and returns the task to `in_progress`

The loop is capped at 2 re-verifications (`MAX_REVERIFICATIONS`) to prevent infinite hook↔review cycles.

#### Hook Result JSON Schema

Hooks output a JSON result. Two formats are accepted (new field names take precedence when both are present):

```json
{
  "pass": true,
  "remediationActions": [],

  "passed": true,
  "confidence": 95,
  "fixes_applied": []
}
```

#### Hook Context

All hook calls receive a `HookContext` containing: task metadata, branch info, current confidence score, and the full config. Hook costs are logged with the phase label `hook:<trigger>`.

#### CLI Management

```
hootl hooks add                    # Interactively add a new hook
hootl hooks list                   # List all configured hooks
hootl hooks remove [index]         # Remove a hook (1-based index or interactive)
hootl hooks test --skill <name>    # Test a hook against the current branch
hootl hooks test --prompt <text>   # Test with an inline prompt or file path
hootl hooks test ... --dry-run     # Show resolved prompt without invoking Claude
```

---

## Web Application Testing

### Auto-Detection

hootl scans the project for web framework markers:
- `package.json` with React, Next.js, Vue, Angular, Svelte, etc.
- `requirements.txt` / `pyproject.toml` with Flask, Django, FastAPI
- `Gemfile` with Rails
- Other common web framework config files

When detected, agent-browser CLI becomes available for confidence scoring.

### Per-Session Decision

Claude decides each session whether browser testing would help raise confidence. Common triggers:
- UI component changes
- Route/page additions
- Form validation logic
- Visual regression concerns

### Integration

agent-browser is invoked as a subagent tool during Phase 2 (execute) and Phase 3 (review). Results are captured in `test_results.md`.

---

## Planning Mode

When the user enters planning mode (`hootl plan` or via TUI), Claude offers three approaches:

1. **Analyze codebase** — scan the project structure, README, docs, tests, and propose tasks for improvements, missing tests, TODOs, etc.
2. **Break down a goal** — human describes a high-level objective, Claude decomposes it into concrete tasks with dependencies
3. **Suggest what's next** — Claude looks at existing tasks, recent git history, and project state to recommend priorities

Tasks are created in the configured backend. For local md, they're written to `.hootl/tasks/`. For GitHub Issues, they're created via the API. For Beads, they go through `bd`/`br`.

---

## Blocker / Clarification Flow

When a task is blocked, hootl:

1. Writes structured questions to `blockers.md` in the task directory
2. Updates `task.json` state to `blocked`
3. Moves to the next ready task in the queue
4. Updates `status.md` with the blocker summary

When the human runs `hootl clarify` (or selects it from TUI):
- All blocked tasks are listed with their questions
- Questions are presented as multiple-choice where possible
- Human answers are written back to the task's `blockers.md`
- Task state returns to `ready`

---

## Task Backend Interface

```typescript
interface TaskBackend {
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  sync?(): Promise<void>;  // For backends that need syncing (e.g., GitHub Issues)
}
```

### Built-in Backends

| Backend | Storage | When to use |
|---------|---------|-------------|
| `local` | `.hootl/tasks/` markdown + JSON | Default, works offline, zero setup |
| `github` | GitHub Issues via API | Team collaboration, visibility |
| `beads` | Beads system (`bd`/`br`) | Projects already using beads |

Configured via `taskBackend` in config. The interface is documented for users to implement custom backends.

---

## Git Workflow

### Branch Strategy

Each task gets its own branch: `hootl/<task-id>-<slug>`

### Worktrees (when enabled)

```
.hootl/worktrees/
  task-001/    # git worktree for task-001
  task-002/    # git worktree for task-002
```

Worktrees enable parallel task execution without branch-switching conflicts. Created on demand, cleaned up when task reaches `done`.

### Auto-PR

When a task's confidence reaches 95%, hootl:
1. Pushes the branch to the remote
2. Creates a draft PR with:
   - Task description
   - Summary of changes (from `progress.md`)
   - Test results (from `test_results.md`)
   - Confidence score breakdown
3. Moves task to `review` state

---

## Budget & Safety Controls

### Budget Layers

| Layer | Default | Behavior when exceeded |
|-------|---------|----------------------|
| Per-session | $0.50 | Session ends, next session starts |
| Per-task | $5.00 | Task moves to `blocked` |
| Global (daily) | $50.00 | All work stops, human notified |
| Max attempts/task | 10 | Task moves to `blocked` |

Cost is tracked per-session in `.hootl/logs/cost.csv`. The `claude -p` output includes cost data which hootl parses and accumulates.

### Rollback on Broken State

If Phase 2 (execute) leaves tests in a worse state than before:
- Git changes for that session are rolled back
- Failure is logged in `progress.md`
- Task moves to `blocked` with explanation

---

## Error Recovery & Resilience

### Transient Errors

API timeouts, rate limits, and network errors are retried with exponential backoff (max 3 retries).

### Process Crash / Kill

- State is written to `task.json` before and after each phase
- On restart, hootl detects incomplete phases and resumes from the last checkpoint
- `hootl run` automatically detects and resumes interrupted tasks

### Broken State Rollback

- Pre-execution git state is recorded
- Post-execution test comparison determines if rollback is needed
- Rollback is automatic and logged

---

## Notifications & Reporting

### Terminal Output

Standard stdout/stderr for all operations. Colored output via `gum` or fallback.

### Summary File

`.hootl/status.md` is updated after every state change:

```markdown
# hootl Status

## In Progress (2)
- [task-001] Add input validation — 72% confidence, attempt 3/10
- [task-003] Refactor auth module — 45% confidence, attempt 1/10

## Blocked (1)
- [task-002] Update API endpoints — needs clarification on versioning strategy

## Review (1)
- [task-004] Add dark mode — 96% confidence, PR #42 open

## Done (3)
- [task-005] Fix login bug — completed 2026-03-04
...
```

### OS Notifications (opt-in)

macOS: `osascript -e 'display notification'`
Linux: `notify-send`

Triggered on: task completed, task blocked, budget warning (80% used).

### Webhook (opt-in)

POST to configured URL with JSON payload on state transitions. Compatible with Slack/Discord incoming webhooks.

---

## Initialization

### `hootl init`

Creates `.hootl/` directory with:
- `config.json` with sensible defaults
- `.gitignore` for tasks/logs
- Empty `tasks/` and `logs/` directories

Options:
- `--template <name>` — preconfigured settings for project types (web-app, cli-tool, library)
- Interactive prompts for task backend selection, budget preferences

### Auto-Init

Running any `hootl` command without `.hootl/` present triggers automatic initialization with defaults. No questions asked — user can customize later via `hootl config` or by editing `.hootl/config.json`.

---

## Concurrency

### Sequential (default)

One task at a time. Simple, no worktrees needed.

### Parallel (opt-in)

`hootl auto --parallel 3` or configured via `auto.maxParallel`:

1. User sets max concurrency limit
2. hootl examines the dependency graph
3. Independent tasks run concurrently, each in its own worktree
4. Dependent tasks wait for prerequisites
5. Budget is shared across all concurrent tasks

---

## MVP Scope

The first working version includes:

- [ ] CLI entry point with `commander` (`hootl`, `hootl init`, `hootl run`, `hootl plan`, `hootl status`, `hootl clarify`)
- [ ] Interactive TUI menu via `gum`
- [ ] Local markdown task backend only
- [ ] Single task completion loop (3-phase: plan, execute, review)
- [ ] Test-anchored confidence scoring
- [ ] Task state machine (proposed, ready, in_progress, review, blocked, done)
- [ ] Knowledge bridging via task-scoped directory (plan.md, progress.md, test_results.md, blockers.md, state.json)
- [ ] Blocker/clarification flow with multiple-choice questions
- [ ] Per-session and per-task budget tracking
- [ ] Max attempts per task
- [ ] Basic error recovery (resume from checkpoint)
- [ ] `.hootl/` project directory with config
- [ ] `~/.hootl/config.json` global config
- [ ] Sequential execution only (no worktrees, no parallelism)
- [ ] No autonomous mode
- [ ] No agent-browser integration
- [ ] No notifications beyond terminal
- [ ] No GitHub Issues or Beads backends

### Post-MVP Roadmap

1. **Autonomous mode** (conservative first, then other levels)
2. **Git worktrees** + parallel execution
3. **Auto-PR** on 95% confidence
4. **agent-browser** integration for web projects
5. **GitHub Issues backend**
6. **Beads backend**
7. **OS notifications + webhook**
8. **Smart queue** with dependency resolution
9. **Rollback on broken state**
10. **Init templates**

---

## Self-Build Strategy

1. Write this spec (done)
2. Hand-write the minimal skeleton:
   - `package.json` with TypeScript, commander, execa, zod
   - `tsconfig.json` (strict, ESM)
   - CLI entry point with basic subcommands
   - Single `claude -p` call wrapper
   - Local task backend (read/write task files)
   - Minimal 3-phase loop (plan, execute, review — even if rough)
3. Feed hootl its own MVP tasks — it starts building its own features
4. Iterate: hootl improves itself, adding features from the post-MVP roadmap
