# Session 001: Bootstrap & First E2E Test

## What was done

### Skeleton built
- Full TypeScript project with 7 source files, 3 templates
- CLI with 5 commands: `init`, `plan`, `run`, `status`, `clarify`
- Interactive TUI menu via gum with stdin fallback
- Local filesystem task backend with zod validation
- 3-phase completion loop (plan → execute → review)
- Config hierarchy: global → project → env vars
- Cost tracking per phase in CSV format

### Bugs found and fixed during e2e testing
1. **`cost_usd` → `total_cost_usd`** — Claude's JSON output uses `total_cost_usd`, not `cost_usd`
2. **`-s` → `--system-prompt`** — Claude CLI doesn't have a `-s` shorthand
3. **`--verbose` breaks JSON parsing** — Outputs multiple JSON objects (NDJSON), not one. Removed the flag.
4. **`--permission-mode default` hangs** — In `-p` mode, default permissions trigger interactive prompts. Switched to `--dangerously-skip-permissions`.
5. **`stdin` not closed** — `execa` left stdin open, potentially causing hangs. Added `stdin: "ignore"`.
6. **`CLAUDECODE` env var** — Blocks `claude -p` inside Claude Code sessions. Now explicitly unset.
7. **Missing `--output-format json`** — Was only used for review phase; now all phases use JSON to capture cost data.
8. **Gum spinner subprocess leak** — Spawned `sleep 86400` background process. Replaced with simple stderr message.

### First real task executed
- Task: "Add a CLAUDE.md file for the hootl project"
- Attempt 1: Plan (56s, $0.38) → Execute (45s, $0.16) → Review (38s, $0.18) → **40% confidence**
- Attempt 2: Plan (16s, $0.08) → Execute (17s, $0.10) → Review (33s, $0.15) → **35% confidence**
- Correctly identified blocker: dirty working tree mixing unrelated changes
- Task moved to `blocked` state with actionable explanation
- Total cost: $1.05 for 2 full cycles

## Current confidence: 65%

### What works (high confidence)
- `hootl init` — creates proper directory structure ✓
- `hootl status` — lists and groups tasks ✓
- Task CRUD via local backend — create, read, update, delete ✓
- 3-phase completion loop — plan, execute, review, loop/block ✓
- Cost tracking — per-phase CSV logging ✓
- Config loading — 3-tier hierarchy with zod validation ✓
- `claude -p` invocation — flags, JSON parsing, cost extraction ✓

### What's untested or uncertain
- `hootl plan` — claude generates tasks, JSON parsing from response
- `hootl clarify` — interactive blocker resolution flow
- TUI menu (default `hootl` command)
- Resume from interrupted task
- Error recovery — what happens on API timeout, crash mid-phase
- Edge cases — empty responses, malformed JSON from claude, concurrent access

### Known issues
- No git integration yet — tasks don't create branches or worktrees
- Execute phase uses `bypassPermissions` when config says `default` — may be too aggressive
- No max-turns limit on claude -p calls — long tasks could run very long
- Templates reference "subagents" but claude -p doesn't have subagent support unless the model decides to use them
- Cost log path is `.hootl/cost.csv` not `.hootl/logs/cost.csv` (mismatch with spec)
