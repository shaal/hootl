# Confidence Improvement Plan

Current confidence: **78%**
Target: **95%**

## DONE: Priority 1 — Critical fixes (65% → 75%) [Session 002]

- [x] 1.1 Fix cost log path → `.hootl/logs/cost.csv`
- [x] 1.2 Add max-turns (plan/review: 20, execute: 50)
- [x] 1.3 Clean up permission mode handling

## DONE: Priority 2.1 — Unit tests (75% → 78%) [Session 002]

- [x] 73 tests across 4 files, all passing
- [x] invoke.ts: parseCostFromOutput, extractTextOutput, buildArgs
- [x] config.ts: ConfigSchema, loadJsonFile, applyEnvOverrides, loadConfig
- [x] local.ts: getNextTaskId, CRUD, filtering, sorting
- [x] loop.ts: parseReviewResult

## Next: Priority 3 — Robustness (78% → 87%)

### 3.1 Handle empty/error claude responses
If claude returns empty result or error JSON, handle gracefully instead of crashing.
- Empty `result` field → treat as error, log, continue to next attempt
- `is_error: true` in JSON → extract error message, log, mark as transient failure

### 3.2 Add resume support
When a task is `in_progress` and hootl restarts, detect and resume from last phase.
- Check plan.md timestamp vs progress.md timestamp to determine which phase to resume from
- If plan.md exists and is newer than progress.md → resume at Phase 2
- If progress.md has content from current attempt → resume at Phase 3

### 3.3 Add timeout handling
If claude -p times out (5min), log the timeout and continue to next attempt.
Already have `timeout: 300_000` but need to handle the timeout error gracefully in the catch block.

### 3.4 Handle `is_error` in claude JSON response
Check `is_error` field in the parsed JSON. If true, the "result" field contains an error message, not useful output.

## Next: Priority 4 — Git integration (87% → 92%)

### 4.1 Git branch per task
Create `hootl/<task-id>-<slug>` branch when starting a task.
Commit after each successful execute phase.
This solves the "dirty working tree" blocker from session 001.

### 4.2 Auto-commit after execute phase
After Phase 2, if tests pass, auto-commit with message referencing the task ID.

## Next: Priority 5 — Integration tests (92% → 95%)

### 5.1 Integration test for `hootl plan`
Test that plan command calls claude, parses response, creates tasks.

### 5.2 Integration test for `hootl clarify`
Test the blocker resolution flow (backend state changes, no claude needed).

### 5.3 Full loop on clean repo
Commit all changes, run hootl on itself with a simple task, verify 95%.

### 5.4 Status summary updates
Write `.hootl/status.md` after every state change (not just on `hootl status`).

## Execution order

1. ~~P1: Quick fixes~~ DONE
2. ~~P2.1: Unit tests~~ DONE
3. **P3: Robustness** (3.1, 3.2, 3.3, 3.4)
4. **P4: Git integration** (4.1, 4.2)
5. **P5: Integration tests** (5.1, 5.2, 5.3, 5.4)
