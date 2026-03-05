# Confidence Improvement Plan

Current confidence: **88%**
Target: **95%**

## DONE: Priority 1 — Critical fixes (65% → 75%) [Session 002]

- [x] 1.1 Fix cost log path → `.hootl/logs/cost.csv`
- [x] 1.2 Add max-turns (plan/review: 20, execute: 50)
- [x] 1.3 Clean up permission mode handling

## DONE: Priority 2.1 — Unit tests (75% → 78%) [Session 002]

- [x] 73 tests across 4 files, all passing
- [x] invoke.ts, config.ts, local.ts, loop.ts

## DONE: Priority 3 — Robustness (78% → 84%) [Session 003]

- [x] 3.1 Empty output handling — transient retry on empty responses
- [x] 3.3 Timeout handling — exit code 124, descriptive message
- [x] 3.4 is_error detection — force exitCode 1 on claude errors
- [x] 3.5 Transient vs permanent error distinction in loop catch block
- [ ] 3.2 Resume support — deferred (works implicitly since task stays in_progress)

## DONE: Priority 4 — Git integration (84% → 88%) [Session 003]

- [x] 4.1 New git.ts module (slugify, branch create/switch, commit, detect repo)
- [x] 4.2 Loop integration (branch per task, auto-commit after execute, return to base)
- [x] 39 new tests (git + invoke robustness)

**Total: 112 tests, 25 suites, all passing**

## Next: Priority 5 — Integration tests + polish (88% → 95%)

### 5.1 Integration test for `hootl clarify`
Test the blocker resolution flow without claude — just backend state changes.
Create a blocked task, run clarify logic, verify it moves to ready.

### 5.2 Status summary on every state change
Write `.hootl/status.md` after every backend.updateTask, not just on `hootl status`.

### 5.3 Full e2e test on a clean repo
Commit all current changes in hootl, create a simple task, run the full loop.
Verify it can reach 95% confidence with git branch isolation working.

### 5.4 CLAUDE.md update
Update the auto-generated CLAUDE.md to reflect current state (112 tests, git integration, etc.)

## Execution order

1. ~~P1: Quick fixes~~ DONE
2. ~~P2.1: Unit tests~~ DONE
3. ~~P3: Robustness~~ DONE
4. ~~P4: Git integration~~ DONE
5. **P5: Integration tests + polish** (5.1, 5.2, 5.3, 5.4) ← NEXT
