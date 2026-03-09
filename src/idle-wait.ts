import { getActiveInstances } from "./status.js";

/** Maximum number of idle retries before giving up when other instances are active. */
export const MAX_IDLE_RETRIES = 12;

/** Sleep duration in milliseconds between idle retries. */
export const IDLE_SLEEP_MS = 5000;

/**
 * Determine whether the auto loop should retry task selection, exit on timeout,
 * or exit because no other instances are running.
 *
 * When all tasks are claimed by other instances, this function checks whether
 * those instances are still alive. If they are, the caller should sleep and
 * retry — the sibling instances may finish tasks that unblock dependencies or
 * release claims. After `maxIdleRetries` consecutive retries, it returns
 * "timeout" to prevent indefinite waiting (e.g., from zombie PIDs).
 *
 * Extracted as a pure-logic function for testability — the only side effect is
 * calling `getActiveInstances` to check for sibling processes via `.claim` files.
 */
export async function shouldRetryOnNoTask(
  tasksDir: string,
  idleRetries: number,
  maxIdleRetries: number,
  deps?: { getActiveInstances?: (dir: string) => Promise<{ count: number; pids: Map<string, number> }> },
): Promise<"retry" | "timeout" | "complete"> {
  const checkInstances = deps?.getActiveInstances ?? getActiveInstances;
  const { count } = await checkInstances(tasksDir);
  if (count > 0 && idleRetries < maxIdleRetries) return "retry";
  if (idleRetries >= maxIdleRetries) return "timeout";
  return "complete";
}
