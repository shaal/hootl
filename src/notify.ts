import { execa } from "execa";
import type { Config } from "./config.js";

/**
 * Dependencies for notify(), injectable for testing.
 */
export interface NotifyDeps {
  execFn: (cmd: string, args: string[]) => Promise<unknown>;
  platform: NodeJS.Platform;
}

const defaultDeps: NotifyDeps = {
  execFn: (cmd, args) => execa(cmd, args),
  platform: process.platform,
};

/**
 * Escape double quotes and backslashes for safe embedding in osascript strings.
 */
function sanitizeForOsascript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send an OS notification if config.notifications.osNotify is enabled.
 *
 * - macOS: uses `osascript -e 'display notification ...'`
 * - Linux: uses `notify-send`
 * - Other platforms: no-op
 *
 * Never throws — notification failures are silently ignored.
 */
export async function notify(
  title: string,
  message: string,
  config: Config,
  deps: NotifyDeps = defaultDeps,
): Promise<void> {
  if (!config.notifications.osNotify) return;

  try {
    if (deps.platform === "darwin") {
      const safeTitle = sanitizeForOsascript(title);
      const safeMessage = sanitizeForOsascript(message);
      await deps.execFn("osascript", [
        "-e",
        `display notification "${safeMessage}" with title "${safeTitle}"`,
      ]);
    } else if (deps.platform === "linux") {
      await deps.execFn("notify-send", [title, message]);
    }
    // Other platforms: no-op
  } catch {
    // Notification failures must never crash the loop
  }
}
