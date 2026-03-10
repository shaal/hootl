# Remediation Decomposition into Subtasks

## Problem

When the review phase returns multiple discrete remediation items and confidence is below target, the current flow writes a single remediation plan and retries the entire thing in one execute pass. The executor often:

1. Burns most of its turns re-exploring the codebase (each attempt starts with `--no-session-persistence`)
2. Tries to address 3-5 items across multiple files simultaneously
3. Times out or hits the max-turns limit mid-edit (exit code 1)
4. The next attempt re-explores and fails again, burning through all remaining attempts

This is the gap between two existing decomposition mechanisms:
- **Preflight `too_broad`**: Fires before any work, decomposes planning-phase scope
- **Remediation retry**: Fires after review, but doesn't decompose — just retries

## Proposed Solution

Add a **remediation decomposition** step that creates subtasks from `remediationItems` when the executor fails to address them in a single pass.

## Trigger Conditions

Decompose when ALL of the following are true:

1. A remediation plan exists (`hasRemediationPlan === true`)
2. The execute phase failed (exit code !== 0, e.g. timeout or max-turns)
3. There are 2+ structured `remediationItems` from the last review
4. The task has at least 2 attempts remaining (need budget for subtasks)

This is conservative: we only decompose after an actual executor failure, not preemptively. A single well-scoped remediation item doesn't need decomposition.

## Subtask Creation

Map each `remediationItem` to a subtask:

```typescript
// From the review:
{
  category: "testCoverage",
  title: "Add parallel-terminals test for two goals",
  diffMarkers: ["two goals can run in parallel", "parallel terminals"],
  weight: 4.5
}

// Becomes:
{
  title: "Add parallel-terminals test for two goals",
  description: `[Remediation for ${parentTask.id}]\n\nCategory: testCoverage\nWeight: ${weight}\n\nContext: ${remediationPlan excerpt for this item}\n\nDiff markers (must appear in git diff when done):\n- "two goals can run in parallel"\n- "parallel terminals"`,
  priority: parentTask.priority,
  type: parentTask.type,
}
```

### Subtask ordering

- Create subtasks with **sequential inter-dependencies** (subtask-1 → subtask-2 → subtask-3)
- Ordering: highest `weight` first (most impactful items addressed first)
- This ensures they run one at a time on the same branch (avoids merge conflicts)

### Parent task update

Same pattern as `handleTooBroad`:
- Parent gets all subtask IDs added to `dependencies`
- Parent stays in `ready` state (blocked by deps)
- Blocker note: `"Remediation decomposed into subtasks: task-090, task-091, task-092"`
- Do NOT delete `understanding.md` (unlike too_broad — the parent's understanding is still valid)

## Branch and Worktree Sharing

This is the key difference from `too_broad` subtasks. Remediation subtasks must build on the parent's existing work:

1. **Subtasks inherit the parent's branch**: Set `branch` to the parent's branch name
2. **Subtasks share the parent's worktree**: Set `worktree` to the parent's worktree path
3. **Sequential execution**: Inter-dependencies ensure only one subtask runs at a time in the worktree
4. **Branch creation**: `createTaskBranch` already handles "branch exists → reuse" via `ensureBranch`
5. **Worktree reuse**: The loop already handles "worktree exists → reuse"

Each subtask commits its changes to the parent's branch. When all subtasks complete, the parent's branch has the full cumulative work.

## Parent Re-Review

When all subtasks are done and the parent resumes:

- Auto-promote detects `hasBranchDiff === true` (parent has real work) → does NOT auto-promote
- Parent enters the normal loop
- Preflight: `understanding.md` exists → skip
- Plan: sees the remediated codebase → should plan "verify implementation"
- Execute: likely no changes needed (subtasks did the work)
- Review: sees all changes (original + subtask additions) → should score higher

### Optimization (future): skip-to-review

If the parent had a previous confidence score and all remediation subtasks completed successfully, consider skipping directly to the review phase. The parent's only job at this point is to get re-assessed. This avoids burning turns on plan+execute when there's nothing to do.

## Implementation Checklist

### New function: `handleRemediationDecomposition`

Location: `src/loop.ts`, adjacent to `handleTooBroad`

```typescript
export async function handleRemediationDecomposition(
  backend: TaskBackend,
  currentTask: Task,
  remediationItems: RemediationItem[],
  remediationPlan: string,
  taskDir: string,
): Promise<{ createdIds: string[]; updatedTask: Task }>
```

Steps:
1. Sort `remediationItems` by `weight` descending
2. Create subtasks (similar to `handleTooBroad` loop)
   - Inherit parent's `priority`, `type`, `goal`
   - Set `branch` and `worktree` from parent task
   - Fractional `userPriority` for ordering (same pattern as too_broad)
3. Chain subtask dependencies: each depends on the previous
4. Update parent: add subtask IDs to `dependencies`, add blocker note
5. Log event: `decision: "remediation_decomposed"`
6. Return created IDs and updated parent

### Loop integration

In the error handler for execute phase failure (around line 1940-1977 in loop.ts):

```typescript
// After detecting execute failure with active remediation plan:
if (hasRemediationPlan && lastRemediationItems.length >= 2 && attemptsRemaining >= 2) {
  const { createdIds, updatedTask } = await handleRemediationDecomposition(
    backend, currentTask, lastRemediationItems, lastRemediationPlan, taskDir,
  );
  currentTask = updatedTask;
  uiInfo(`Remediation decomposed into ${createdIds.length} subtasks: ${createdIds.join(", ")}`);
  await logEvent(costLogDir, {
    taskId: task.id,
    type: "decision",
    data: { decision: "remediation_decomposed", details: `Created subtasks: ${createdIds.join(", ")}` },
  });
  break; // Exit loop — subtasks will handle the work
}
```

### Subtask description template

Each subtask gets a focused description with:
- The specific remediation item title
- The category and weight
- The relevant section of the remediation plan (not the whole thing)
- The diff markers that must appear when done
- A note that it's working on a shared branch

### Config

Add `config.remediation.decompose` (default: `true`) to allow disabling.

## Test Plan

1. **Decomposition trigger**: Execute fails + remediation plan + 2+ items → creates subtasks
2. **No decomposition on single item**: Only 1 remediation item → does not decompose (retry is fine)
3. **No decomposition without remediation plan**: Execute fails but no remediation → no decomposition
4. **Subtask structure**: Correct branch/worktree inheritance, sequential dependencies, weight ordering
5. **Parent update**: Dependencies extended, blocker note added, understanding.md preserved
6. **Priority inheritance**: Fractional userPriority slots after parent
7. **Goal inheritance**: Subtasks inherit parent's goal field
8. **Re-review after subtasks**: Parent resumes, gets reviewed, scores higher
9. **Config gate**: `decompose: false` disables the feature

## Risks

| Risk | Mitigation |
|------|------------|
| Subtasks conflict on shared worktree | Sequential dependencies prevent parallel execution |
| Subtask fails and leaves worktree dirty | Existing dirty-worktree detection handles this |
| Decomposition creates too many subtasks | Cap at 5 subtasks; merge low-weight items |
| Parent's understanding.md stale after subtasks | Keep it — it reflects the original feature context, not the remediation scope |
| Infinite decomposition loop | Only decompose once per task (track via blocker note or flag). If subtasks also fail, they use normal retry. |
