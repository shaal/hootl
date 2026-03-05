import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ConfigSchema } from "./config.js";
import { uiConfirm } from "./ui.js";

export interface InitOptions {
  interactive?: boolean;
  /** Override for uiConfirm — used in tests to avoid TTY dependency. */
  confirm?: (question: string) => Promise<boolean>;
}

const DEFAULT_HOOK = {
  trigger: "on_confidence_met" as const,
  skill: "simplify",
  blocking: true,
};

const HOOKS_EXAMPLE = {
  _comment: "Example hook configurations for .hootl/config.json. Copy the ones you need into your config's 'hooks' array.",
  available_triggers: [
    "on_confidence_met — Fires when review confidence reaches the target. Blocking hooks here prevent merge/PR.",
    "on_review_complete — Fires after every review phase. Advisory by default.",
    "on_blocked — Fires when a task moves to blocked state.",
    "on_execute_start — Fires before the execute phase begins.",
  ],
  hook_fields: {
    trigger: "Required. One of: on_confidence_met, on_review_complete, on_blocked, on_execute_start",
    skill: "Named skill to run (e.g. 'simplify'). Mutually exclusive with 'prompt' (at least one required).",
    prompt: "Inline prompt string or file path. Mutually exclusive with 'skill' (at least one required).",
    blocking: "Boolean (default false). When true at on_confidence_met, failure keeps task in_progress.",
    conditions: {
      minConfidence: "Number. Hook only fires when confidence >= this value.",
    },
  },
  examples: [
    {
      _description: "Default: run simplify skill when confidence target is met (blocking)",
      trigger: "on_confidence_met",
      skill: "simplify",
      blocking: true,
    },
    {
      _description: "Custom prompt hook: run a security review before merging",
      trigger: "on_confidence_met",
      prompt: "Review the git diff for security issues: hardcoded secrets, SQL injection, XSS. Output JSON with 'passed' (boolean) and 'fixes_applied' (string[]).",
      blocking: true,
    },
    {
      _description: "Conditional advisory hook: log review results when confidence is high",
      trigger: "on_review_complete",
      prompt: "Summarize what was tested and what the confidence score means.",
      blocking: false,
      conditions: { minConfidence: 80 },
    },
    {
      _description: "Execute-start hook: remind about coding standards",
      trigger: "on_execute_start",
      prompt: "templates/coding-standards.md",
      blocking: false,
    },
  ],
};

/**
 * Initializes the .hootl/ directory structure if it does not exist.
 *
 * When called with `interactive: true` (explicit `hootl init` command),
 * prompts the user whether to include the default simplify hook.
 * When called without options (silent auto-init from other commands),
 * writes config with Zod defaults (empty hooks array).
 *
 * Always creates .hootl/hooks-example.json as a reference.
 */
export async function autoInit(options?: InitOptions): Promise<void> {
  const hootlDir = join(process.cwd(), ".hootl");
  if (existsSync(hootlDir)) {
    return;
  }

  await mkdir(join(hootlDir, "tasks"), { recursive: true });
  await mkdir(join(hootlDir, "logs"), { recursive: true });

  const configData: Record<string, unknown> = {};

  if (options?.interactive) {
    const confirmFn = options.confirm ?? uiConfirm;
    const enableHook = await confirmFn(
      "Enable default code quality hook (simplify on confidence met)?",
    );
    configData.hooks = enableHook ? [DEFAULT_HOOK] : [];
  }

  const config = ConfigSchema.parse(configData);
  await writeFile(
    join(hootlDir, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );

  await writeFile(
    join(hootlDir, "hooks-example.json"),
    JSON.stringify(HOOKS_EXAMPLE, null, 2) + "\n",
    "utf-8",
  );

  await writeFile(
    join(hootlDir, ".gitignore"),
    "tasks/\nlogs/\nstatus.md\n",
    "utf-8",
  );
}
