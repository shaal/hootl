import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyWebhook, type NotifyDeps, type WebhookDeps, type WebhookPayload } from "../notify.js";
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

function makeWebhookConfig(webhook: string | null): Config {
  return ConfigSchema.parse({ notifications: { webhook } });
}

function makeSamplePayload(overrides?: Partial<WebhookPayload>): WebhookPayload {
  return {
    taskId: "task-001",
    title: "Implement feature X",
    oldState: "in_progress",
    newState: "done",
    confidence: 95,
    timestamp: "2026-03-06T12:00:00.000Z",
    ...overrides,
  };
}

function makeTrackingFetch(): {
  deps: WebhookDeps;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deps: WebhookDeps = {
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
  };
  return { deps, calls };
}

describe("notifyWebhook", () => {
  it("does nothing when webhook is null", async () => {
    const { deps, calls } = makeTrackingFetch();
    await notifyWebhook(makeSamplePayload(), makeWebhookConfig(null), deps);
    assert.equal(calls.length, 0);
  });

  it("does nothing when webhook is empty string", async () => {
    const { deps, calls } = makeTrackingFetch();
    await notifyWebhook(makeSamplePayload(), makeWebhookConfig(""), deps);
    assert.equal(calls.length, 0);
  });

  it("POSTs correct JSON payload to configured URL", async () => {
    const { deps, calls } = makeTrackingFetch();
    const payload = makeSamplePayload();
    await notifyWebhook(payload, makeWebhookConfig("https://hooks.example.com/webhook"), deps);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, "https://hooks.example.com/webhook");
    assert.equal(call.init.method, "POST");

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");

    const body = JSON.parse(call.init.body as string) as WebhookPayload;
    assert.equal(body.taskId, "task-001");
    assert.equal(body.title, "Implement feature X");
    assert.equal(body.oldState, "in_progress");
    assert.equal(body.newState, "done");
    assert.equal(body.confidence, 95);
    assert.equal(body.timestamp, "2026-03-06T12:00:00.000Z");
  });

  it("does not throw when fetch throws", async () => {
    const deps: WebhookDeps = {
      fetchFn: (async () => {
        throw new Error("Network error");
      }) as typeof fetch,
    };
    // Should not throw
    await notifyWebhook(
      makeSamplePayload(),
      makeWebhookConfig("https://hooks.example.com/webhook"),
      deps,
    );
  });

  it("does not throw on non-2xx response", async () => {
    const deps: WebhookDeps = {
      fetchFn: (async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as typeof fetch,
    };
    // Should not throw
    await notifyWebhook(
      makeSamplePayload(),
      makeWebhookConfig("https://hooks.example.com/webhook"),
      deps,
    );
  });

  it("handles null confidence in payload", async () => {
    const { deps, calls } = makeTrackingFetch();
    const payload = makeSamplePayload({ confidence: null });
    await notifyWebhook(payload, makeWebhookConfig("https://hooks.example.com/webhook"), deps);

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]!.init.body as string) as WebhookPayload;
    assert.equal(body.confidence, null);
  });
});
