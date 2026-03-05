# hootl — Human Out Of The Loop

Autonomous task completion engine that orchestrates `claude -p` calls in a 3-phase loop (plan, execute, review) to complete coding tasks without constant human attention.

TypeScript, ESM, Node.js >= 20.

## Build & Run

```bash
npm run build       # Compile TypeScript (tsc)
npm run dev         # Watch mode (tsc --watch)
npm run start       # Run the CLI (node dist/index.js)
npm run lint        # Type-check without emitting (tsc --noEmit)
```

No test framework is set up yet.

## Project Structure

```
src/
  index.ts          CLI entry point (commander). Commands: init, plan, run, status, clarify
  config.ts         Zod-validated config. 3-layer hierarchy: ~/.hootl/config.json < .hootl/config.json < env vars
  loop.ts           Core 3-phase completion loop (plan -> execute -> review). Budget/attempt tracking, confidence scoring
  invoke.ts         Wrapper around `claude -p` via execa. Parses cost from JSON output
  ui.ts             Terminal UI helpers using `gum` with stdin fallback
  tasks/
    types.ts        Zod schemas for Task, TaskState, TaskBackend interface
    local.ts        Local filesystem task backend (.hootl/tasks/ directory)
templates/
  plan.md           System prompt for planning phase
  execute.md        System prompt for execution phase
  review.md         System prompt for review phase
docs/
  spec.md           Full project specification
.hootl/             Runtime data directory (tasks, logs, status)
```

## Code Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- No `any` — use `unknown` with type narrowing
- `noUncheckedIndexedAccess: true` is enabled — always handle possible `undefined` from indexed access
- Zod for all schema validation (config, tasks)
- File imports use `.js` extension (Node16 module resolution)
- Atomic file writes via tmp + rename pattern (see `local.ts`)
- Error handling: catch `unknown`, narrow with `instanceof Error`

## Architecture

- Each `claude -p` call is stateless; context bridges between phases via files (`plan.md`, `progress.md`, `test_results.md`, `blockers.md`)
- Task states: `proposed -> ready -> in_progress -> review -> done` (with `blocked` as side state)
- Budget controls: per-session, per-task, global, max attempts
- Confidence target: 95% (backed by test results, not self-assessment)

## Dependencies

- **commander** — CLI framework
- **execa** — subprocess execution (for `claude -p`)
- **zod** — schema validation
