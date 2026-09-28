import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedCodexProxyHost } from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { HandoffNotSubmittedError } from "../../src/modules/chat/app/service/persistent-codex-handoff";

// Owned Node protocol fixture only: no daemon, model, socket, profile or grants.
const SCRIPT = String.raw`
const spec = JSON.parse(process.env.FRAME_SPEC);
let input = "";
let selected = null;
let refusals = 0;
let heldChunk = null;
process.on("message", value => {
  if (value === "flush" && heldChunk !== null) {
    process.stdout.write(heldChunk);
    heldChunk = null;
  }
});
process.stdin.setEncoding("utf8");
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) break;
    const value = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (value.method === "initialize") {
      reply({id:value.id,result:{codexHome:"/fixture/codex-home",platformFamily:"unix",platformOs:"macos",userAgent:"fixture"}});
    } else if (value.method === "thread/read") {
      selected = value.id;
      if (spec.kind === "request") {
        reply({id:spec.id,method:"item/commandExecution/requestApproval",params:{command:"NEVER_EXECUTE"}});
      } else if (spec.kind === "ambiguous") {
        reply({...spec.frame,id:spec.id === "pending" ? selected : spec.id});
      } else if (spec.kind === "reply-size") {
        reply({id:"x".repeat(8*1024*1024-30),method:""});
      } else if (spec.kind === "response-id") {
        reply({id:String(value.id),result:{mustNotBeAccepted:true}});
      } else if (spec.kind === "invalid-utf8") {
        const text = spec.envelope === "notification"
          ? {method:"thread/status/changed",params:{value:"BAD_BYTE"}}
          : spec.envelope === "request"
            ? {id:17,method:"item/commandExecution/requestApproval",params:{value:"BAD_BYTE"}}
            : {id:value.id,result:{value:"BAD_BYTE"}};
        const bytes=Buffer.from(JSON.stringify(text)+"\n");
        const marker=bytes.indexOf(Buffer.from("BAD_BYTE"));
        process.stdout.write(Buffer.concat([bytes.subarray(0,marker),Buffer.from([255]),bytes.subarray(marker+8)]));
        if (spec.envelope !== "response") reply({id:value.id,result:{mustNotBeAccepted:true}});
      } else if (spec.kind === "bom") {
        process.stdout.write(Buffer.from([0xef,0xbb,0xbf]));
        reply({id:value.id,result:{mustNotBeAccepted:true}});
      } else if (spec.kind === "split-utf8") {
        const bytes=Buffer.from(JSON.stringify({id:value.id,result:{value:"Р🌒"}})+"\n");
        const split=bytes.indexOf(Buffer.from("🌒"))+2;
        process.stdout.write(bytes.subarray(0,split));
        heldChunk = bytes.subarray(split);
      }
    } else if (Object.hasOwn(value,"error")) {
      refusals++;
      reply({id:selected,result:{refusalId:value.id,refusal:value.error,refusals,approved:Object.hasOwn(value,"result")}});
    }
  }
});
`;
const fixtures: Array<{
  host: SharedCodexProxyHost;
  child: () => ChildProcessWithoutNullStreams | undefined;
}> = [];
afterEach(async () => {
  // Each exact child exit is awaited even when a protocol assertion failed.
  const results = await Promise.allSettled(
    fixtures.splice(0).map(async ({ host, child }) => {
      expect(await host.closeAndWait()).toBe(true);
      const owned = child();
      if (owned)
        expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});
function fixture(spec: unknown) {
  let owned: ChildProcessWithoutNullStreams | undefined;
  const chunks: Buffer[] = [];
  const host = new SharedCodexProxyHost(
    () => {
      const launched = spawn(process.execPath, ["-e", SCRIPT], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { FRAME_SPEC: JSON.stringify(spec) },
      });
      if (!launched.stdin || !launched.stdout || !launched.stderr)
        throw Error("Owned fixture pipes missing");
      const child = launched as ChildProcessWithoutNullStreams;
      owned = child;
      child.stdout.on("data", (bytes: Buffer) => {
        chunks.push(Buffer.from(bytes));
        // Fixture-only IPC releases the second half after the first real chunk
        // is observed. No timing assumption or production control message.
        if (bytes.subarray(-2).equals(Buffer.from([0xf0, 0x9f])))
          child.send("flush");
      });
      return child;
    },
    "/fixture/codex-home",
    2_000,
  );
  fixtures.push({ host, child: () => owned });
  return { host, chunks, child: () => owned };
}
describe("shared proxy inbound framing, no approval capability", () => {
  it.each([999, 2, -17, "approval_一🌒", "999", ""])(
    "refuses one server request with its exact supported ID %j without disconnecting",
    async (id) => {
      const { host } = fixture({ kind: "request", id });
      expect(
        await host.request("thread/read", { threadId: "selected" }),
      ).toEqual({
        refusalId: id,
        refusal: { code: -32601, message: "Method not available" },
        refusals: 1,
        approved: false,
      });
    },
  );
  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, null, true, {}])(
    "fails closed rather than replying to unsafe server request ID %j",
    async (id) => {
      const { host } = fixture({ kind: "request", id });
      await expect(host.request("thread/read", {})).rejects.toThrow(
        "CODEX_SHARED_HOST_UNAVAILABLE",
      );
      await expect(host.request("thread/read", {})).rejects.toBeInstanceOf(
        HandoffNotSubmittedError,
      );
    },
  );
  it.each([
    { method: "approval", result: {} },
    { method: "approval", error: {} },
    { method: null, result: {} },
    { method: 5, result: {} },
  ])("rejects ambiguous request/response envelope %j", async (frame) => {
    const { host } = fixture({ kind: "ambiguous", id: "pending", frame });
    await expect(host.request("thread/read", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });
  it.each(["response", "notification", "request"])(
    "rejects invalid UTF-8 in %s before admitting any result",
    async (envelope) => {
      const { host } = fixture({ kind: "invalid-utf8", envelope });
      await expect(host.request("thread/read", {})).rejects.toThrow(
        "CODEX_SHARED_HOST_UNAVAILABLE",
      );
    },
  );
  it("keeps valid UTF-8 split inside a code point intact", async () => {
    const { host, chunks } = fixture({ kind: "split-utf8" });
    expect(await host.request("thread/read", {})).toEqual({ value: "Р🌒" });
    // Confirm real fixture chunks split the emoji, not merely a script intent.
    const prefix = Buffer.from([0xf0, 0x9f]);
    expect(chunks.some((chunk) => chunk.subarray(-2).equals(prefix))).toBe(
      true,
    );
    expect(
      chunks.some((chunk) =>
        chunk.subarray(0, 2).equals(Buffer.from([0x8c, 0x92])),
      ),
    ).toBe(true);
  });
  it("does not write a refusal that exceeds the bounded frame budget", async () => {
    const { host, child } = fixture({ kind: "reply-size" });
    await host.connect();
    const owned = child();
    if (!owned) throw Error("Owned fixture missing");
    const writes = vi.spyOn(owned.stdin, "write");
    try {
      await expect(host.request("thread/read", {})).rejects.toThrow(
        "CODEX_SHARED_HOST_UNAVAILABLE",
      );
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
    }
  });
  it("does not strip a forbidden leading BOM into an accepted JSON result", async () => {
    const { host } = fixture({ kind: "bom" });
    await expect(host.request("thread/read", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });
  it("does not coerce a string response ID to its numeric pending request", async () => {
    const { host } = fixture({ kind: "response-id" });
    await expect(host.request("thread/read", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });
});
