# Session 003: Robustness + Git Integration

## P3: Robustness Improvements

### 3.1 Empty output handling
All three phases (plan, execute, review) now check for empty output from claude -p.
Empty responses trigger a warning and throw a transient error that allows retrying.

### 3.2 Transient vs permanent error distinction
The catch block in the completion loop now distinguishes:
- **Transient errors** (empty output, timeouts) → continue looping to next attempt
- **Permanent errors** (API failures, unexpected crashes) → break and keep task in_progress for manual resume

### 3.3 Timeout handling
invoke.ts now detects execa timeout errors (`timedOut: true`) and returns exit code 124 with a descriptive message.

### 3.4 is_error field detection
invokeClaude now checks the `is_error` field in claude's JSON response. If true, exitCode is forced to 1 regardless of process exit code.

## P4: Git Integration

### 4.1 New git.ts module
Helper functions for task branch isolation:
- `slugify()` — converts task title to branch-safe slug
- `isGitRepo()` — detects if cwd is a git repo
- `getCurrentBranch()` / `getBaseBranch()` — branch introspection
- `createTaskBranch()` — creates `hootl/<task-id>-<slug>` branch
- `commitTaskChanges()` — auto-commits after execute phase
- `switchBranch()` — returns to base branch after loop ends

### 4.2 Loop integration
- Before loop: creates task branch, records base branch
- After Phase 2: auto-commits changes with `[task-id] Execute attempt N`
- After loop ends: switches back to base branch
- All git operations wrapped in try/catch — failures warn but don't break the loop

## Tests Added

39 new tests across 2 files:

| File | Tests | Covers |
|------|-------|--------|
| `git.test.ts` | 16 | slugify (8), isGitRepo (2), getCurrentBranch (1), createTaskBranch (2), commitTaskChanges (3), getBaseBranch (1) — uses temp git repos |
| `invoke-robustness.test.ts` | 22 | parseCostFromOutput with errors (6), extractTextOutput with errors (7), buildArgs edge cases (9) |

**Total test suite: 112 tests, 25 suites, all passing**

## Updated Confidence: 88%

### Improvements from session 002 (78% → 88%)
- +4%: Robustness — empty output, timeout, is_error, transient retry
- +4%: Git branch isolation — solves the dirty working tree problem
- +2%: 39 more tests covering new code

### Remaining gaps to 95%
- Integration test: `hootl plan` with real claude call
- Integration test: `hootl clarify` flow
- Full loop test on a clean repo (verify 95% achievable)
- Status summary written on every state change (not just `hootl status`)
