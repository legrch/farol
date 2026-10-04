import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatCallerBridge } from "../../apps/desktop/bridge/chat-caller.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import { writeGoCallerDelivery } from "../../apps/desktop/go-chat-caller-delivery.ts";
import type {
  ChatCallerDelivery,
  ChatCallerHandle,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Controlled HTTP writable and common-wire replies. No sockets/native/provider.
const handle: ChatCallerHandle = {
  ticketId: "ticket",
  handleId: "handle",
  producerOperationId: "operation",
  callId: "call",
  relayBinding: "a".repeat(64),
  requestSHA256: "b".repeat(64),
};
function delivery() {
  const data =
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":9,"text":"🍐"}\n\n';
  return {
    issuanceId: "issue",
    handle: structuredClone(handle),
    firstSequence: "4",
    lastSequence: "9",
    data,
    dataBytes: String(Buffer.byteLength(data)),
    dataSHA256: createHash("sha256").update(data).digest("hex"),
  };
}
function bridgeFixture(mutate: (out: Outcome) => Outcome = (o) => o) {
  const context = { profileId: "profile", backendGeneration: "backend" };
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) =>
      mutate({
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context,
        data: delivery() as unknown as Json,
      }),
  );
  return {
    bridge: new ChatCallerBridge({
      request,
      verifiedContext: context,
    } as unknown as Client),
    request,
  };
}
class Sink extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  write = vi.fn<(s: string, encoding?: string) => boolean>(() => true);
  asResponse() {
    return this as unknown as ServerResponse;
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("Go caller delivery bridge", () => {
  it("binds one effect to exact original handle and UTF-8 bytes", async () => {
    const f = bridgeFixture();
    expect(await f.bridge.issue(handle)).toEqual(delivery());
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("chat.caller.issue");
    expect(f.request.mock.calls[0]![2]?.operationId).toBeTruthy();
  });
  it.each([
    "handle",
    "hash",
    "bytes",
    "zero",
    "backwards",
    "too-many",
    "unknown-field",
  ])("rejects %s without fallback", async (fault) => {
    const f = bridgeFixture((o) => {
      const d = delivery();
      switch (fault) {
        case "handle":
          d.handle = { ...d.handle, ticketId: "other" };
          break;
        case "hash":
          d.dataSHA256 = "c".repeat(64);
          break;
        case "bytes":
          d.dataBytes = String(d.data.length);
          break;
        case "zero":
          d.firstSequence = "0";
          break;
        case "backwards":
          d.firstSequence = "10";
          break;
        case "too-many":
          d.lastSequence = "132";
          break;
        case "unknown-field":
          return { ...o, data: { ...d, grant: true } as unknown as Json };
      }
      return { ...o, data: d as unknown as Json };
    });
    await expect(f.bridge.issue(handle)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["requestId", "operationId", "backendGeneration"])(
    "refuses crossed common %s",
    async (field) => {
      const f = bridgeFixture((o) =>
        field === "backendGeneration"
          ? { ...o, context: { ...o.context, backendGeneration: "other" } }
          : { ...o, [field]: "other" },
      );
      await expect(f.bridge.issue(handle)).rejects.toMatchObject({
        code: "chat_caller_response_context",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains decimal sequence precision beyond Number safe range", async () => {
    const f = bridgeFixture((o) => ({
      ...o,
      data: {
        ...delivery(),
        firstSequence: "9007199254740993",
        lastSequence: "9007199254740998",
      } as unknown as Json,
    }));
    expect((await f.bridge.issue(handle)).firstSequence).toBe(
      "9007199254740993",
    );
  });
});
describe("original Go caller group physical write fence", () => {
  it("refuses an invalid cursor before requesting issuance", async () => {
    const f = bridgeFixture(),
      sink = new Sink();
    await expect(
      writeGoCallerDelivery(
        f.bridge,
        handle,
        sink.asResponse(),
        new AbortController().signal,
        "-1",
      ),
    ).rejects.toMatchObject({
      state: "refused",
      code: "chat_caller_cursor_invalid",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
  });
  it("does not write an issued group across a missing preceding frame", async () => {
    const f = bridgeFixture(),
      sink = new Sink();
    await expect(
      writeGoCallerDelivery(
        f.bridge,
        handle,
        sink.asResponse(),
        new AbortController().signal,
        "2",
      ),
    ).rejects.toMatchObject({
      state: "unknown",
      code: "chat_caller_delivery_gap",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(sink.write).not.toHaveBeenCalled();
    expect(sink.eventNames()).toEqual([]);
  });

  it("writes exact issued bytes once, with no implicit ACK/output/end", async () => {
    const f = bridgeFixture(),
      sink = new Sink(),
      abort = new AbortController();
    expect(
      await writeGoCallerDelivery(
        f.bridge,
        handle,
        sink.asResponse(),
        abort.signal,
        "3",
      ),
    ).toEqual({ issuanceId: "issue", firstSequence: "4", lastSequence: "9" });
    expect(sink.write).toHaveBeenCalledExactlyOnceWith(delivery().data, "utf8");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(sink.eventNames()).toEqual([]);
  });
  it.each(["abort", "destroyed", "ended"])(
    "does not issue on an already %s response",
    async (fault) => {
      const f = bridgeFixture(),
        sink = new Sink(),
        abort = new AbortController();
      if (fault === "abort") abort.abort();
      else if (fault === "destroyed") sink.destroyed = true;
      else sink.writableEnded = true;
      await expect(
        writeGoCallerDelivery(
          f.bridge,
          handle,
          sink.asResponse(),
          abort.signal,
          "3",
        ),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
      expect(sink.write).not.toHaveBeenCalled();
      expect(sink.eventNames()).toEqual([]);
    },
  );
  it.each(["abort", "close", "error"])(
    "discards an in-transit issuance after %s",
    async (fault) => {
      const pending = deferred<ChatCallerDelivery>(),
        issue = vi.fn(() => pending.promise),
        sink = new Sink(),
        abort = new AbortController();
      const write = writeGoCallerDelivery(
        { issue },
        handle,
        sink.asResponse(),
        abort.signal,
        "3",
      );
      if (fault === "abort") abort.abort();
      else sink.emit(fault, new Error("controlled"));
      pending.resolve(delivery());
      await expect(write).rejects.toMatchObject({ state: "unknown" });
      expect(issue).toHaveBeenCalledTimes(1);
      expect(sink.write).not.toHaveBeenCalled();
      expect(sink.eventNames()).toEqual([]);
    },
  );
  it("does not replay a buffered write after abort and late drain", async () => {
    const f = bridgeFixture(),
      sink = new Sink(),
      abort = new AbortController();
    sink.write.mockReturnValue(false);
    const write = writeGoCallerDelivery(
      f.bridge,
      handle,
      sink.asResponse(),
      abort.signal,
      "3",
    );
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledTimes(1));
    abort.abort();
    sink.emit("drain");
    await expect(write).rejects.toMatchObject({ state: "unknown" });
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(sink.eventNames()).toEqual([]);
  });
  it("withdrawal after drain but before continuation still yields unknown", async () => {
    const f = bridgeFixture(),
      sink = new Sink(),
      abort = new AbortController();
    sink.write.mockReturnValue(false);
    const write = writeGoCallerDelivery(
      f.bridge,
      handle,
      sink.asResponse(),
      abort.signal,
      "3",
    );
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledTimes(1));
    sink.emit("drain");
    abort.abort();
    await expect(write).rejects.toMatchObject({ state: "unknown" });
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(sink.eventNames()).toEqual([]);
  });
  it("drain completes only the existing buffered write", async () => {
    const f = bridgeFixture(),
      sink = new Sink(),
      abort = new AbortController();
    sink.write.mockImplementation(() => {
      queueMicrotask(() => sink.emit("drain"));
      return false;
    });
    await expect(
      writeGoCallerDelivery(
        f.bridge,
        handle,
        sink.asResponse(),
        abort.signal,
        "3",
      ),
    ).resolves.toMatchObject({ issuanceId: "issue" });
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("write throwing after a possible effect stays unknown", async () => {
    const f = bridgeFixture(),
      sink = new Sink();
    sink.write.mockImplementation(() => {
      throw new Error("possible effect");
    });
    await expect(
      writeGoCallerDelivery(
        f.bridge,
        handle,
        sink.asResponse(),
        new AbortController().signal,
        "3",
      ),
    ).rejects.toMatchObject({ state: "unknown" });
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("unknown issuance cannot be converted into a write or retried", async () => {
    const issue = vi.fn(async () => {
        throw new BridgeError("unknown", "lost-issue");
      }),
      sink = new Sink();
    await expect(
      writeGoCallerDelivery(
        { issue },
        handle,
        sink.asResponse(),
        new AbortController().signal,
        "3",
      ),
    ).rejects.toMatchObject({ code: "lost-issue" });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(sink.write).not.toHaveBeenCalled();
  });
});
