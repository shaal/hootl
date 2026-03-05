# hootl — Human Out Of The Loop

Autonomous task completion engine powered by Claude. Calls `claude -p` in structured 3-phase loops (plan, execute, review) to complete coding tasks without constant human attention.

Tasks that hit blockers park themselves and the system moves on. Humans only intervene when genuinely needed.

## Quick Start

```bash
# Install dependencies and build
npm install && npm run build

# Link globally (run once)
npm link

# Initialize in any project
cd ~/your-project
hootl init

# Create tasks and run them
hootl plan                     # Interactive planning mode
hootl plan --from-spec         # Auto-detect gaps from docs/spec.md
hootl plan --goal "add auth"   # Break down a specific goal
hootl run                      # Pick up the next ready task and work on it
hootl status                   # See all tasks and their states
hootl clarify                  # Resolve blocked tasks that need human input
```

## How It Works

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  PLAN   │────▶│ EXECUTE │────▶│ REVIEW  │
│(claude) │     │(claude) │     │(claude) │
└─────────┘     └─────────┘     └─────────┘
     ▲               │               │
     │               │          confidence
     │          auto-commit      >= 95%? ──▶ DONE
     │               │               │
     └───────────────┘◀──── < 95% ───┘
```

Each phase is a fresh `claude -p` call with clean context. Knowledge bridges through files:

- `plan.md` — execution plan for the current attempt
- `progress.md` — cumulative log of what was done
- `test_results.md` — latest review output
- `blockers.md` — questions/issues needing human input

## Task Lifecycle

```
ready ──▶ in_progress ──▶ review ──▶ done
               │              │
               ▼              ▼
           blocked ◀──────blocked
               │
     (human resolves via `hootl clarify`)
               │
               ▼
             ready
```

## Git Integration

Each task runs on its own branch (`hootl/<task-id>-<slug>`). Changes are auto-committed after each execute phase. When done, hootl switches back to your base branch.

## Project Structure

```
src/
  index.ts          CLI entry point (commander)
  config.ts         3-tier config: ~/.hootl/ → .hootl/ → env vars
  context.ts        Project context gathering for plan command
  loop.ts           Core 3-phase completion loop
  invoke.ts         claude -p wrapper with cost tracking
  ui.ts             gum TUI with stdin fallback
  git.ts            Branch management + auto-commit
  status.ts         Auto-update .hootl/status.md on state changes
  tasks/
    types.ts        Zod schemas, TaskBackend interface
    local.ts        Local filesystem task backend
templates/
  plan.md           System prompt for planning phase
  execute.md        System prompt for execution phase
  review.md         System prompt for review phase
```

## Configuration

```bash
# Global defaults
~/.hootl/config.json

# Per-project (committed to git)
.hootl/config.json

# Environment overrides
HOOTL_BUDGET_PER_TASK=10.00
HOOTL_CONFIDENCE_TARGET=90
HOOTL_AUTO_LEVEL=proactive
```

Key defaults: $5/task budget, 10 max attempts, 95% confidence target.

## Testing

```bash
npm test              # Run 123 unit tests
npm run test:build    # Build + test
npm run lint          # Type-check
```

## Developing hootl with hootl

hootl is designed to build itself. The full workflow — planning features, running tasks, reviewing branches, unblocking — is documented in **[docs/self-build-guide.md](docs/self-build-guide.md)**.

```bash
cd ~/code/utilities/hootl
hootl plan --from-spec   # Claude reads spec, finds gaps, creates prioritized tasks
hootl run               # Work on the top-priority task (runs unattended)
hootl status             # Check progress
hootl clarify            # Unblock stuck tasks
# Review branch, merge, repeat
```

See also: [docs/spec.md](docs/spec.md) for the full specification.
