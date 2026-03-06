import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readFile } from "node:fs/promises";

import {
  ConfigSchema,
  loadJsonFile,
  applyEnvOverrides,
  loadConfig,
  getProjectDir,
  resolveOnConfidenceMode,
  setNestedValue,
  saveGlobalConfig,
  saveProjectConfig,
  coerceEnvValue,
  type OnConfidenceMode,
  type Hook,
  type HookTrigger,
} from "../config.js";

describe("ConfigSchema", () => {
  it("parse({}) produces full defaults", () => {
    const config = ConfigSchema.parse({});

    assert.equal(config.taskBackend, "local");
    assert.equal(config.permissionMode, "default");

    assert.equal(config.budgets.perSession, 0.5);
    assert.equal(config.budgets.perTask, 5.0);
    assert.equal(config.budgets.global, 50.0);
    assert.equal(config.budgets.maxAttemptsPerTask, 10);

    assert.equal(config.confidence.target, 95);
    assert.equal(config.confidence.requireTests, true);

    assert.equal(config.git.useWorktrees, false);
    assert.equal(config.git.autoPR, true);
    assert.equal(config.git.branchPrefix, "hootl/");

    assert.equal(config.auto.defaultLevel, "proactive");
    assert.equal(config.auto.maxParallel, 1);

    assert.equal(config.notifications.terminal, true);
    assert.equal(config.notifications.osNotify, false);
    assert.equal(config.notifications.summaryFile, true);
    assert.equal(config.notifications.webhook, null);
  });

  it("parse with override applies only that field", () => {
    const config = ConfigSchema.parse({ taskBackend: "github" });

    assert.equal(config.taskBackend, "github");
    // Other fields remain defaults
    assert.equal(config.budgets.perSession, 0.5);
    assert.equal(config.confidence.target, 95);
  });

  it("invalid taskBackend throws", () => {
    assert.throws(() => ConfigSchema.parse({ taskBackend: "invalid" }));
  });
});

describe("loadJsonFile", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("valid JSON file returns parsed object", async () => {
    const filePath = join(tmpDir, "valid.json");
    await writeFile(filePath, JSON.stringify({ taskBackend: "github" }));

    const result = await loadJsonFile(filePath);
    assert.deepEqual(result, { taskBackend: "github" });
  });

  it("non-existent file returns empty object", async () => {
    const result = await loadJsonFile(join(tmpDir, "nope.json"));
    assert.deepEqual(result, {});
  });

  it("invalid JSON file throws", async () => {
    const filePath = join(tmpDir, "bad.json");
    await writeFile(filePath, "not json {{{");

    await assert.rejects(() => loadJsonFile(filePath));
  });
});

describe("applyEnvOverrides", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "HOOTL_TASK_BACKEND",
    "HOOTL_BUDGET_PER_SESSION",
    "HOOTL_CONFIDENCE_REQUIRE_TESTS",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("HOOTL_TASK_BACKEND overrides taskBackend", () => {
    process.env.HOOTL_TASK_BACKEND = "github";
    const result = applyEnvOverrides({});
    assert.equal(result.taskBackend, "github");
  });

  it("HOOTL_BUDGET_PER_SESSION overrides budgets.perSession with number coercion", () => {
    process.env.HOOTL_BUDGET_PER_SESSION = "1.25";
    const result = applyEnvOverrides({});
    const budgets = result.budgets as Record<string, unknown>;
    assert.equal(budgets.perSession, 1.25);
  });

  it("HOOTL_CONFIDENCE_REQUIRE_TESTS=false overrides to boolean false", () => {
    process.env.HOOTL_CONFIDENCE_REQUIRE_TESTS = "false";
    const result = applyEnvOverrides({});
    const confidence = result.confidence as Record<string, unknown>;
    assert.equal(confidence.requireTests, false);
  });

  it("no env vars set returns config unchanged", () => {
    const input = { taskBackend: "local", budgets: { perSession: 0.5 } };
    const result = applyEnvOverrides(input);
    assert.deepEqual(result, input);
  });

  it("creates nested objects if they don't exist", () => {
    process.env.HOOTL_BUDGET_PER_SESSION = "2.0";
    const result = applyEnvOverrides({});
    const budgets = result.budgets as Record<string, unknown>;
    assert.equal(budgets.perSession, 2.0);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("with no config files returns defaults", async () => {
    const config = await loadConfig(tmpDir);

    assert.equal(config.taskBackend, "local");
    assert.equal(config.budgets.perSession, 0.5);
    assert.equal(config.confidence.target, 95);
  });

  it("with project config merges over defaults", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(
      join(hootlDir, "config.json"),
      JSON.stringify({ taskBackend: "beads", budgets: { perSession: 2.0 } }),
    );

    const config = await loadConfig(projectDir);

    assert.equal(config.taskBackend, "beads");
    assert.equal(config.budgets.perSession, 2.0);
    // Non-overridden defaults remain
    assert.equal(config.budgets.perTask, 5.0);
    assert.equal(config.confidence.target, 95);
  });
});

describe("getProjectDir", () => {
  it("returns cwd + /.hootl", () => {
    const result = getProjectDir();
    assert.equal(result, join(process.cwd(), ".hootl"));
  });
});

describe("ConfigSchema git.onConfidence", () => {
  it("defaults to null when not specified", () => {
    const config = ConfigSchema.parse({});
    assert.equal(config.git.onConfidence, null);
  });

  it("accepts 'merge' value", () => {
    const config = ConfigSchema.parse({ git: { onConfidence: "merge" } });
    assert.equal(config.git.onConfidence, "merge");
  });

  it("accepts 'pr' value", () => {
    const config = ConfigSchema.parse({ git: { onConfidence: "pr" } });
    assert.equal(config.git.onConfidence, "pr");
  });

  it("accepts 'none' value", () => {
    const config = ConfigSchema.parse({ git: { onConfidence: "none" } });
    assert.equal(config.git.onConfidence, "none");
  });

  it("rejects invalid values", () => {
    assert.throws(() => ConfigSchema.parse({ git: { onConfidence: "invalid" } }));
  });
});

describe("resolveOnConfidenceMode", () => {
  function makeConfig(overrides: { onConfidence?: OnConfidenceMode | null; defaultLevel?: string } = {}) {
    return ConfigSchema.parse({
      git: { onConfidence: overrides.onConfidence ?? null },
      auto: overrides.defaultLevel !== undefined ? { defaultLevel: overrides.defaultLevel } : {},
    });
  }

  it("CLI --merge overrides everything", () => {
    const config = makeConfig({ onConfidence: "none", defaultLevel: "conservative" });
    assert.equal(resolveOnConfidenceMode(config, true, false), "merge");
  });

  it("CLI --no-merge overrides everything", () => {
    const config = makeConfig({ onConfidence: "merge", defaultLevel: "full" });
    assert.equal(resolveOnConfidenceMode(config, false, true), "none");
  });

  it("explicit config 'pr' overrides auto-level inference", () => {
    const config = makeConfig({ onConfidence: "pr", defaultLevel: "full" });
    assert.equal(resolveOnConfidenceMode(config), "pr");
  });

  it("explicit config 'none' overrides auto-level inference", () => {
    const config = makeConfig({ onConfidence: "none", defaultLevel: "full" });
    assert.equal(resolveOnConfidenceMode(config), "none");
  });

  it("infers 'none' from conservative auto level", () => {
    const config = makeConfig({ defaultLevel: "conservative" });
    assert.equal(resolveOnConfidenceMode(config), "none");
  });

  it("infers 'pr' from moderate auto level", () => {
    const config = makeConfig({ defaultLevel: "moderate" });
    assert.equal(resolveOnConfidenceMode(config), "pr");
  });

  it("infers 'merge' from proactive auto level", () => {
    const config = makeConfig({ defaultLevel: "proactive" });
    assert.equal(resolveOnConfidenceMode(config), "merge");
  });

  it("infers 'merge' from full auto level", () => {
    const config = makeConfig({ defaultLevel: "full" });
    assert.equal(resolveOnConfidenceMode(config), "merge");
  });

  it("--merge takes priority over --no-merge when both provided", () => {
    const config = makeConfig();
    assert.equal(resolveOnConfidenceMode(config, true, true), "merge");
  });
});

describe("ConfigSchema hooks", () => {
  it("defaults to empty array", () => {
    const config = ConfigSchema.parse({});
    assert.deepEqual(config.hooks, []);
  });

  it("accepts a single fully-specified hook", () => {
    const hook = {
      trigger: "on_confidence_met" as const,
      prompt: "Check for security issues",
      blocking: true,
      conditions: { minConfidence: 90 },
    };
    const config = ConfigSchema.parse({ hooks: [hook] });
    assert.equal(config.hooks.length, 1);
    const h = config.hooks[0] as Hook;
    assert.equal(h.trigger, "on_confidence_met");
    assert.equal(h.prompt, "Check for security issues");
    assert.equal(h.blocking, true);
    assert.equal(h.conditions?.minConfidence, 90);
  });

  it("accepts multiple hooks with same trigger, preserving order", () => {
    const hooks = [
      { trigger: "on_review_complete" as const, prompt: "First check" },
      { trigger: "on_review_complete" as const, prompt: "Second check" },
    ];
    const config = ConfigSchema.parse({ hooks });
    assert.equal(config.hooks.length, 2);
    assert.equal((config.hooks[0] as Hook).prompt, "First check");
    assert.equal((config.hooks[1] as Hook).prompt, "Second check");
  });

  it("blocking defaults to false", () => {
    const config = ConfigSchema.parse({
      hooks: [{ trigger: "on_blocked", prompt: "Notify team" }],
    });
    assert.equal((config.hooks[0] as Hook).blocking, false);
  });

  it("conditions are optional", () => {
    const config = ConfigSchema.parse({
      hooks: [{ trigger: "on_execute_start", prompt: "Log start" }],
    });
    assert.equal((config.hooks[0] as Hook).conditions, undefined);
  });

  it("conditions.minConfidence works", () => {
    const config = ConfigSchema.parse({
      hooks: [
        {
          trigger: "on_confidence_met",
          prompt: "Final review",
          conditions: { minConfidence: 80 },
        },
      ],
    });
    assert.equal((config.hooks[0] as Hook).conditions?.minConfidence, 80);
  });

  it("accepts all valid trigger values", () => {
    const triggers: HookTrigger[] = [
      "on_confidence_met",
      "on_review_complete",
      "on_blocked",
      "on_execute_start",
    ];
    for (const trigger of triggers) {
      const config = ConfigSchema.parse({
        hooks: [{ trigger, prompt: "test" }],
      });
      assert.equal((config.hooks[0] as Hook).trigger, trigger);
    }
  });

  it("rejects invalid trigger", () => {
    assert.throws(() =>
      ConfigSchema.parse({
        hooks: [{ trigger: "invalid_trigger", prompt: "test" }],
      }),
    );
  });

  it("rejects non-string prompt", () => {
    assert.throws(() =>
      ConfigSchema.parse({
        hooks: [{ trigger: "on_blocked", prompt: 123 }],
      }),
    );
  });

  it("accepts template path as prompt", () => {
    const config = ConfigSchema.parse({
      hooks: [
        { trigger: "on_confidence_met", prompt: "templates/security-check.md" },
      ],
    });
    assert.equal(
      (config.hooks[0] as Hook).prompt,
      "templates/security-check.md",
    );
  });
});

describe("loadConfig with hooks", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-hooks-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("project hooks replace global hooks (array replacement via deepMerge)", async () => {
    // Simulate global config with hooks by creating a project dir
    // that has hooks — since deepMerge replaces arrays wholesale,
    // project hooks fully replace any global hooks
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(
      join(hootlDir, "config.json"),
      JSON.stringify({
        hooks: [
          { trigger: "on_blocked", prompt: "Project-specific check", blocking: true },
        ],
      }),
    );

    const config = await loadConfig(projectDir);
    assert.equal(config.hooks.length, 1);
    assert.equal((config.hooks[0] as Hook).trigger, "on_blocked");
    assert.equal((config.hooks[0] as Hook).prompt, "Project-specific check");
    assert.equal((config.hooks[0] as Hook).blocking, true);
  });
});

describe("setNestedValue", () => {
  it("sets a top-level key", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "taskBackend", "github");
    assert.deepEqual(obj, { taskBackend: "github" });
  });

  it("sets a nested key", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "budgets.perTask", 10);
    assert.deepEqual(obj, { budgets: { perTask: 10 } });
  });

  it("preserves existing sibling keys", () => {
    const obj: Record<string, unknown> = { budgets: { perSession: 0.5 } };
    setNestedValue(obj, "budgets.perTask", 10);
    assert.deepEqual(obj, { budgets: { perSession: 0.5, perTask: 10 } });
  });

  it("creates intermediate objects for deep paths", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a.b.c", true);
    assert.deepEqual(obj, { a: { b: { c: true } } });
  });

  it("overwrites non-object intermediate with object", () => {
    const obj: Record<string, unknown> = { a: "string" };
    setNestedValue(obj, "a.b", 1);
    assert.deepEqual(obj, { a: { b: 1 } });
  });

  it("overwrites array intermediate with object", () => {
    const obj: Record<string, unknown> = { a: [1, 2, 3] };
    setNestedValue(obj, "a.b", "value");
    assert.deepEqual(obj, { a: { b: "value" } });
  });
});

describe("coerceEnvValue", () => {
  it("coerces 'true' to boolean true", () => {
    assert.equal(coerceEnvValue("true"), true);
  });

  it("coerces 'false' to boolean false", () => {
    assert.equal(coerceEnvValue("false"), false);
  });

  it("coerces numeric strings to numbers", () => {
    assert.equal(coerceEnvValue("42"), 42);
    assert.equal(coerceEnvValue("3.14"), 3.14);
    assert.equal(coerceEnvValue("0"), 0);
  });

  it("keeps non-numeric strings as strings", () => {
    assert.equal(coerceEnvValue("hello"), "hello");
    assert.equal(coerceEnvValue(""), "");
  });
});

describe("saveGlobalConfig", () => {
  let tmpDir: string;
  let origHome: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hootl-global-cfg-"));
    origHome = process.env["HOME"] ?? "";
    // Temporarily override HOME so saveGlobalConfig writes to our temp dir
    // This won't work since homedir() may be cached, so we test saveProjectConfig pattern instead
  });

  after(async () => {
    process.env["HOME"] = origHome;
    await rm(tmpDir, { recursive: true });
  });

  it("saveProjectConfig creates file with correct nested content", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(join(hootlDir, "config.json"), "{}\n", "utf-8");

    await saveProjectConfig((raw) => {
      setNestedValue(raw, "budgets.perTask", 10);
    }, projectDir);

    const content = JSON.parse(await readFile(join(hootlDir, "config.json"), "utf-8")) as Record<string, unknown>;
    assert.deepEqual(content, { budgets: { perTask: 10 } });
  });

  it("saveProjectConfig reads existing config and applies mutation", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(
      join(hootlDir, "config.json"),
      JSON.stringify({ budgets: { perSession: 0.5 }, taskBackend: "local" }),
    );

    await saveProjectConfig((raw) => {
      setNestedValue(raw, "budgets.perTask", 10);
    }, projectDir);

    const content = JSON.parse(await readFile(join(hootlDir, "config.json"), "utf-8")) as Record<string, unknown>;
    const budgets = content["budgets"] as Record<string, unknown>;
    assert.equal(budgets["perSession"], 0.5);
    assert.equal(budgets["perTask"], 10);
    assert.equal(content["taskBackend"], "local");
  });

  it("coerces boolean values correctly via setNestedValue", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(join(hootlDir, "config.json"), "{}\n", "utf-8");

    const value = coerceEnvValue("false");
    await saveProjectConfig((raw) => {
      setNestedValue(raw, "confidence.requireTests", value);
    }, projectDir);

    const content = JSON.parse(await readFile(join(hootlDir, "config.json"), "utf-8")) as Record<string, unknown>;
    const confidence = content["confidence"] as Record<string, unknown>;
    assert.equal(confidence["requireTests"], false);
  });

  it("coerces number values correctly via setNestedValue", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "proj-"));
    const hootlDir = join(projectDir, ".hootl");
    await mkdir(hootlDir, { recursive: true });
    await writeFile(join(hootlDir, "config.json"), "{}\n", "utf-8");

    const value = coerceEnvValue("25.5");
    await saveProjectConfig((raw) => {
      setNestedValue(raw, "budgets.global", value);
    }, projectDir);

    const content = JSON.parse(await readFile(join(hootlDir, "config.json"), "utf-8")) as Record<string, unknown>;
    const budgets = content["budgets"] as Record<string, unknown>;
    assert.equal(budgets["global"], 25.5);
  });
});
