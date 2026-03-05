# Confidence Improvement Plan

Current confidence: **65%**
Target: **95%**

## Priority 1: Critical fixes (65% → 75%)

### 1.1 Fix cost log path
Cost CSV writes to `.hootl/cost.csv` but spec says `.hootl/logs/cost.csv`.
Fix: Change `costLogDir` in loop.ts from `getProjectDir()` to `join(getProjectDir(), "logs")`.

### 1.2 Add max-turns to claude -p calls
Without `--max-turns`, a claude session could run indefinitely.
Fix: Add `maxTurns: 20` default to plan/review phases and `maxTurns: 50` for execute.

### 1.3 Fix execute phase permission escalation
Currently hardcodes `bypassPermissions` when config says `default`. Should respect config.
Fix: Make `permissionMode` in config default to `bypassPermissions` instead of `default`, since hootl is designed for autonomous operation.

## Priority 2: Test coverage (75% → 85%)

### 2.1 Add unit tests for core modules
- `parseReviewResult` — JSON extraction from various formats (clean, markdown-wrapped, broken)
- `parseCostFromOutput` — cost extraction from real claude output
- `extractTextOutput` — text extraction from JSON envelope
- `loadConfig` — merging, env overrides, defaults
- `LocalTaskBackend` — CRUD operations, filtering, sorting
- `getNextTaskId` — sequential ID generation

### 2.2 Add integration test for `hootl plan`
Test that plan command calls claude, parses response, creates tasks.
Use a mock or a cheap claude call.

### 2.3 Add integration test for `hootl clarify`
Test the blocker resolution flow.
Can be tested without claude (just backend state changes).

## Priority 3: Robustness (85% → 90%)

### 3.1 Handle empty/error claude responses
If claude returns empty result or error JSON, handle gracefully instead of crashing.

### 3.2 Add resume support
When a task is `in_progress` and hootl restarts, detect and resume from last phase.
Progress.md and plan.md already persist — just need to detect incomplete state.

### 3.3 Add timeout handling
If claude -p times out (5min), log the timeout and continue to next attempt.
Already have `timeout: 300_000` but need to handle the timeout error gracefully.

## Priority 4: Feature completeness (90% → 95%)

### 4.1 Git branch per task
Create `hootl/<task-id>-<slug>` branch when starting a task.
Commit after each successful execute phase.
This solves the "dirty working tree" blocker from session 001.

### 4.2 Status summary file
Write `.hootl/status.md` after every state change (not just on `hootl status`).

### 4.3 Test the full loop on a clean repo
Run hootl on itself in a clean state (committed changes, no dirty files).
Verify it can reach 95% confidence on a simple task.

## Execution order

Each item can be a task for hootl to work on:
1. 1.1, 1.2, 1.3 (quick fixes, do together)
2. 2.1 (unit tests — biggest confidence boost)
3. 3.1, 3.2, 3.3 (robustness)
4. 4.1 (git branches — structural improvement)
5. 2.2, 2.3 (integration tests)
6. 4.2, 4.3 (polish)
