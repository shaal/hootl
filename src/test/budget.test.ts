import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  getTodaysCost,
  isGlobalBudgetExceeded,
  checkGlobalBudget,
} from "../budget.js";

function makeTmpDir(): string {
  return join(tmpdir(), `hootl-budget-test-${randomUUID()}`);
}

function todayPrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayPrefix(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function tomorrowPrefix(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("getTodaysCost", () => {
  it("returns 0 when cost.csv does not exist", async () => {
    const dir = makeTmpDir();
    const result = await getTodaysCost(dir);
    assert.equal(result, 0);
  });

  it("returns 0 for an empty file", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cost.csv"), "", "utf-8");
    const result = await getTodaysCost(dir);
    assert.equal(result, 0);
    await rm(dir, { recursive: true });
  });

  it("sums only today's entries", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const today = todayPrefix();
    const yesterday = yesterdayPrefix();
    const csv = [
      `${today}T10:00:00.000Z,task-1,plan,0.01`,
      `${yesterday}T10:00:00.000Z,task-1,execute,0.50`,
      `${today}T11:00:00.000Z,task-1,review,0.02`,
      `${today}T12:00:00.000Z,task-2,plan,0.005`,
    ].join("\n") + "\n";
    await writeFile(join(dir, "cost.csv"), csv, "utf-8");

    const result = await getTodaysCost(dir);
    // 0.01 + 0.02 + 0.005 = 0.035
    assert.equal(Math.round(result * 10000) / 10000, 0.035);
    await rm(dir, { recursive: true });
  });

  it("excludes yesterday and tomorrow entries", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const yesterday = yesterdayPrefix();
    const tomorrow = tomorrowPrefix();
    const csv = [
      `${yesterday}T23:59:59.000Z,task-1,plan,1.00`,
      `${tomorrow}T00:00:00.000Z,task-1,execute,2.00`,
    ].join("\n") + "\n";
    await writeFile(join(dir, "cost.csv"), csv, "utf-8");

    const result = await getTodaysCost(dir);
    assert.equal(result, 0);
    await rm(dir, { recursive: true });
  });

  it("skips malformed lines gracefully", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const today = todayPrefix();
    const csv = [
      `${today}T10:00:00.000Z,task-1,plan,0.05`,
      `${today}T10:01:00.000Z,bad-line-no-commas`,
      `not-a-timestamp,task-1,plan,0.10`,
      `${today}T10:02:00.000Z,task-1,review,notanumber`,
      `${today}T10:03:00.000Z,task-1,execute,0.03`,
      ``,
    ].join("\n");
    await writeFile(join(dir, "cost.csv"), csv, "utf-8");

    const result = await getTodaysCost(dir);
    // 0.05 + 0.03 = 0.08 (second today line has no comma-separated cost, fourth has NaN cost)
    assert.equal(Math.round(result * 10000) / 10000, 0.08);
    await rm(dir, { recursive: true });
  });

  it("handles a single entry", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const today = todayPrefix();
    await writeFile(
      join(dir, "cost.csv"),
      `${today}T08:00:00.000Z,task-1,plan,0.1234\n`,
      "utf-8",
    );

    const result = await getTodaysCost(dir);
    assert.equal(result, 0.1234);
    await rm(dir, { recursive: true });
  });
});

describe("isGlobalBudgetExceeded", () => {
  it("returns false when cost is below limit", () => {
    assert.equal(isGlobalBudgetExceeded(49.99, 50.0), false);
  });

  it("returns true when cost equals limit", () => {
    assert.equal(isGlobalBudgetExceeded(50.0, 50.0), true);
  });

  it("returns true when cost exceeds limit", () => {
    assert.equal(isGlobalBudgetExceeded(50.01, 50.0), true);
  });

  it("returns false for zero cost", () => {
    assert.equal(isGlobalBudgetExceeded(0, 50.0), false);
  });
});

describe("checkGlobalBudget", () => {
  it("returns exceeded=false when no CSV exists", async () => {
    const dir = makeTmpDir();
    const result = await checkGlobalBudget(dir, 50.0);
    assert.equal(result.exceeded, false);
    assert.equal(result.todayCost, 0);
  });

  it("returns exceeded=true when today's cost meets the limit", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const today = todayPrefix();
    const csv = [
      `${today}T10:00:00.000Z,task-1,plan,25.00`,
      `${today}T11:00:00.000Z,task-1,execute,25.00`,
    ].join("\n") + "\n";
    await writeFile(join(dir, "cost.csv"), csv, "utf-8");

    const result = await checkGlobalBudget(dir, 50.0);
    assert.equal(result.exceeded, true);
    assert.equal(result.todayCost, 50.0);
    await rm(dir, { recursive: true });
  });
});
