import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ConfigSchema,
  loadJsonFile,
  applyEnvOverrides,
  loadConfig,
  getProjectDir,
  resolveOnConfidenceMode,
  type OnConfidenceMode,
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
