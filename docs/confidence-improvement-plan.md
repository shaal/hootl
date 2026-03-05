# Confidence Improvement Plan

Current confidence: **95%** — TARGET REACHED

## DONE: Priority 1 — Critical fixes (65% → 75%) [Session 002]

- [x] 1.1 Fix cost log path → `.hootl/logs/cost.csv`
- [x] 1.2 Add max-turns (plan/review: 20, execute: 50)
- [x] 1.3 Clean up permission mode handling

## DONE: Priority 2.1 — Unit tests (75% → 78%) [Session 002]

- [x] 73 tests covering invoke, config, local backend, loop

## DONE: Priority 3 — Robustness (78% → 84%) [Session 003]

- [x] 3.1 Empty output handling with transient retry
- [x] 3.3 Timeout handling (exit code 124)
- [x] 3.4 is_error detection in claude JSON
- [x] 3.5 Transient vs permanent error distinction

## DONE: Priority 4 — Git integration (84% → 88%) [Session 003]

- [x] 4.1 git.ts module + loop integration
- [x] 4.2 Auto-commit after execute phase
- [x] 39 new tests for git + invoke robustness

## DONE: Priority 5 — Integration tests + polish (88% → 95%) [Session 004]

- [x] 5.1 Clarify integration tests (5 tests)
- [x] 5.2 Status summary on every state change
- [x] 5.3 Full e2e on clean repo — 97% confidence, first attempt
- [x] 5.4 CLAUDE.md updated

**Total: 117 tests, 30 suites, all passing**

## Post-MVP Roadmap (beyond 95%)

1. Autonomous mode (`hootl auto`)
2. Git worktrees for parallel execution
3. Auto-PR on 95% confidence
4. GitHub Issues backend
5. Beads backend
6. OS notifications + webhook
7. Smart queue with dependency resolution
8. Init templates
