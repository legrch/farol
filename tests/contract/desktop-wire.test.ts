import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  BridgeError,
  Client,
  spawnCore,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame, parseJSON } from "../../apps/desktop/bridge/frame.ts";
import {
  maxFrameBytes,
  validUnicode,
  knownMethod,
  requiresOperationID,
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
    let client: Client | undefined;
    let phase = "spawn-and-handshake";
    try {
      // This first request includes a cold native process start, matching the
      // desktop's bounded startup budget. Later RPCs keep their ordinary
      // two-second deadlines. A timeout still owns cleanup of this one child.
      client = await spawnCore(
        executable,
        "disposable-profile",
        "k0-test",
        15_000,
      );
      phase = "status";
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
      phase = "capability-checks";
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
    } catch (error) {
      // Content-free phase evidence; preserve the original error and budgets.
      console.info(
        JSON.stringify({
          evidence: "K0 process/status failure",
          phase,
          elapsedMs: performance.now() - started,
          failure:
            error instanceof BridgeError && error.code === "response_timeout"
              ? "response_timeout"
              : "other_failure",
          cleanup: client?.cleanupState ?? "spawnCore-owned",
        }),
      );
      throw error;
    } finally {
      await client?.close();
    }
    expect(await client!.closeAndObserve()).toEqual({
      exitCode: 0,
      signal: null,
      forced: false,
    });
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
  expect(await client.closeAndObserve()).toEqual({
    exitCode: null,
    signal: "SIGKILL",
    forced: true,
  });
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

it("keeps authoritative snapshots unsupported until their owner contract exists", () => {
  expect(
    validate("Event", {
      jsonrpc: "2.0",
      method: "core.event",
      params: {
        context: { profileId: "test", backendGeneration: "verified" },
        stream: "status",
        sequence: "1",
        kind: "snapshot",
        data: {},
      },
    }),
  ).toBe(false);
});

function terminalFixture(
  mode: "coalesced" | "coalesced-invalid" | "eof",
): string {
  return `
const context={profileId:'test',backendGeneration:'verified'};
function encode(value){const body=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(body.length);return Buffer.concat([h,body]);}
let input=Buffer.alloc(0);
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const n=input.readUInt32BE();if(input.length<4+n)return;const req=JSON.parse(input.subarray(4,4+n));input=input.subarray(4+n);
if(req.method==='core.handshake'){
 const hello=encode({jsonrpc:'2.0',id:req.id,result:{status:'ok',requestId:req.id,context,data:{protocolMajor:1,protocolMinor:0,buildId:'k0-test',profileId:'test',backendGeneration:'verified',capabilities:['core.status'],maxFrameBytes:1048576}}});
 const event=encode({jsonrpc:'2.0',method:'core.event',params:{context:${mode === "coalesced-invalid" ? "{...context,backendGeneration:'stale'}" : "context"},stream:'status',sequence:'1',kind:'changed',data:{}}});
 process.stdout.write(${mode.startsWith("coalesced") ? "Buffer.concat([hello,event])" : "hello"});
}else{${mode === "eof" ? "process.stdout.end();" : "process.stdout.write(encode({jsonrpc:'2.0',id:req.id,result:{status:'ok',requestId:req.id,context,data:{}}}));"}}
}});
${mode === "eof" ? "setInterval(()=>{},1000);" : "process.stdin.on('end',()=>process.exit(0));"}
`;
}
it("adopts a verified handshake before a coalesced valid event", async () => {
  const { client } = await fixture(terminalFixture("coalesced"));
  const seen: string[] = [];
  client.subscribe((event) => seen.push(event.sequence));
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
    expect(seen).toEqual(["1"]);
    await expect(
      client.request("core.status", {}, { id: "after-handshake-event" }),
    ).resolves.toMatchObject({
      status: "ok",
      requestId: "after-handshake-event",
    });
  } finally {
    await client.close();
  }
});
it("closes admission and settles dispatched work on clean stdout EOF", async () => {
  const { client, child } = await fixture(terminalFixture("eof"));
  let settled: unknown;
  let pending: Promise<void> | undefined;
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
    const ended = new Promise<void>((resolve) =>
      child.stdout!.once("end", resolve),
    );
    pending = client
      .request("core.status", {}, { id: "lost-at-eof", timeoutMs: 30000 })
      .then(
        () => {
          settled = { state: "ok" };
        },
        (error) => {
          settled = error;
        },
      );
    await ended;
    await Promise.resolve();
    expect(settled).toMatchObject({
      state: "unknown",
      code: "transport_ended",
    });
    await expect(
      client.request("core.status", {}, { id: "after-eof" }),
    ).rejects.toMatchObject({
      state: "unavailable",
      code: "backend_unavailable",
    });
  } finally {
    await client.close();
    await pending;
  }
  expect(client.cleanupState).toBe("confirmed");
});
it("rejects EOF after a complete nonzero frame header", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(3);
  const decoder = new Decoder();
  decoder.push(header, () => {});
  expect(() => decoder.finish()).toThrow();
});
it("uses the same bounded UTC timestamp grammar as Go", () => {
  for (const value of [
    "0001-01-01T00:00:00Z",
    "2024-02-29T12:00:00Z",
    "2026-10-02T12:00:00.1Z",
    "2026-10-02T12:00:00.123456789Z",
  ])
    expect(validate("utc", value), value).toBe(true);
  for (const value of [
    "0000-01-01T00:00:00Z",
    "2023-02-29T12:00:00Z",
    "2026-10-02T12:00:00.1234567890Z",
    "2026-10-02T12:00:00,1Z",
    "2026-10-02T12:00:00.Z",
    "2026-10-02T12:00:00+00:00",
    "2026-10-02T12:00:00Z\n",
  ])
    expect(validate("utc", value), value).toBe(false);
});

it("does not return a connected client after a coalesced invalid event", async () => {
  const { client } = await fixture(terminalFixture("coalesced-invalid"));
  try {
    await expect(
      client.handshake(
        {
          protocolMajor: 1,
          protocolMinor: 0,
          buildId: "k0-test",
          profileId: "test",
        },
        2000,
      ),
    ).rejects.toMatchObject({ state: "unknown", code: "backend_unavailable" });
    await expect(client.request("core.status", {})).rejects.toMatchObject({
      state: "unavailable",
      code: "backend_unavailable",
    });
  } finally {
    await client.close();
  }
  expect(client.cleanupState).toBe("confirmed");
});

it("generates one immutable method effect authority for both peers", () => {
  for (const method of ["task.create", "chat.turn"]) {
    expect(knownMethod(method)).toBe(true);
    expect(requiresOperationID(method)).toBe(true);
  }
  for (const method of [
    "core.handshake",
    "core.status",
    "core.operation.status",
    "computer.workspace.read",
    "release.status",
  ]) {
    expect(knownMethod(method)).toBe(true);
    expect(requiresOperationID(method)).toBe(false);
  }
  expect(knownMethod("unknown.eval")).toBe(false);
});

it("rejects missing or unknown method kinds before generating peers", () => {
  const root = join(directory, "invalid-method-schema");
  mkdirSync(join(root, "tooling"), { recursive: true });
  mkdirSync(join(root, "api/desktop/v1"), { recursive: true });
  writeFileSync(
    join(root, "tooling/generate-desktop-wire.mjs"),
    readFileSync(resolve("tooling/generate-desktop-wire.mjs")),
  );
  writeFileSync(
    join(root, "api/desktop/v1/schema.json"),
    JSON.stringify({
      generator: "farol-wire/1",
      methods: { "task.create": "effect" },
    }),
  );
  expect(() =>
    execFileSync(
      process.execPath,
      [join(root, "tooling/generate-desktop-wire.mjs")],
      { stdio: "pipe" },
    ),
  ).toThrow("unsupported generator");
  for (const spec of [
    undefined,
    "unknown",
    { owner: "task", kind: "effect" },
  ]) {
    writeFileSync(
      join(root, "api/desktop/v1/schema.json"),
      JSON.stringify({
        generator: "farol-wire/2",
        methods: { "task.create": spec },
      }),
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [join(root, "tooling/generate-desktop-wire.mjs")],
        { stdio: "pipe" },
      ),
    ).toThrow("invalid method classification");
  }
});

it("admits UTF-16 pairs as scalars and refuses isolated units", () => {
  for (const value of ["🌊", "A🌊éZ", String.fromCharCode(0xd83c, 0xdf0a)])
    expect(validUnicode(value)).toBe(true);
  for (const value of [
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
    String.fromCharCode(0xd800, 65),
    String.fromCharCode(0xd800, 0xd800),
  ])
    expect(validUnicode(value)).toBe(false);
});

it("detaches closed borrowed wrappers while the owner keeps its child alive", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdin.on('data',data=>process.stdout.write(data));",
  ]);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const received: Buffer[] = [];
  const ownerData = (data: Buffer): void => {
    received.push(data);
  };
  child.stdout.on("data", ownerData);
  const watch = [
    [child.stdout, "data"],
    [child.stdout, "end"],
    [child.stdout, "error"],
    [child.stdin, "error"],
    [child.stdin, "drain"],
    [child.stderr, "data"],
    [child, "error"],
    [child, "close"],
  ] as const;
  const baseline = watch.map(([source, event]) => source.listenerCount(event));
  try {
    for (let index = 0; index < 4; index++) {
      const client = new Client(child);
      const write = vi.spyOn(child.stdin, "write").mockReturnValue(false);
      const pending = expect(
        client.handshake(
          {
            protocolMajor: 1,
            protocolMinor: 0,
            buildId: "k0-test",
            profileId: "test",
          },
          2000,
        ),
      ).rejects.toMatchObject({ state: "unknown", code: "client_closed" });
      await client.close();
      await pending;
      write.mockRestore();
      expect(
        watch.map(([source, event]) => source.listenerCount(event)),
      ).toEqual(baseline);
      child.stderr.emit("data", Buffer.from("later diagnostic"));
      expect(client.diagnosticByteCount).toBe(0);
      expect(client.cleanupState).toBe("none");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.stdin.destroyed).toBe(false);
      expect(child.stdout.destroyed).toBe(false);
    }
    const echo = new Promise<void>((resolve) =>
      child.stdout.once("data", () => resolve()),
    );
    child.stdin.write("owner still connected");
    await echo;
    expect(Buffer.concat(received).toString()).toBe("owner still connected");
  } finally {
    vi.restoreAllMocks();
    const terminal = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.kill("SIGKILL");
    await terminal;
  }
});

it("refuses independently varied fixed wire limits before generating either peer", () => {
  const root = join(directory, "unsupported-limit-schema");
  mkdirSync(join(root, "tooling"), { recursive: true });
  mkdirSync(join(root, "api/desktop/v1"), { recursive: true });
  writeFileSync(
    join(root, "tooling/generate-desktop-wire.mjs"),
    readFileSync(resolve("tooling/generate-desktop-wire.mjs")),
  );
  const schema = JSON.parse(
    readFileSync(resolve("api/desktop/v1/schema.json"), "utf8"),
  ) as Record<string, unknown>;
  for (const [name, value] of [
    ["maxFrameBytes", 524288],
    ["maxFrameBytes", "1048576"],
    ["maxFrameBytes", undefined],
    ["maxDepth", 16],
    ["maxDepth", 64],
    ["maxDepth", undefined],
    ["maxRequests", 1024],
    ["maxRequests", undefined],
  ] as const) {
    writeFileSync(
      join(root, "api/desktop/v1/schema.json"),
      JSON.stringify({ ...schema, [name]: value }),
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [join(root, "tooling/generate-desktop-wire.mjs")],
        { stdio: "pipe" },
      ),
    ).toThrow("unsupported wire limits");
  }
});
