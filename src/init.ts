import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ConfigSchema } from "./config.js";

/**
 * Silently initializes the .hootl/ directory structure if it does not exist.
 * Creates tasks/, logs/, config.json (with defaults), and .gitignore.
 * No-op if .hootl/ already exists.
 */
export async function autoInit(): Promise<void> {
  const hootlDir = join(process.cwd(), ".hootl");
  if (existsSync(hootlDir)) {
    return;
  }

  await mkdir(join(hootlDir, "tasks"), { recursive: true });
  await mkdir(join(hootlDir, "logs"), { recursive: true });

  const defaultConfig = ConfigSchema.parse({});
  await writeFile(
    join(hootlDir, "config.json"),
    JSON.stringify(defaultConfig, null, 2) + "\n",
    "utf-8",
  );

  await writeFile(
    join(hootlDir, ".gitignore"),
    "tasks/\nlogs/\nstatus.md\n",
    "utf-8",
  );
}
