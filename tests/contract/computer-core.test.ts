import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, spawnCore } from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";
import {
  maxFrameBytes,
  validate,
  type ComputerReadRequest,
  type ComputerReadResponse,
  type ComputerReadRefusal,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";

// Actual Darwin native bytes + inherited pipe proof. The trusted executable is
// test-only; approval/revocation/loss flags never appear on production wire.
let directory: string;
let executable: string;
let production: string;
const text = "A🌊éZ\n";
const request: ComputerReadRequest = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  generation: "18446744073709551615",
  callId: "call",
  workspaceId: "workspace",
  relativePath: "note.md",
};
const hello = {
  protocolMajor: 1,
  protocolMinor: 0,
  buildId: "k1-test",
  profileId: "k1-disposable",
};
function body(value: object): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
function correlation(value: ComputerReadResponse): ComputerReadRequest {
  const {
    text: _text,
    bytes: _bytes,
    sha256: _sha256,
    page: _page,
    ...identity
  } = value;
  return identity;
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "farol-k1-"));
  executable = join(directory, "read-fixture");
  production = join(directory, "farol");
  if (process.platform !== "darwin") return;
  execFileSync("go", [
    "build",
    "-race",
    "-o",
    executable,
    "./tests/native/core",
  ]);
  execFileSync("go", ["build", "-o", production, "./cmd/farol"]);
}, 30000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(flags: readonly string[] = [], contents = text) {
  const root = mkdtempSync(join(directory, "workspace-"));
  writeFileSync(join(root, "note.md"), contents, { mode: 0o600 });
  const child = spawn(executable, ["--root", root, ...flags]);
  let nativeReads = 0;
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8");
    nativeReads = diagnostics.split("native-read\n").length - 1;
  });
  const client = new Client(child, true);
  try {
    await client.handshake(hello, 2000);
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, child, reads: () => nativeReads };
}

const darwin = describe.runIf(process.platform === "darwin");
darwin("K1 real TS Client -> Go transport -> Computer native read", () => {
  it("returns exact full and ranged UTF-8 with lossless correlation", async () => {
    const { client } = await fixture();
    try {
      const full = await client.request(
        "computer.workspace.read",
        body(request),
        { id: "full" },
      );
      expect(full).toMatchObject({ status: "ok", requestId: "full" });
      expect(validate("ComputerReadResponse", full.data)).toBe(true);
      const actual = full.data as unknown as ComputerReadResponse;
      expect(correlation(actual)).toEqual(request);
      expect(actual).toEqual({
        ...request,
        text,
        bytes: "9",
        sha256: createHash("sha256").update(text).digest("hex"),
      });
      const ranged = await client.request(
        "computer.workspace.read",
        body({ ...request, range: { offset: "2", length: 6 } }),
        { id: "range" },
      );
      expect(ranged.status).toBe("ok");
      expect(validate("ComputerReadResponse", ranged.data)).toBe(true);
      expect(ranged.data).toEqual({
        ...request,
        text: "éZ",
        bytes: "3",
        sha256: "",
        page: { offset: "5", size: "9", nextOffset: "8" },
      });
      const final = await client.request(
        "computer.workspace.read",
        body({ ...request, range: { offset: "8", length: 4 } }),
      );
      expect(final.data).toEqual({
        ...request,
        text: "\n",
        bytes: "1",
        sha256: "",
        page: { offset: "8", size: "9" },
      });
    } finally {
      await client.close();
    }
  });

  it("preserves exact refusal Source/Retry for root escape and unsafe native offset", async () => {
    const { client } = await fixture();
    try {
      for (const [input, code, source] of [
        [
          { ...request, relativePath: "../outside.md" },
          "COMPUTER_PATH_INVALID",
          "task-grant",
        ],
        [
          { ...request, range: { offset: "18446744073709551615", length: 4 } },
          "WORKSPACE_INVALID_REQUEST",
          "native-workspace",
        ],
      ] as const) {
        const out = await client.request(
          "computer.workspace.read",
          body(input),
        );
        expect(out).toMatchObject({ status: "refused", code });
        expect(validate("ComputerReadRefusal", out.data)).toBe(true);
        expect(out.data as unknown as ComputerReadRefusal).toEqual({
          request: input,
          code,
          source,
          retry: "never",
        });
      }
    } finally {
      await client.close();
    }
  });

  it("refuses disclosure after trusted revocation between native IO and publication", async () => {
    const { client, reads } = await fixture(["--revoke-after-read"]);
    try {
      const out = await client.request(
        "computer.workspace.read",
        body(request),
      );
      expect(out.status).toBe("refused");
      expect(validate("ComputerReadRefusal", out.data)).toBe(true);
      expect(out.data).toEqual({
        request,
        code: "COMPUTER_PARTICIPANT_NOT_FOUND",
        source: "authority-store",
        retry: "never",
      });
      expect(JSON.stringify(out)).not.toContain(text);
    } finally {
      await client.close();
    }
    expect(reads()).toBe(1);
  });

  it("returns typed output_bound before escaped native content exceeds 1 MiB", async () => {
    const { client, reads } = await fixture([], "<".repeat(262144));
    try {
      const out = await client.request(
        "computer.workspace.read",
        body(request),
      );
      expect(out).toMatchObject({ status: "refused", code: "output_bound" });
      expect(validate("ComputerReadRefusal", out.data)).toBe(true);
      expect(out.data).toEqual({
        request,
        code: "output_bound",
        source: "transport",
        retry: "never",
      });
      // The frame was refused before writing, so the existing pipe remains usable.
      expect((await client.request("core.status", {})).status).toBe("ok");
    } finally {
      await client.close();
    }
    expect(reads()).toBe(1);
  });

  it("rejects authority fields and malformed ranges before native IO", async () => {
    const { client, reads } = await fixture();
    try {
      await expect(
        client.request(
          "computer.workspace.read",
          body({ ...request, taskEpoch: 9007199254740992 }),
        ),
      ).rejects.toMatchObject({ state: "refused", code: "invalid_request" });
      for (const input of [
        { ...request, root: "/private" },
        { ...request, grant: {} },
        { ...request, home: "/private" },
        { ...request, revoke: true },
        { ...request, range: { offset: "0", length: 3 } },
        { ...request, range: { offset: "0", length: 262145 } },
      ]) {
        const out = await client.request(
          "computer.workspace.read",
          body(input),
        );
        expect(out).toMatchObject({
          status: "refused",
          code: "invalid_read_request",
        });
        expect(out.data).toEqual({
          code: "invalid_read_request",
          source: "transport",
          retry: "never",
        });
      }
    } finally {
      await client.close();
    }
    expect(reads()).toBe(0);
  });

  it("treats an actual native read with lost response as unknown without retry", async () => {
    const { client, reads } = await fixture(["--drop-read-response"]);
    try {
      await expect(
        client.request("computer.workspace.read", body(request), {
          timeoutMs: 200,
        }),
      ).rejects.toMatchObject({ state: "unknown", code: "response_timeout" });
      await expect(
        client.request("computer.workspace.read", body(request)),
      ).rejects.toMatchObject({
        state: "unavailable",
        code: "backend_unavailable",
      });
    } finally {
      await client.close();
    }
    expect(reads()).toBe(1);
    expect(client.cleanupState).toBe("confirmed");
  });

  it("refuses missing backend and keeps production Computer unavailable", async () => {
    await expect(
      spawnCore(join(directory, "missing"), "test", "development"),
    ).rejects.toMatchObject({ state: "unavailable" });
    const client = await spawnCore(production, "test", "development");
    try {
      expect(
        await client.request("computer.workspace.read", body(request)),
      ).toMatchObject({
        status: "unavailable",
        code: "capability_unavailable",
      });
    } finally {
      await client.close();
    }
  });

  it("refuses stale backend generation before native read", async () => {
    const root = mkdtempSync(join(directory, "stale-"));
    const child = spawn(executable, ["--root", root]);
    const decoder = new Decoder();
    const responses: unknown[] = [];
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) =>
      decoder.push(chunk, (value) => responses.push(value)),
    );
    child.stdin.end(
      Buffer.concat([
        frame({
          jsonrpc: "2.0",
          id: "h",
          method: "core.handshake",
          params: { body: hello },
        }),
        frame({
          jsonrpc: "2.0",
          id: "r",
          method: "computer.workspace.read",
          params: {
            context: { profileId: "k1-disposable", backendGeneration: "old" },
            body: request,
          },
        }),
      ]),
    );
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    decoder.finish();
    expect(responses[1]).toMatchObject({ id: "r", error: { code: -32002 } });
    expect(diagnostics).not.toContain("native-read");
  });

  it("terminates malformed/oversized/truncated native pipe input before owner IO", async () => {
    for (const mode of ["oversized", "truncated", "duplicate"] as const) {
      const root = mkdtempSync(join(directory, "malformed-"));
      const child = spawn(executable, ["--root", root]);
      const decoder = new Decoder();
      const responses: unknown[] = [];
      let diagnostics = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString("utf8");
      });
      child.stdout.on("data", (chunk: Buffer) =>
        decoder.push(chunk, (value) => responses.push(value)),
      );
      const header = Buffer.alloc(4);
      let input: Buffer;
      if (mode === "oversized") {
        header.writeUInt32BE(maxFrameBytes + 1);
        input = header;
      } else if (mode === "truncated") {
        header.writeUInt32BE(10);
        input = Buffer.concat([header, Buffer.from("{}")]);
      } else {
        const raw = Buffer.from('{"id":"a","id":"b"}');
        header.writeUInt32BE(raw.length);
        input = Buffer.concat([header, raw]);
      }
      child.stdin.end(input);
      const code = await new Promise<number | null>((resolve) =>
        child.once("close", (code) => resolve(code)),
      );
      decoder.finish();
      expect(code).toBe(mode === "duplicate" ? 0 : 1);
      if (mode === "duplicate")
        expect(responses[0]).toMatchObject({
          id: null,
          error: { code: -32700 },
        });
      else expect(responses).toEqual([]);
      expect(diagnostics).not.toContain("native-read");
    }
  });
});

it("uses the one generated closed read schema for hostile numeric and shape vectors", () => {
  expect(validate("ComputerReadRequest", request)).toBe(true);
  for (const epoch of ["0", "9007199254740993", "18446744073709551615"])
    expect(
      validate("ComputerReadRequest", { ...request, taskEpoch: epoch }),
    ).toBe(true);
  for (const epoch of [9007199254740992, "01", "-1", "18446744073709551616"])
    expect(
      validate("ComputerReadRequest", { ...request, taskEpoch: epoch }),
    ).toBe(false);
  for (const length of [4, 262144])
    expect(
      validate("ComputerReadRequest", {
        ...request,
        range: { offset: "0", length },
      }),
    ).toBe(true);
  for (const length of [3, 262145, "4", 4.5])
    expect(
      validate("ComputerReadRequest", {
        ...request,
        range: { offset: "0", length },
      }),
    ).toBe(false);
  expect(validate("ComputerReadRequest", { ...request, range: null })).toBe(
    false,
  );
  expect(
    validate("ComputerReadRequest", {
      ...request,
      relativePath: "é".repeat(2049),
    }),
  ).toBe(false);
  expect(
    validate("ComputerReadResponse", {
      ...request,
      text: "",
      bytes: "0",
      sha256: "",
      page: {
        offset: "18446744073709551615",
        size: "18446744073709551615",
        nextOffset: "18446744073709551615",
      },
    }),
  ).toBe(true);
  expect(
    validate("ComputerReadRefusal", {
      request,
      code: "output_bound",
      source: "transport",
      retry: "automatic",
    }),
  ).toBe(false);
});

darwin("K1 Unicode and native refusal route regressions", () => {
  it("refuses a lone surrogate before it can name an existing U+FFFD file", async () => {
    const root = mkdtempSync(join(directory, "unicode-"));
    writeFileSync(join(root, "\ufffd.md"), "replacement-filename");
    const child = spawn(executable, ["--root", root]);
    const decoder = new Decoder(),
      responses: unknown[] = [];
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) =>
      decoder.push(chunk, (value) => responses.push(value)),
    );
    child.stdin.end(
      Buffer.concat([
        frame({
          jsonrpc: "2.0",
          id: "h",
          method: "core.handshake",
          params: { body: hello },
        }),
        frame({
          jsonrpc: "2.0",
          id: "r",
          method: "computer.workspace.read",
          params: {
            context: {
              profileId: "k1-disposable",
              backendGeneration: "k1-incarnation",
            },
            body: { ...request, relativePath: "\ud800.md" },
          },
        }),
      ]),
    );
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    decoder.finish();
    expect(responses[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(diagnostics).not.toContain("native-read");
    expect(JSON.stringify(responses)).not.toContain("replacement-filename");
  });
  it("preserves classified native race refusal through Computer and the bridge", async () => {
    const { client, reads } = await fixture(["--race-refusal"]);
    const input = { ...request, range: { offset: "1", length: 4 } };
    try {
      const out = await client.request("computer.workspace.read", body(input), {
        id: "race",
      });
      expect(out).toMatchObject({
        status: "refused",
        requestId: "race",
        code: "WORKSPACE_RACE_DETECTED",
      });
      expect(out.data).toEqual({
        request: input,
        code: "WORKSPACE_RACE_DETECTED",
        source: "native-workspace",
        retry: "never",
      });
      expect(validate("ComputerReadRefusal", out.data)).toBe(true);
      expect(JSON.stringify(out)).not.toContain(text);
      expect((await client.request("core.status", {})).status).toBe("ok");
    } finally {
      await client.close();
    }
    expect(reads()).toBe(0);
  });
});
it("rejects surrogate paths in the generated read schema", () => {
  expect(
    validate("ComputerReadRequest", { ...request, relativePath: "\ud800.md" }),
  ).toBe(false);
  expect(
    validate("ComputerReadRequest", { ...request, relativePath: "🌊.md" }),
  ).toBe(true);
});
