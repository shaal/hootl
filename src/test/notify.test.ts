import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notify, type NotifyDeps } from "../notify.js";
import type { Config } from "../config.js";
import { ConfigSchema } from "../config.js";

function makeConfig(osNotify: boolean): Config {
  return ConfigSchema.parse({ notifications: { osNotify } });
}

function makeTrackingDeps(platform: NodeJS.Platform): {
  deps: NotifyDeps;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const deps: NotifyDeps = {
    execFn: async (cmd, args) => {
      calls.push({ cmd, args });
    },
    platform,
  };
  return { deps, calls };
}

describe("notify", () => {
  it("does nothing when osNotify is false", async () => {
    const { deps, calls } = makeTrackingDeps("darwin");
    await notify("Title", "Message", makeConfig(false), deps);
    assert.equal(calls.length, 0);
  });

  it("calls osascript on darwin", async () => {
    const { deps, calls } = makeTrackingDeps("darwin");
    await notify("Task Done", "Hello world", makeConfig(true), deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "osascript");
    assert.deepEqual(calls[0]!.args, [
      "-e",
      'display notification "Hello world" with title "Task Done"',
    ]);
  });

  it("calls notify-send on linux", async () => {
    const { deps, calls } = makeTrackingDeps("linux");
    await notify("Title", "Body text", makeConfig(true), deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "notify-send");
    assert.deepEqual(calls[0]!.args, ["Title", "Body text"]);
  });

  it("does nothing on unsupported platforms", async () => {
    const { deps, calls } = makeTrackingDeps("win32");
    await notify("Title", "Message", makeConfig(true), deps);
    assert.equal(calls.length, 0);
  });

  it("does not throw when execFn throws", async () => {
    const deps: NotifyDeps = {
      execFn: async () => {
        throw new Error("osascript not found");
      },
      platform: "darwin",
    };
    // Should not throw
    await notify("Title", "Message", makeConfig(true), deps);
  });

  it("escapes double quotes in osascript args", async () => {
    const { deps, calls } = makeTrackingDeps("darwin");
    await notify('Say "hi"', 'He said "hello"', makeConfig(true), deps);
    assert.equal(calls.length, 1);
    const script = calls[0]!.args[1]!;
    assert.ok(script.includes('He said \\"hello\\"'), `script should escape quotes: ${script}`);
    assert.ok(script.includes('Say \\"hi\\"'), `title should escape quotes: ${script}`);
  });

  it("escapes backslashes in osascript args", async () => {
    const { deps, calls } = makeTrackingDeps("darwin");
    await notify("Title", "path\\to\\file", makeConfig(true), deps);
    assert.equal(calls.length, 1);
    const script = calls[0]!.args[1]!;
    assert.ok(script.includes("path\\\\to\\\\file"), `should escape backslashes: ${script}`);
  });

  it("does not escape for notify-send (linux)", async () => {
    const { deps, calls } = makeTrackingDeps("linux");
    await notify('Say "hi"', 'path\\to\\file', makeConfig(true), deps);
    assert.equal(calls.length, 1);
    // notify-send receives raw strings — no escaping needed
    assert.deepEqual(calls[0]!.args, ['Say "hi"', 'path\\to\\file']);
  });
});
