import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceRefusal } from "./errors";
import {
  parseEntries,
  parseMatches,
  parseMutationReceipt,
  parseText,
  parseTextWindow,
} from "./replies";

const json = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value), "ascii");

const refuses = (run: () => unknown): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRefusal);
    expect((error as WorkspaceRefusal).code).toBe("WORKSPACE_HELPER_FAILED");
    return;
  }
  throw new Error("expected a refusal");
};

describe("parseEntries", () => {
  const reply = (extra: Record<string, unknown> = {}) =>
    json({
      entries: ["a.txt", "dir/"],
      truncated: false,
      writableByOthers: false,
      ...extra,
    });
  it("returns entries and marks a root writable by others only when true", () => {
    expect(parseEntries(reply())).toEqual({
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: ["a.txt", "dir/"],
        truncated: false,
      },
    });
    expect(parseEntries(reply({ writableByOthers: true }))).toMatchObject({
      value: { writableByOthers: true },
    });
  });
  it("refuses malformed replies", () => {
    refuses(() => parseEntries(Buffer.from("nope")));
    refuses(() => parseEntries(json({ entries: [] })));
    refuses(() => parseEntries(reply({ entries: ["a/b"] })));
    refuses(() => parseEntries(reply({ entries: [".."] })));
    refuses(() => parseEntries(reply({ entries: ["a\\b"] })));
    refuses(() => parseEntries(reply({ truncated: "no" })));
    refuses(() =>
      parseEntries(
        reply({ entries: Array.from({ length: 501 }, (_, i) => `f${i}`) }),
      ),
    );
  });
});

describe("parseMatches", () => {
  const match = {
    line: 3,
    path: "src/a.ts",
    text: "\tconst x = 1;",
    truncated: false,
  };
  const reply = (matches: unknown[]) =>
    json({ matches, resultLimited: false, scanLimited: true });
  it("returns validated matches", () => {
    expect(parseMatches(reply([match]))).toEqual({
      ok: true,
      value: {
        kind: "workspace.matches",
        matches: [match],
        resultLimited: false,
        scanLimited: true,
      },
    });
  });
  it("refuses bad lines, paths, text and counts", () => {
    refuses(() => parseMatches(reply([{ ...match, line: 0 }])));
    refuses(() => parseMatches(reply([{ ...match, path: "../a" }])));
    refuses(() => parseMatches(reply([{ ...match, text: "a\nb" }])));
    refuses(() => parseMatches(reply([{ ...match, text: "a\u0001" }])));
    refuses(() => parseMatches(reply([{ ...match, text: "x".repeat(501) }])));
    refuses(() => parseMatches(reply([{ ...match, extra: 1 }])));
    refuses(() => parseMatches(reply(Array(101).fill(match))));
    refuses(() => parseMatches(json({ matches: [] })));
  });
});

describe("parseText", () => {
  it("returns text with the digest of the original bytes", () => {
    const raw = Buffer.from("﻿hello", "utf8");
    expect(parseText(raw)).toEqual({
      ok: true,
      value: {
        kind: "workspace.text",
        text: "hello",
        bytes: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
    });
  });
  it("refuses NUL bytes and invalid UTF-8 as not text", () => {
    const notText = { ok: false, error: { code: "WORKSPACE_NOT_TEXT" } };
    expect(parseText(Buffer.from([0x61, 0, 0x62]))).toMatchObject(notText);
    expect(parseText(Buffer.from([0xff, 0xfe]))).toMatchObject(notText);
  });
});

describe("parseTextWindow", () => {
  const window = (header: Record<string, unknown>, payload: Buffer): Buffer =>
    Buffer.concat([json(header), Buffer.from("\n"), payload]);
  const range = (offset: number, length: number) => ({ offset, length });

  it("returns a whole window and no next offset at the end of file", () => {
    const payload = Buffer.from("hello");
    expect(
      parseTextWindow(
        window({ offset: 0, returned: 5, size: 5 }, payload),
        range(0, 16),
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "workspace.text",
        text: "hello",
        bytes: 5,
        page: { offset: 0, size: 5, nextOffset: null },
      },
    });
  });
  it("ends a mid-file window on a whole character", () => {
    const payload = Buffer.from("aé", "utf8").subarray(0, 2); // 'a' + lead byte
    const result = parseTextWindow(
      window({ offset: 0, returned: 2, size: 10 }, payload),
      range(0, 2),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { text: "a", bytes: 1, page: { offset: 0, nextOffset: 1 } },
    });
  });
  it("skips leading continuation bytes after the first window", () => {
    const payload = Buffer.from("éb", "utf8").subarray(1); // continuation + 'b'
    const result = parseTextWindow(
      window({ offset: 5, returned: 2, size: 7 }, payload),
      range(5, 8),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { text: "b", page: { offset: 6, size: 7, nextOffset: null } },
    });
  });
  it("keeps a BOM only away from the start of the file", () => {
    const payload = Buffer.from("﻿x", "utf8");
    const first = parseTextWindow(
      window({ offset: 0, returned: 4, size: 4 }, payload),
      range(0, 8),
    );
    const later = parseTextWindow(
      window({ offset: 9, returned: 4, size: 13 }, payload),
      range(9, 8),
    );
    expect(first).toMatchObject({ value: { text: "x" } });
    expect(later).toMatchObject({ value: { text: "﻿x" } });
  });
  it("answers not-text for NUL or broken UTF-8", () => {
    expect(
      parseTextWindow(
        window({ offset: 0, returned: 2, size: 2 }, Buffer.from([0x61, 0])),
        range(0, 8),
      ),
    ).toMatchObject({ ok: false, error: { code: "WORKSPACE_NOT_TEXT" } });
    expect(
      parseTextWindow(
        window({ offset: 0, returned: 2, size: 2 }, Buffer.from([0xff, 0x61])),
        range(0, 8),
      ),
    ).toMatchObject({ ok: false, error: { code: "WORKSPACE_NOT_TEXT" } });
  });
  it("refuses headers that disagree with the request or payload", () => {
    const p = Buffer.from("abc");
    refuses(() => parseTextWindow(Buffer.from("no newline"), range(0, 8)));
    refuses(() =>
      parseTextWindow(
        window({ offset: 1, returned: 3, size: 9 }, p),
        range(0, 8),
      ),
    );
    refuses(() =>
      parseTextWindow(
        window({ offset: 0, returned: 2, size: 9 }, p),
        range(0, 8),
      ),
    );
    refuses(() =>
      parseTextWindow(
        window({ offset: 0, returned: 3, size: 9 }, p),
        range(0, 2),
      ),
    );
    refuses(() =>
      parseTextWindow(
        window({ offset: 0, returned: 3, size: 2 }, p),
        range(0, 8),
      ),
    );
    refuses(() =>
      parseTextWindow(
        window({ offset: 0, returned: 3, size: -1 }, p),
        range(0, 8),
      ),
    );
    refuses(() =>
      parseTextWindow(window({ offset: 0, returned: 3 }, p), range(0, 8)),
    );
  });
});

describe("parseMutationReceipt", () => {
  const HASH = "b".repeat(64);
  const write = {
    kind: "workspace.write",
    relativePath: "a.txt",
    content: "x",
    expectedSha256: null,
  } as const;
  const edit = {
    kind: "workspace.edit",
    relativePath: "a.txt",
    expectedSha256: HASH,
    edits: [{ oldText: "a", newText: "b" }],
  } as const;
  const reply = (extra: Record<string, unknown> = {}) =>
    json({
      afterSha256: HASH,
      beforeSha256: null,
      bytes: 1,
      replacements: 0,
      ...extra,
    });

  it("builds a write receipt", () => {
    expect(parseMutationReceipt(reply(), write)).toEqual({
      ok: true,
      value: {
        kind: "workspace.mutation",
        operation: "write",
        relativePath: "a.txt",
        bytes: 1,
        replacements: 0,
        beforeSha256: null,
        afterSha256: HASH,
      },
    });
  });
  it("builds an edit receipt with its replacement count", () => {
    expect(
      parseMutationReceipt(
        reply({ beforeSha256: HASH, replacements: 2 }),
        edit,
      ),
    ).toMatchObject({
      ok: true,
      value: { operation: "edit", replacements: 2, beforeSha256: HASH },
    });
  });
  it("refuses receipts that contradict the operation or their bounds", () => {
    refuses(() => parseMutationReceipt(reply({ replacements: 1 }), write));
    refuses(() => parseMutationReceipt(reply({ replacements: 0 }), edit));
    refuses(() => parseMutationReceipt(reply({ replacements: 257 }), edit));
    refuses(() => parseMutationReceipt(reply({ bytes: -1 }), write));
    refuses(() =>
      parseMutationReceipt(reply({ bytes: 8 * 1024 * 1024 + 1 }), write),
    );
    refuses(() => parseMutationReceipt(reply({ afterSha256: "x" }), write));
    refuses(() => parseMutationReceipt(reply({ beforeSha256: "x" }), write));
    refuses(() => parseMutationReceipt(json({ bytes: 1 }), write));
  });
});
