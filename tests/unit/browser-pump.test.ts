import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPump,
  type BrowserDriver,
  type BrowserPumpFailure,
} from "../../apps/desktop/bridge/browser.ts";
import { BridgeError, Client } from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import type {
  BrowserCommand,
  BrowserControlFact,
  BrowserVerification,
  BrowserBinding,
  BrowserSend,
  BrowserSelection,
  Json,
  Request,
} from "../../apps/desktop/bridge/wire.ts";

// Actual framed Client and pump; in-memory child pipes and controlled physical
// driver only. This is not an Electron, Go process or provider journey.
const context = { profileId: "profile", backendGeneration: "backend" };
const binding: BrowserBinding = {
  providerState: "bound",
  lease: {
    identity: {
      profileId: "profile",
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      turnId: "turn",
      operationId: "operation",
      turnGeneration: "1",
    },
    backendGeneration: "backend",
    slotOrdinal: 1,
    slotGeneration: "1",
  },
  viewId: "view",
  viewGeneration: "1",
  documentGeneration: "1",
  conversationId: "conversation",
};
const selection: BrowserSelection = {
  provider: "chatgpt",
  alias: "default",
  accountId: "account",
  modelId: "model",
  effort: "high",
  mode: "normal",
  connectorId: "",
  connectorGrantId: "",
  toolsEnabled: false,
};
const required = { model: true, effort: true, mode: false, connector: false };
const fact = (value: string): BrowserControlFact => ({
  source: "public-control",
  value,
  literal: value,
});
const verification: BrowserVerification = {
  pinned: selection,
  required,
  binding,
  observed: {
    model: fact("model"),
    effort: fact("high"),
    mode: fact("normal"),
    connector: { source: "unknown", value: "", literal: "" },
    observedAtMillis: "1791053000000",
  },
  previousUserTurnId: "user",
  previousReplyId: "reply",
  intentDigest: "a".repeat(64),
  evidenceId: "evidence",
};
function command(kind: BrowserCommand["kind"], id = kind): BrowserCommand {
  const deadlineMillis = String(Date.now() + 10000);
  const bodies = {
    prepare: {
      target: {
        required,
        mode: "owned-saved",
        conversationId: "conversation",
        previousUserTurnId: "user",
        previousReplyId: "reply",
        selection,
        resolution: {
          requestedAlias: "default",
          requestedExecutor: "browser",
          requestedEffort: "high",
          requestedMode: "normal",
          configSHA256: "a".repeat(64),
          translationId: "translation",
          resolved: selection,
        },
      },
      lease: binding.lease,
      deadlineMillis,
    },
    "verify-send": {
      binding,
      requested: selection,
      required,
      previousUserTurnId: "user",
      previousReplyId: "reply",
      intentDigest: verification.intentDigest,
      deadlineMillis,
    },
    send: {
      binding,
      verification,
      intentDigest: verification.intentDigest,
      prompt: "Synthetic prompt",
      deadlineMillis,
    },
    observe: { binding, afterSequence: "0", limit: 128, deadlineMillis },
    cancel: { binding, deadlineMillis },
    dispose: { lease: binding.lease, deadlineMillis },
  };
  return { commandId: id, kind, body: bodies[kind] as unknown as Json };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(onFailure?: (failure: BrowserPumpFailure) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const calls: Request[] = [],
    polls: Request[] = [],
    replies: Request[] = [];
  const answer = (
    r: Request,
    data: unknown,
    extra: Record<string, unknown> = {},
  ) =>
    child.stdout.write(
      frame({
        jsonrpc: "2.0",
        id: r.id,
        result: {
          status: "ok",
          requestId: r.id,
          context,
          ...(r.params.operationId
            ? { operationId: r.params.operationId }
            : {}),
          data,
          ...extra,
        },
      }),
    );
  let acknowledge = true;
  const decoder = new Decoder();
  child.stdin.on("data", (bytes: Buffer) =>
    decoder.push(bytes, (raw) => {
      const r = raw as Request;
      calls.push(r);
      if (r.method === "core.handshake")
        answer(r, {
          protocolMajor: 1,
          protocolMinor: 0,
          buildId: "build",
          ...context,
          capabilities: [],
          maxFrameBytes: 1048576,
        });
      else if (r.method === "chat.browser.next") polls.push(r);
      else if (r.method === "chat.browser.reply") {
        replies.push(r);
        if (acknowledge) answer(r, {});
      } else throw new Error("unexpected method");
    }),
  );
  const driver = {
    prepare: vi.fn(async () => ({
      saved: true,
      readiness: "ready" as const,
      binding,
      code: "",
    })),
    verifySend: vi.fn(async () => ({ verification })),
    send: vi.fn(async () => ({
      binding,
      verificationId: "evidence",
      status: "submitted" as const,
      code: "",
    })),
    observe: vi.fn(async () => ({ events: [], gap: false })),
    cancel: vi.fn(async () => ({
      binding,
      status: "confirmed-terminal" as const,
      code: "",
    })),
    dispose: vi.fn(async () => ({
      lease: binding.lease,
      confirmed: true,
      code: "",
    })),
  } satisfies BrowserDriver;
  const client = new Client(child as unknown as ChildProcessWithoutNullStreams);
  await client.handshake(
    {
      protocolMajor: 1,
      protocolMinor: 0,
      buildId: "build",
      profileId: "profile",
    },
    1000,
  );
  const pump = new BrowserPump(client, driver, onFailure);
  cleanups.push(async () => {
    await client.close();
    await pump.stop();
  });
  pump.start();
  return {
    pump,
    driver,
    calls,
    replies,
    client,
    child,
    answer,
    noAck: () => {
      acknowledge = false;
    },
    deliver: async (c: BrowserCommand) => {
      await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
      answer(polls.shift()!, { command: c });
    },
  };
}
describe("one-shot typed browser pump", () => {
  it("reports the first bounded driver failure without changing the one-shot fence", async () => {
    const report = vi.fn();
    const f = await fixture(report);
    f.driver.prepare.mockRejectedValueOnce(
      new BridgeError("refused", "host_browser_prepare_invalid"),
    );
    await f.deliver(command("prepare"));
    await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: "execute",
      kind: "prepare",
      state: "refused",
      code: "host_browser_prepare_invalid",
    });
    f.child.emit("close", 0, null);
    await f.pump.stop();
    expect(report).toHaveBeenCalledTimes(1);
    expect(f.driver.prepare).toHaveBeenCalledTimes(1);
    expect(f.replies).toHaveLength(0);
    expect(() => f.pump.start()).toThrow("browser_pump_already_started");
  });
  it.each([
    new Error("private prompt https://private.invalid secret"),
    new BridgeError("unknown", "private prompt https://private.invalid secret"),
  ])(
    "does not publish arbitrary failure content or permit diagnostic failure to clear uncertainty",
    async (error) => {
      const report = vi.fn(() => {
        throw new Error("diagnostic sink failed");
      });
      const f = await fixture(report);
      f.driver.send.mockRejectedValueOnce(error);
      await f.deliver(command("send"));
      await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
      expect(report).toHaveBeenCalledExactlyOnceWith({
        stage: "execute",
        kind: "send",
        state: "unknown",
        code: "browser_unclassified_failure",
      });
      expect(JSON.stringify(report.mock.calls)).not.toMatch(
        /private|secret|prompt/,
      );
      expect(f.driver.send).toHaveBeenCalledTimes(1);
      expect(f.replies).toHaveLength(0);
    },
  );
  it("dispatches six closed operations through correlated framed replies", async () => {
    const f = await fixture();
    for (const kind of [
      "prepare",
      "verify-send",
      "send",
      "observe",
      "cancel",
      "dispose",
    ] as const) {
      await f.deliver(command(kind));
      await vi.waitFor(() =>
        expect(
          f.replies.some(
            (r) => (r.params.body as Record<string, Json>).commandId === kind,
          ),
        ).toBe(true),
      );
    }
    expect(f.replies).toHaveLength(6);
    expect(f.driver.send).toHaveBeenCalledTimes(1);
    expect(f.pump.state).toBe("running");
    expect(f.calls.filter((r) => r.method === "core.handshake")).toHaveLength(
      1,
    );
    for (const r of f.replies)
      expect(r.params.operationId).toBe(
        (r.params.body as Record<string, Json>).commandId,
      );
  });
  it("never dispatches a replayed command ID after a successful Send", async () => {
    const f = await fixture();
    const c = command("send");
    await f.deliver(c);
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    await f.deliver(c);
    await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
    expect(f.driver.send).toHaveBeenCalledTimes(1);
    expect(f.replies).toHaveLength(1);
    expect(() => f.pump.start()).toThrow("browser_pump_already_started");
  });
  it("latches a physical Send with unknown outcome without resending or replying success", async () => {
    const f = await fixture();
    f.driver.send.mockRejectedValueOnce(new Error("acceptance ACK lost"));
    await f.deliver(command("send"));
    await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
    expect(f.driver.send).toHaveBeenCalledTimes(1);
    expect(f.replies).toHaveLength(0);
  });
  it("does not repeat a physical Send after a lost core acknowledgement", async () => {
    const f = await fixture();
    f.noAck();
    await f.deliver(command("send"));
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    f.child.emit("close", 0, null);
    await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
    expect(f.driver.send).toHaveBeenCalledTimes(1);
    expect(f.replies).toHaveLength(1);
  });
  it.each(["profile", "deadline", "shape"])(
    "refuses a %s mismatch before the physical capability",
    async (fault) => {
      const f = await fixture();
      const c = { ...structuredClone(command("send")) };
      const b = c.body as unknown as BrowserSend;
      if (fault === "profile")
        c.body = {
          ...b,
          binding: {
            ...b.binding,
            lease: {
              ...b.binding.lease,
              identity: { ...b.binding.lease.identity, profileId: "foreign" },
            },
          },
        } as unknown as Json;
      if (fault === "deadline")
        c.body = {
          ...b,
          deadlineMillis: String(Date.now() - 1),
        } as unknown as Json;
      if (fault === "shape")
        c.body = { ...b, prompt: "x".repeat(8193) } as unknown as Json;
      await f.deliver(c);
      await vi.waitFor(() => expect(f.pump.state).toBe("unknown"));
      expect(f.driver.send).not.toHaveBeenCalled();
      expect(f.replies).toHaveLength(0);
    },
  );
  it("services an independent observation while a physical Send remains held", async () => {
    const f = await fixture();
    let release!: (value: Awaited<ReturnType<typeof f.driver.send>>) => void;
    f.driver.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.deliver(command("send"));
    await vi.waitFor(() => expect(f.driver.send).toHaveBeenCalledTimes(1));
    await f.deliver(command("observe"));
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    expect((f.replies[0]!.params.body as Record<string, Json>).kind).toBe(
      "observe",
    );
    release({
      binding,
      verificationId: "evidence",
      status: "submitted",
      code: "",
    });
    await vi.waitFor(() => expect(f.replies).toHaveLength(2));
    expect(f.pump.state).toBe("running");
  });
});
