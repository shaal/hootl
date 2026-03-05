/**
 * Post-processing step for auto-detecting and wiring task dependencies
 * after the planner generates a batch of tasks.
 *
 * Primary mechanism: Claude provides `dependsOn` indices in its JSON output.
 * Fallback: heuristic keyword matching between task titles and descriptions.
 */

interface PlannedTask {
  title: string;
  description: string;
  dependsOn?: number[];
}

/**
 * Infer dependency relationships between tasks in a batch.
 * Returns a map of task index -> array of dependency indices.
 *
 * Priority:
 * 1. If a task has explicit `dependsOn` indices, use them (validated).
 * 2. Otherwise, scan description for references to other task titles.
 */
export function inferDependencies(
  tasks: PlannedTask[],
): Map<number, number[]> {
  const result = new Map<number, number[]>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    let deps: number[];

    if (Array.isArray(task.dependsOn)) {
      // Claude explicitly provided dependsOn — use it (even if empty means "no deps")
      deps = task.dependsOn.filter(
        (idx) => typeof idx === "number" && idx >= 0 && idx < tasks.length && idx !== i,
      );
    } else {
      // No dependsOn field at all — fall back to heuristic
      deps = inferFromDescription(i, task.description, tasks);
    }

    // Remove duplicates
    deps = [...new Set(deps)];

    if (deps.length > 0) {
      result.set(i, deps);
    }
  }

  // Remove circular dependencies
  return removeCycles(result, tasks.length);
}

/**
 * Scan a task's description for references to other task titles.
 * Uses case-insensitive substring matching on significant title keywords.
 */
function inferFromDescription(
  taskIndex: number,
  description: string,
  tasks: PlannedTask[],
): number[] {
  const deps: number[] = [];
  const descLower = description.toLowerCase();

  for (let j = 0; j < tasks.length; j++) {
    if (j === taskIndex) continue;

    const otherTask = tasks[j]!;
    const keywords = extractKeywords(otherTask.title);

    // Require at least one significant keyword match in the description
    for (const keyword of keywords) {
      if (descLower.includes(keyword)) {
        deps.push(j);
        break;
      }
    }
  }

  return deps;
}

/** Stop words that are too generic to signal a dependency */
const STOP_WORDS = new Set([
  "add", "create", "implement", "update", "fix", "remove", "the", "a", "an",
  "for", "to", "in", "on", "with", "and", "or", "of", "from", "into", "that",
  "this", "task", "new", "support", "handling", "based", "using", "make",
  "build", "set", "up", "get", "use",
]);

/**
 * Extract significant keywords from a task title.
 * Filters out stop words and short tokens, returns lowercase.
 */
export function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/**
 * Remove circular dependencies using topological analysis.
 * If A->B->A is detected, drop the back-edge (the one from the later task).
 */
function removeCycles(
  deps: Map<number, number[]>,
  taskCount: number,
): Map<number, number[]> {
  // Use DFS-based cycle detection
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current DFS path
  const BLACK = 2; // fully processed

  const color = new Array<number>(taskCount).fill(WHITE);
  const backEdges: Array<[number, number]> = [];

  function dfs(node: number): void {
    color[node] = GRAY;
    const neighbors = deps.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (color[neighbor] === GRAY) {
        // Back edge found — this creates a cycle
        backEdges.push([node, neighbor]);
      } else if (color[neighbor] === WHITE) {
        dfs(neighbor);
      }
    }
    color[node] = BLACK;
  }

  for (let i = 0; i < taskCount; i++) {
    if (color[i] === WHITE) {
      dfs(i);
    }
  }

  // Remove back edges
  if (backEdges.length > 0) {
    const result = new Map<number, number[]>();
    for (const [idx, depList] of deps) {
      const filtered = depList.filter(
        (dep) => !backEdges.some(([from, to]) => from === idx && to === dep),
      );
      if (filtered.length > 0) {
        result.set(idx, filtered);
      }
    }
    return result;
  }

  return deps;
}

/**
 * Resolve index-based dependencies to actual task IDs.
 * Used after tasks are created and IDs are known.
 */
export function resolveIndicesToIds(
  depMap: Map<number, number[]>,
  indexToId: Map<number, string>,
): Map<number, string[]> {
  const resolved = new Map<number, string[]>();

  for (const [taskIdx, depIndices] of depMap) {
    const ids: string[] = [];
    for (const depIdx of depIndices) {
      const id = indexToId.get(depIdx);
      if (id !== undefined) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      resolved.set(taskIdx, ids);
    }
  }

  return resolved;
}
