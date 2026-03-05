# Developing hootl with hootl

hootl is designed to build itself. This guide covers the day-to-day workflow for using hootl as its own development tool.

## Prerequisites

```bash
cd ~/code/utilities/hootl
npm install && npm run build && npm link
hootl init   # already done if you see .hootl/ directory
```

## The Core Loop

```
plan → run → review → merge → repeat
```

Your role: review diffs, merge good work, unblock stuck tasks. Claude does the rest.

## Step 1: Plan Features

```bash
hootl plan
```

You'll see three options:

| Mode | When to use |
|------|-------------|
| **Break down a goal** | You know what you want. Describe it and Claude splits it into tasks. |
| **Analyze codebase** | Queue is empty. Let Claude scan for improvements, missing tests, TODOs. |
| **Suggest what's next** | There are existing tasks. Let Claude recommend priorities. |

**Example — adding autonomous mode:**
```
> hootl plan
? Planning mode: Break down a goal
? Describe the goal: Implement hootl auto (conservative level) per docs/spec.md.
  It should loop through ready tasks calling hootl run until the queue is empty
  or the global budget is reached.
```

Claude reads the spec and codebase, then creates tasks in `.hootl/tasks/` with state `ready`.

**Tip:** Reference `docs/spec.md` in your goal description. Claude will read it and align with the design decisions already made.

## Step 2: Review the Plan

```bash
hootl status
```

Output looks like:
```
## READY (3)
  task-002: Add hootl auto subcommand with conservative mode [confidence: 0, attempts: 0]
  task-003: Add global budget tracking across tasks [confidence: 0, attempts: 0]
  task-004: Add hootl auto loop with queue drain logic [confidence: 0, attempts: 0]
```

If a task looks wrong, edit it directly:
```bash
# Change priority
vi .hootl/tasks/task-002/task.json

# Delete a bad task
rm -rf .hootl/tasks/task-004

# Edit the description to be more specific
vi .hootl/tasks/task-003/task.json
```

## Step 3: Run a Task

```bash
# Run the highest-priority ready task
hootl run

# Or run a specific task
hootl run task-002
```

What happens behind the scenes:
1. Creates a git branch: `hootl/task-002-add-hootl-auto-subcommand`
2. **Phase 1 — Plan** (~20s): Fresh `claude -p` reads the task + codebase, writes a step-by-step plan
3. **Phase 2 — Execute** (~30-60s): Fresh `claude -p` implements the plan, then auto-commits
4. **Phase 3 — Review** (~20s): Fresh `claude -p` runs tests, examines the diff, scores confidence 0-100

If confidence >= 95%: task is done. If not: loops back to Phase 1 for another attempt.

**This runs unattended.** You can walk away.

### Running in the background

```bash
hootl run > /tmp/hootl.log 2>&1 &

# Check progress anytime
cat /tmp/hootl.log

# Or check the auto-updated status
cat .hootl/status.md
```

### Cost expectations

| Task complexity | Attempts | Cost |
|----------------|----------|------|
| Simple (add config, update docs) | 1 | ~$0.40 |
| Medium (new feature, refactor) | 1-3 | $0.40-$2.00 |
| Complex (architectural change) | 3-5 | $2.00-$5.00 |

Monitor spend: `cat .hootl/logs/cost.csv`

## Step 4: Review Completed Work

```bash
# See what's ready for review
hootl status

# Look at the branch
git log hootl/task-002-add-hootl-auto-subcommand --oneline -5

# Review the diff against main
git diff main..hootl/task-002-add-hootl-auto-subcommand

# Run tests on the branch
git checkout hootl/task-002-add-hootl-auto-subcommand
npm run test:build
git checkout main
```

### If the work looks good

```bash
git merge hootl/task-002-add-hootl-auto-subcommand
git branch -d hootl/task-002-add-hootl-auto-subcommand
```

### If it needs tweaks

You have two options:

**Option A — Fix it yourself and merge:**
```bash
git checkout hootl/task-002-add-hootl-auto-subcommand
# make your edits
git commit -am "Manual fix: handle edge case"
git checkout main
git merge hootl/task-002-add-hootl-auto-subcommand
```

**Option B — Send it back for another attempt:**
Edit the task to provide feedback, then re-run:
```bash
# Add notes about what's wrong
echo "The auto mode should exit with code 0 on success, not 1" >> .hootl/tasks/task-002/blockers.md

# Reset to ready with feedback
python3 -c "
import json
t = json.load(open('.hootl/tasks/task-002/task.json'))
t['state'] = 'ready'
t['confidence'] = 0
json.dump(t, open('.hootl/tasks/task-002/task.json', 'w'), indent=2)
"

# Run again — it will read your feedback from blockers.md
hootl run task-002
```

## Step 5: Unblock Stuck Tasks

Tasks get blocked when they can't reach 95% confidence, exceed budget, or hit unclear requirements.

```bash
hootl clarify
```

You'll see each blocked task with its questions. Answer them and the task moves back to `ready`:

```
Blocked task task-003: Add global budget tracking
  Blockers:
  - Should global budget reset daily or per hootl invocation?

? What to do with task-003?
  > Provide answers
  > Skip for now
  > Mark as ready (blockers resolved)
```

## Step 6: Continue

```bash
hootl run       # next task
# ... time passes ...
hootl status    # check progress
hootl clarify   # help stuck tasks
hootl plan      # add more features when queue empties
```

## Post-MVP Roadmap

Features for hootl to build, in recommended order. Use `hootl plan` with these as goals:

| # | Feature | Goal description for `hootl plan` |
|---|---------|----------------------------------|
| 1 | `hootl auto` (conservative) | "Implement hootl auto subcommand that loops through ready tasks, running each one until the queue is empty or global budget is reached. Conservative level only — no task creation." |
| 2 | Auto-PR on completion | "When a task reaches 95% confidence, push the branch and create a draft PR using gh cli. Include task description, change summary from progress.md, and confidence score." |
| 3 | Rollback on broken state | "Before Phase 2, record which tests pass. After Phase 2, re-run them. If previously-passing tests now fail, git checkout the changes and mark task as blocked." |
| 4 | Smart task queue | "Add dependency resolution to task ordering. Tasks with unmet dependencies can't be ready. Within same priority, estimate effort and support quick-wins-first vs big-items-first strategies." |
| 5 | Git worktrees | "Use git worktree for task isolation instead of branch switching. Create worktree in .hootl/worktrees/<task-id>/, run claude -p with cwd set to worktree, clean up when done." |
| 6 | `hootl auto` (proactive) | "Extend auto mode with proactive level. When queue is empty, scan codebase for improvements and create tasks in proposed state. User approves proposed tasks via hootl clarify." |
| 7 | GitHub Issues backend | "Implement the TaskBackend interface for GitHub Issues using gh cli or octokit. Support listTasks, createTask, updateTask, deleteTask. Map task states to issue labels." |
| 8 | agent-browser integration | "Auto-detect web projects. During review phase, if project has a web framework, use agent-browser cli to run visual tests. Include results in confidence scoring." |
| 9 | OS notifications | "Send macOS notifications (osascript) when a task completes, gets blocked, or when budget hits 80%. Make configurable via notifications.osNotify in config." |
| 10 | Init templates | "Add --template flag to hootl init. Templates preconfigure settings: web-app (enables agent-browser, higher budget), cli-tool (default), library (lower budget, stricter tests)." |

## Adjusting Budgets

Edit `.hootl/config.json`:

```json
{
  "budgets": {
    "perSession": 0.50,
    "perTask": 10.00,
    "global": 100.00,
    "maxAttemptsPerTask": 15
  }
}
```

Increase `perTask` for complex features. Increase `maxAttemptsPerTask` if tasks are getting close but not quite reaching 95%.

## Troubleshooting

### Task keeps looping without reaching 95%

Check `.hootl/tasks/<id>/test_results.md` for why. Common causes:
- Missing test coverage — the reviewer won't score above 80 without tests
- Task is too broad — split it into smaller tasks
- Increase `perTask` budget if it's hitting the limit

### Task gets blocked immediately

Check `.hootl/tasks/<id>/blockers.md`. Often the task description is too vague. Edit `task.json` to add specifics, clear blockers, and re-run.

### claude -p errors

Check `.hootl/logs/cost.csv` for the last phase that ran. Common issues:
- Rate limiting — wait a few minutes and run again
- Context too large — the task accumulated too much in progress.md. Delete old attempts from progress.md.

### Want to start fresh on a task

```bash
# Reset task completely
cd .hootl/tasks/task-003
echo "" > plan.md && echo "" > progress.md && echo "" > test_results.md && echo "" > blockers.md
python3 -c "
import json
t = json.load(open('task.json'))
t['state'] = 'ready'
t['confidence'] = 0
t['attempts'] = 0
t['totalCost'] = 0
json.dump(t, open('task.json', 'w'), indent=2)
"

# Delete the task branch if it exists
git branch -D hootl/task-003-whatever 2>/dev/null
```
