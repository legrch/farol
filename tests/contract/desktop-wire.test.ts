import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, spawnCore } from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame, parseJSON } from "../../apps/desktop/bridge/frame.ts";
import {
  maxFrameBytes,
  schemaSHA256,
  validate,
  type Status,
} from "../../apps/desktop/bridge/wire.ts";

let directory: string;
let executable: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "farol-core-"));
  executable = join(directory, "farol");
  execFileSync(
    "go",
    [
      "build",
      "-ldflags",
      "-X github.com/legrch/farol/boot.BuildID=k0-test",
      "-o",
      executable,
      "./cmd/farol",
    ],
    { cwd: process.cwd() },
  );
}, 30000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("K0 real inherited-pipe process", () => {
  it("returns a measured exact process identity and explicit missing capabilities", async () => {
    const started = performance.now();
    const client = await spawnCore(executable, "disposable-profile", "k0-test");
    try {
      const result = await client.request(
        "core.status",
        {},
        { id: "status-1" },
      );
      expect(result.status).toBe("ok");
      expect(result.requestId).toBe("status-1");
      expect(validate("Status", result.data)).toBe(true);
      const status = result.data as unknown as Status;
      expect(BigInt(status.pid)).toBeGreaterThan(0n);
      expect(BigInt(status.uptimeNanoseconds)).toBeGreaterThan(0n);
      expect(status.buildId).toBe("k0-test");
      expect(status.backendGeneration).toBe(result.context.backendGeneration);
      console.info(
        JSON.stringify({
          evidence: "K0 process/status",
          pid: status.pid,
          buildId: status.buildId,
          profileId: status.profileId,
          backendGeneration: status.backendGeneration,
          roundTripMs: performance.now() - started,
          schemaSHA256,
        }),
      );
      expect((await client.request("computer.workspace.read", {})).status).toBe(
        "unavailable",
      );
      expect((await client.request("core.operation.status", {})).status).toBe(
        "unsupported",
      );
      await expect(
        client.request("core.status", {}, { id: "status-1" }),
      ).rejects.toMatchObject({
        state: "refused",
        code: "duplicate_request_id",
      });
      expect(client.diagnosticByteCount).toBe(0);
    } finally {
      await client.close();
    }
  });
  it("refuses wrong build/profile/version and missing backend", async () => {
    await expect(
      spawnCore(executable, "test", "wrong-build"),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      spawnCore(join(directory, "missing"), "test", "k0-test"),
    ).rejects.toMatchObject({ state: "unavailable" });
    const child = spawn(executable, ["serve", "--profile", "test"]);
    const client = new Client(child, true);
    try {
      await expect(
        client.handshake(
          {
            protocolMajor: 2,
            protocolMinor: 0,
            buildId: "k0-test",
            profileId: "test",
          },
          1000,
        ),
      ).rejects.toMatchObject({ state: "refused" });
    } finally {
      await client.close();
    }
  });
  it("carries a stale context refusal from the real backend", async () => {
    const child = spawn(executable, ["serve", "--profile", "test"]);
    const decoder = new Decoder();
    const responses: unknown[] = [];
    child.stdout.on("data", (chunk: Buffer) =>
      decoder.push(chunk, (v) => responses.push(v)),
    );
    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: "h",
        method: "core.handshake",
        params: {
          body: {
            protocolMajor: 1,
            protocolMinor: 0,
            buildId: "k0-test",
            profileId: "test",
          },
        },
      }),
    );
    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: "s",
        method: "core.status",
        params: {
          context: { profileId: "test", backendGeneration: "old" },
          body: {},
        },
      }),
    );
    child.stdin.end();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(responses[1]).toMatchObject({ id: "s", error: { code: -32002 } });
  });
});

it("keeps framed UTF-8 and uint64 strings lossless, and rejects hostile bounds", () => {
  const original = { text: "Лампа 🪔", bytes: "18446744073709551615" };
  const encoded = frame(original);
  const decoder = new Decoder();
  const actual: unknown[] = [];
  for (const byte of encoded)
    decoder.push(Buffer.from([byte]), (v) => actual.push(v));
  decoder.finish();
  expect(actual).toEqual([original]);
  for (const length of [0, maxFrameBytes + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    expect(() => new Decoder().push(header, () => {})).toThrow();
  }
  const truncated = new Decoder();
  truncated.push(encoded.subarray(0, -1), () => {});
  expect(() => truncated.finish()).toThrow();
  expect(() => parseJSON('{"id":"a","id":"b"}')).toThrow("duplicate");
  expect(() => parseJSON('{"a":{"x":1,"x":2}}')).toThrow("duplicate");
  expect(validate("json", 9007199254740992)).toBe(false);
  expect(validate("decimal", "18446744073709551616")).toBe(false);
  expect(
    validate("Response", {
      jsonrpc: "2.0",
      id: "r",
      error: { code: 1, message: "x" },
      result: {},
    }),
  ).toBe(false);
});

async function fixture(
  script: string,
): Promise<{ client: Client; child: ReturnType<typeof spawn> }> {
  const target = join(directory, `fixture-${Math.random()}.mjs`);
  writeFileSync(target, script);
  const child = spawn(process.execPath, [target]);
  const client = new Client(child, true);
  return { client, child };
}
it("never accepts a crossed response ID or retries a lost response", async () => {
  for (const mode of ["crossed", "lost"]) {
    const { client } = await fixture(
      `process.stdin.on('data',()=>{${mode === "crossed" ? `const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'other',error:{code:-32600,message:'wrong'}}));const h=Buffer.alloc(4);h.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([h,body]));` : ""}});`,
    );
    try {
      await expect(
        client.handshake(
          {
            protocolMajor: 1,
            protocolMinor: 0,
            buildId: "k0-test",
            profileId: "test",
          },
          mode === "crossed" ? 2000 : 100,
        ),
      ).rejects.toMatchObject({
        state: "unknown",
        code: mode === "crossed" ? "crossed_response_id" : "response_timeout",
      });
    } finally {
      await client.close();
    }
  }
});
it("pins reproducible generation", () => {
  execFileSync(process.execPath, [
    resolve("tooling/generate-desktop-wire.mjs"),
    "--check",
  ]);
});

it("binds event gaps to the verified incarnation and bounds stream memory", async () => {
  for (const mode of ["gap", "stale", "streams"]) {
    const script = `
const context={profileId:'test',backendGeneration:'verified'};
function send(value){const body=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([h,body]));}
let input=Buffer.alloc(0);
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const n=input.readUInt32BE();if(input.length<4+n)return;const req=JSON.parse(input.subarray(4,4+n));input=input.subarray(4+n);if(req.method==='core.handshake'){send({jsonrpc:'2.0',id:req.id,result:{status:'ok',requestId:req.id,context,data:{protocolMajor:1,protocolMinor:0,buildId:'k0-test',profileId:'test',backendGeneration:'verified',capabilities:['core.status'],maxFrameBytes:1048576}}});}else{
for(let i=0;i<${mode === "streams" ? "65" : mode === "gap" ? "3" : "1"};i++){send({jsonrpc:'2.0',method:'core.event',params:{context:${mode === "stale" ? "{...context,backendGeneration:'old'}" : "context"},stream:${mode === "streams" ? "'stream-'+i" : "'status'"},sequence:${mode === "gap" ? "String(i===0?1:i+2)" : "'1'"},kind:'changed',data:{}}});}
send({jsonrpc:'2.0',id:req.id,result:{status:'ok',requestId:req.id,context,data:{}}});
}}});`;
    const { client } = await fixture(script);
    try {
      await client.handshake(
        {
          protocolMajor: 1,
          protocolMinor: 0,
          buildId: "k0-test",
          profileId: "test",
        },
        1000,
      );
      const seen: boolean[] = [];
      const dispose = client.subscribe((_event, stale) => seen.push(stale));
      if (mode === "gap") {
        await client.request("core.status", {});
        expect(seen).toEqual([false, true, true]);
      } else {
        await expect(client.request("core.status", {})).rejects.toMatchObject({
          state: "unknown",
          code:
            mode === "stale" ? "stale_event_context" : "event_stream_budget",
        });
      }
      dispose();
    } finally {
      await client.close();
    }
  }
});

it("cleans up its exact owned child after fatal timeout without an explicit close", async () => {
  const { client, child } = await fixture(
    "process.stdin.resume();setInterval(()=>{},1000);",
  );
  const terminal = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  await expect(
    client.handshake(
      {
        protocolMajor: 1,
        protocolMinor: 0,
        buildId: "k0-test",
        profileId: "test",
      },
      200,
    ),
  ).rejects.toMatchObject({ state: "unknown", code: "response_timeout" });
  await terminal;
  expect(client.cleanupState).toBe("confirmed");
  expect(child.signalCode).toBe("SIGKILL");
  await expect(client.request("core.status", {})).rejects.toMatchObject({
    state: "unavailable",
  });
});

it("isolates a throwing observer from a response in the same frame buffer", async () => {
  const { client, child } = await fixture(`
const context={profileId:'test',backendGeneration:'verified'};
function encode(value){const body=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(body.length);return Buffer.concat([h,body]);}
let input=Buffer.alloc(0),sequence=0;
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const n=input.readUInt32BE();if(input.length<4+n)return;const req=JSON.parse(input.subarray(4,4+n));input=input.subarray(4+n);const response={jsonrpc:'2.0',id:req.id,result:{status:'ok',requestId:req.id,context,data:req.method==='core.handshake'?{protocolMajor:1,protocolMinor:0,buildId:'k0-test',profileId:'test',backendGeneration:'verified',capabilities:['core.status'],maxFrameBytes:1048576}:{}}};
const frames=req.method==='core.handshake'?[encode(response)]:[encode({jsonrpc:'2.0',method:'core.event',params:{context,stream:'status',sequence:String(++sequence),kind:'changed',data:{}}}),encode(response)];process.stdout.write(Buffer.concat(frames));
}});`);
  try {
    await client.handshake(
      {
        protocolMajor: 1,
        protocolMinor: 0,
        buildId: "k0-test",
        profileId: "test",
      },
      2000,
    );
    let failedCalls = 0;
    const sequences: string[] = [];
    client.subscribe(() => {
      failedCalls++;
      throw new Error("local observer failure");
    });
    client.subscribe((event) => sequences.push(event.sequence));
    for (const id of ["observer-response-1", "observer-response-2"]) {
      await expect(
        client.request("core.status", {}, { id }),
      ).resolves.toMatchObject({ status: "ok", requestId: id });
    }
    expect(failedCalls).toBe(1);
    expect(sequences).toEqual(["1", "2"]);
    expect(client.cleanupState).toBe("none");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    await client.close();
  }
});

it("validates decoded binary64 integer values consistently across number spellings", () => {
  for (const number of [
    "1",
    "1.0",
    "1e0",
    "10e-1",
    "1.00000000000000001",
    "0.99999999999999999",
  ]) {
    expect(
      validate(
        "Handshake",
        parseJSON(
          `{"protocolMajor":${number},"protocolMinor":0.0,"buildId":"build","profileId":"test"}`,
        ),
      ),
    ).toBe(true);
  }
  for (const number of ["1.5", "-1", "4294967296", "1e1000"]) {
    expect(
      validate(
        "Handshake",
        parseJSON(
          `{"protocolMajor":${number},"protocolMinor":0,"buildId":"build","profileId":"test"}`,
        ),
      ),
    ).toBe(false);
  }
  for (const number of ["-32600", "-32600.0", "-3.26e4"]) {
    expect(
      validate(
        "Fault",
        parseJSON(`{"code":${number},"message":"invalid request"}`),
      ),
    ).toBe(true);
  }
});

it("rejects lone surrogates before path decoding while preserving valid pairs and literal escapes", () => {
  for (const raw of [
    String.raw`{"path":"\ud800.md"}`,
    String.raw`{"path":"\udc00.md"}`,
    String.raw`{"path":"\ud800x\udc00"}`,
    String.raw`{"\ud800":"value"}`,
  ])
    expect(() => parseJSON(raw)).toThrow("invalid Unicode");
  for (const raw of [
    String.raw`{"path":"\ud83c\udf0a.md"}`,
    String.raw`{"path":"\ufffd.md"}`,
    String.raw`{"path":"\\ud800.md"}`,
  ])
    expect(() => parseJSON(raw)).not.toThrow();
  expect(validate("json", { path: "\ud800.md" })).toBe(false);
  expect(validate("json", { "\ud800": "value" })).toBe(false);
  expect(validate("json", { path: "🌊.md" })).toBe(true);
});
