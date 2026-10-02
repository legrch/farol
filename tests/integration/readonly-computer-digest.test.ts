import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadonlyComputerCallResponseSchema } from "../../src/modules/computer/contract/readonly-computer-contract";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { approvedRootOf } from "../fixtures/root-identity";

const digest = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
let root = "";
const native = () =>
  new NativeReadonlyWorkspace({
    helperPath: path.resolve(
      import.meta.dirname,
      "../../resources/native/safe_open.py",
    ),
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
const descriptor = () => ({
  workspaceId: "digest-fixture",
  root,
  approvedRoot: approvedRootOf(root),
  deniedPaths: [],
});
const read = (range?: { offset: number; length: number }) =>
  native().execute({
    workspace: descriptor(),
    operation: {
      kind: "workspace.read",
      relativePath: "source.txt",
      ...(range ? { range } : {}),
    },
  });
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-read-digest-")),
  );
  await fs.chmod(root, 0o700);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("public full-read raw source digest", () => {
  it.each([
    ["ordinary", Buffer.from("source\n")],
    ["empty", Buffer.alloc(0)],
    ["BOM only", Buffer.from([0xef, 0xbb, 0xbf])],
    ["BOM and Unicode", Buffer.from("\uFEFFé✓😀\n")],
    ["CRLF", Buffer.from("first\r\nsecond\r\n")],
    ["256 KiB boundary", Buffer.alloc(256 * 1024, 0x61)],
  ])("hashes all original bytes for %s", async (_name, raw) => {
    await fs.writeFile(path.join(root, "source.txt"), raw, { mode: 0o600 });
    expect(await read()).toEqual({
      ok: true,
      value: {
        kind: "workspace.text",
        text: new TextDecoder("utf-8", { fatal: true }).decode(raw),
        bytes: raw.length,
        sha256: digest(raw),
      },
    });
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]), "WORKSPACE_NOT_TEXT"],
    ["NUL", Buffer.from("secret\0data"), "WORKSPACE_NOT_TEXT"],
    [
      "over ceiling",
      Buffer.alloc(256 * 1024 + 1, 0x61),
      "WORKSPACE_FILE_TOO_LARGE",
    ],
  ])("returns neither text nor digest for %s", async (_name, raw, code) => {
    await fs.writeFile(path.join(root, "source.txt"), raw, { mode: 0o600 });
    expect(await read()).toEqual({
      ok: false,
      error: { code, retry: "never" },
    });
  });

  it.each([0, 6, 10])(
    "never exposes a whole-file digest for a window at %s",
    async (offset) => {
      await fs.writeFile(path.join(root, "source.txt"), "small\n", {
        mode: 0o600,
      });
      const result = await read({ offset, length: 64 });
      expect(result).toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: offset === 0 ? "small\n" : "",
          bytes: offset === 0 ? 6 : 0,
          page: { offset, size: 6, nextOffset: null },
        },
      });
    },
  );

  it("uses the public BOM digest for a guarded edit and refuses changed bytes", async () => {
    const raw = Buffer.from("\uFEFFbefore\r\n");
    await fs.writeFile(path.join(root, "source.txt"), raw, { mode: 0o600 });
    const result = await read();
    expect(result).toMatchObject({ ok: true, value: { sha256: digest(raw) } });
    if (
      !result.ok ||
      result.value.kind !== "workspace.text" ||
      !("sha256" in result.value)
    )
      throw new Error("full source digest missing");
    const edit = {
      workspace: { ...descriptor(), writeDeniedPaths: [] },
      operation: {
        kind: "workspace.edit" as const,
        relativePath: "source.txt",
        expectedSha256: result.value.sha256,
        edits: [{ oldText: "before", newText: "after" }],
      },
    };
    expect(await native().mutate(edit)).toMatchObject({
      ok: true,
      value: { beforeSha256: result.value.sha256 },
    });
    const changed = Buffer.from("\uFEFFafter\r\n");
    expect(await fs.readFile(path.join(root, "source.txt"))).toEqual(changed);
    expect(await native().mutate(edit)).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
    });
    expect(await fs.readFile(path.join(root, "source.txt"))).toEqual(changed);
  });
});

const sha256 = digest(Buffer.from("source\n"));
const full = { kind: "workspace.text", text: "source\n", bytes: 7, sha256 };
const page = {
  kind: "workspace.text",
  text: "source\n",
  bytes: 7,
  page: { offset: 0, size: 7, nextOffset: null },
};
function response(output: unknown, range?: { offset: number; length: number }) {
  return {
    ok: true,
    value: {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "main",
      turnId: "turn",
      generation: 1,
      callId: "call",
      workspaceId: "fixture",
      relativePath: "source.txt",
      operation: {
        kind: "workspace.read",
        relativePath: "source.txt",
        ...(range ? { range } : {}),
      },
      output,
    },
  };
}
describe("closed full/window public read response", () => {
  const range = { offset: 10, length: 64 };
  const window = {
    kind: "workspace.text",
    text: "x",
    bytes: 1,
    page: { offset: 10, size: 100, nextOffset: 11 },
  };

  it.each([
    ["offset before the request", { offset: 0, size: 100, nextOffset: 1 }],
    ["skip beyond a UTF-8 prefix", { offset: 14, size: 100, nextOffset: 15 }],
    ["backward continuation", { offset: 10, size: 100, nextOffset: 10 }],
    ["jumping continuation", { offset: 10, size: 100, nextOffset: 12 }],
    ["false end of file", { offset: 10, size: 100, nextOffset: null }],
    ["continuation after EOF", { offset: 10, size: 11, nextOffset: 11 }],
    ["bytes beyond the file", { offset: 10, size: 10, nextOffset: null }],
  ])("refuses window metadata with %s", (_name, page) => {
    expect(
      ReadonlyComputerCallResponseSchema.safeParse(
        response({ ...window, page }, range),
      ).success,
    ).toBe(false);
  });

  it("refuses bytes beyond the requested window", () => {
    expect(
      ReadonlyComputerCallResponseSchema.safeParse(
        response(
          { ...window, bytes: 65, page: { ...window.page, nextOffset: 75 } },
          range,
        ),
      ).success,
    ).toBe(false);
  });

  it("preserves UTF-8 alignment progress and reads beyond EOF", () => {
    for (const [output, requested] of [
      [window, range],
      [{ ...window, page: { offset: 13, size: 100, nextOffset: 14 } }, range],
      [
        {
          ...window,
          text: "",
          bytes: 0,
          page: { offset: 13, size: 100, nextOffset: 13 },
        },
        { offset: 10, length: 4 },
      ],
      [
        {
          ...window,
          text: "",
          bytes: 0,
          page: { offset: 200, size: 100, nextOffset: null },
        },
        { offset: 200, length: 64 },
      ],
    ] as const) {
      expect(
        ReadonlyComputerCallResponseSchema.safeParse(
          response(output, requested),
        ).success,
      ).toBe(true);
    }
  });

  it("accepts exact full and window alternatives", () => {
    expect(
      ReadonlyComputerCallResponseSchema.safeParse(response(full)).success,
    ).toBe(true);
    expect(
      ReadonlyComputerCallResponseSchema.safeParse(
        response(page, { offset: 0, length: 64 }),
      ).success,
    ).toBe(true);
  });
  it.each([
    [
      "missing digest",
      { kind: "workspace.text", text: "source\n", bytes: 7 },
      undefined,
    ],
    ["short digest", { ...full, sha256: "abc" }, undefined],
    ["uppercase digest", { ...full, sha256: sha256.toUpperCase() }, undefined],
    ["nonhex digest", { ...full, sha256: "g".repeat(64) }, undefined],
    ["digest on page", { ...page, sha256 }, { offset: 0, length: 64 }],
    ["unknown field", { ...full, extra: true }, undefined],
    ["undefined page on full", { ...full, page: undefined }, undefined],
    [
      "undefined SHA on page",
      { ...page, sha256: undefined },
      { offset: 0, length: 64 },
    ],
    ["page for full read", page, undefined],
    ["full for ranged read", full, { offset: 0, length: 64 }],
  ])("refuses %s", (_name, output, range) => {
    expect(
      ReadonlyComputerCallResponseSchema.safeParse(response(output, range))
        .success,
    ).toBe(false);
  });
});
