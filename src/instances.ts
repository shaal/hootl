import { readdir, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isProcessAlive } from "./status.js";

const InstanceInfoSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  level: z.string(),
});

export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

export interface ActiveInstancesResult {
  count: number;
  instances: InstanceInfo[];
}

export interface InstanceDeps {
  instancesDir: string;
}

// Module-level state: remembered after registerInstance so deregister/sync variants don't need the path again.
let registeredDir: string | null = null;

/**
 * Register the current process as an active hootl instance.
 *
 * Writes `.hootl/instances/<pid>.json` with `{ pid, startedAt, level }`.
 * Uses atomic write (tmp + rename) consistent with local.ts.
 */
export async function registerInstance(level: string, deps: InstanceDeps): Promise<void> {
  const { instancesDir } = deps;
  await mkdir(instancesDir, { recursive: true });

  registeredDir = instancesDir;

  const data: InstanceInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    level,
  };

  const filePath = join(instancesDir, `${process.pid}.json`);
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Deregister the current process (async variant).
 *
 * Removes `.hootl/instances/<pid>.json`. Best-effort: silently ignores
 * ENOENT if the file is already gone.
 */
export async function deregisterInstance(deps?: InstanceDeps): Promise<void> {
  const dir = deps?.instancesDir ?? registeredDir;
  if (dir === null) return;

  try {
    await unlink(join(dir, `${process.pid}.json`));
  } catch {
    // Best-effort: file may already be removed
  }
}

/**
 * Deregister the current process (synchronous variant).
 *
 * Uses `unlinkSync` — safe for signal handlers where async is unreliable.
 * Matches the `releaseAllClaims` pattern in index.ts.
 */
export function deregisterInstanceSync(deps?: InstanceDeps): void {
  const dir = deps?.instancesDir ?? registeredDir;
  if (dir === null) return;

  try {
    unlinkSync(join(dir, `${process.pid}.json`));
  } catch {
    // Best-effort: file may already be removed
  }
}

/**
 * Parse and validate an instance JSON file via Zod schema.
 * Returns null on missing, corrupt, or invalid files.
 */
function parseInstanceFile(raw: string): InstanceInfo | null {
  try {
    const data: unknown = JSON.parse(raw);
    const result = InstanceInfoSchema.safeParse(data);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Scan the instances directory for active hootl processes.
 *
 * Reads all `*.json` files, checks each PID's liveness via `process.kill(pid, 0)`,
 * and **actively removes** stale entries (dead PID files get unlinked).
 *
 * Returns the count and list of live instances.
 */
export async function getActiveInstances(deps: InstanceDeps): Promise<ActiveInstancesResult> {
  const { instancesDir } = deps;
  let entries: string[];
  try {
    entries = await readdir(instancesDir);
  } catch {
    return { count: 0, instances: [] };
  }

  const liveInstances: InstanceInfo[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const filePath = join(instancesDir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const info = parseInstanceFile(raw);
    if (info === null) {
      // Corrupt file — remove it
      try {
        await unlink(filePath);
      } catch {
        // Best-effort
      }
      continue;
    }

    if (isProcessAlive(info.pid)) {
      liveInstances.push(info);
    } else {
      // Stale entry — dead PID, remove the file
      try {
        await unlink(filePath);
      } catch {
        // Best-effort: may already be removed by another instance
      }
    }
  }

  return { count: liveInstances.length, instances: liveInstances };
}

/**
 * Reset module-level state. Exposed for testing only.
 */
export function _resetRegisteredDir(): void {
  registeredDir = null;
}
