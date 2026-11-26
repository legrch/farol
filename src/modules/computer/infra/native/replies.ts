import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type {
  WorkspaceMutationReceipt,
  WorkspaceMutationRequest,
  WorkspaceMutationResult,
} from "../../app/port/mutable-workspace";
import type {
  ReadonlyWorkspaceResult,
  WorkspaceMatch,
  WorkspaceReadRange,
  WorkspaceText,
} from "../../app/port/readonly-workspace";
import { WorkspaceRefusal } from "./errors";
import { MAX_MUTATION_BYTES } from "./limits";
import {
  canonicalRelativePath,
  exactKeys,
  plainString,
  validSha256,
} from "./paths";
import { failure, success } from "./results";

// Parsers for the helper's replies. Each takes the bytes the helper wrote and
// either returns a typed result or refuses with WORKSPACE_HELPER_FAILED; none
// of them reads or writes anything.

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("ascii"));
  } catch {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
}

function validEntry(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  const directory = value.endsWith("/");
  const name = directory ? value.slice(0, -1) : value;
  return (
    plainString(name, 255) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

export function parseEntries(raw: Buffer): ReadonlyWorkspaceResult {
  const parsed = parseJson(raw);
  if (!exactKeys(parsed, ["entries", "truncated", "writableByOthers"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(value.entries) ||
    value.entries.length > 500 ||
    !value.entries.every(validEntry) ||
    typeof value.truncated !== "boolean" ||
    typeof value.writableByOthers !== "boolean"
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  // The root is writable by group or other users of this Mac. Like the Go
  // route, the mark is present only when true.
  return success({
    kind: "workspace.entries",
    entries: [...value.entries] as string[],
    truncated: value.truncated,
    ...(value.writableByOthers ? { writableByOthers: true as const } : {}),
  });
}

function validMatch(value: unknown): value is WorkspaceMatch {
  if (!exactKeys(value, ["line", "path", "text", "truncated"])) {
    return false;
  }
  const match = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(match.line) &&
    (match.line as number) > 0 &&
    canonicalRelativePath(match.path) &&
    typeof match.text === "string" &&
    !match.text.includes("\n") &&
    !match.text.includes("\r") &&
    [...match.text].length <= 500 &&
    [...match.text].every((character) => {
      const code = character.codePointAt(0);
      return (
        character === "\t" || (code !== undefined && code >= 32 && code !== 127)
      );
    }) &&
    typeof match.truncated === "boolean"
  );
}

export function parseMatches(raw: Buffer): ReadonlyWorkspaceResult {
  const parsed = parseJson(raw);
  if (!exactKeys(parsed, ["matches", "resultLimited", "scanLimited"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(value.matches) ||
    value.matches.length > 100 ||
    !value.matches.every(validMatch) ||
    typeof value.resultLimited !== "boolean" ||
    typeof value.scanLimited !== "boolean"
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  return success({
    kind: "workspace.matches",
    matches: value.matches.map((match) => ({ ...match })) as WorkspaceMatch[],
    resultLimited: value.resultLimited,
    scanLimited: value.scanLimited,
  });
}

export function parseText(
  raw: Buffer,
):
  | Readonly<{ ok: true; value: Extract<WorkspaceText, { sha256: string }> }>
  | Extract<ReadonlyWorkspaceResult, { ok: false }> {
  if (raw.includes(0))
    return { ok: false, error: { code: "WORKSPACE_NOT_TEXT", retry: "never" } };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ok: false, error: { code: "WORKSPACE_NOT_TEXT", retry: "never" } };
  }
  // Hash the same descriptor-bound buffer only after text validation. Decoding
  // drops a BOM; the edit precondition must identify the original bytes.
  return {
    ok: true,
    value: {
      kind: "workspace.text",
      text,
      bytes: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    },
  };
}

function continuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

// How many bytes the UTF-8 sequence that `lead` begins should span. An
// invalid lead counts as one byte and is left for the decoder to refuse.
function sequenceWidth(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

// The end of the last whole character in `payload`: an incomplete trailing
// sequence is left for the next window rather than decoded as broken text.
function wholeCharacterEnd(payload: Buffer, start: number): number {
  for (
    let index = payload.length - 1;
    index >= Math.max(start, payload.length - 4);
    index -= 1
  ) {
    const byte = payload[index];
    if (byte === undefined || continuationByte(byte)) continue;
    return index + sequenceWidth(byte) > payload.length
      ? index
      : payload.length;
  }
  return payload.length;
}

/**
 * The helper answers a window with one JSON header line, then the bytes it
 * read. A window may begin or end inside a multi-byte character, so it is
 * narrowed to whole characters: each window decodes on its own and the next
 * one begins exactly where this one's text ended. Only a window stopping short
 * of the file's end may end inside a character; one that reaches the end must
 * be complete text there, as a whole read must.
 */
export function parseTextWindow(
  raw: Buffer,
  range: WorkspaceReadRange,
): ReadonlyWorkspaceResult {
  const newline = raw.indexOf(0x0a);
  if (newline < 0) throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  const header = parseJson(raw.subarray(0, newline));
  if (!exactKeys(header, ["offset", "returned", "size"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const { offset, returned, size } = header as Readonly<
    Record<string, unknown>
  >;
  const payload = raw.subarray(newline + 1);
  if (
    offset !== range.offset ||
    returned !== payload.length ||
    payload.length > range.length ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (payload.length > 0 && range.offset + payload.length > (size as number))
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const fileSize = size as number;
  if (payload.includes(0)) return failure("WORKSPACE_NOT_TEXT");
  let start = 0;
  while (
    range.offset > 0 &&
    start < Math.min(3, payload.length) &&
    continuationByte(payload[start])
  ) {
    start += 1;
  }
  const end =
    range.offset + payload.length < fileSize
      ? wholeCharacterEnd(payload, start)
      : payload.length;
  const bytes = payload.subarray(start, end);
  let text: string;
  try {
    // A byte-order mark is dropped only where a whole read drops it: at the
    // very start of the file.
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: range.offset + start > 0,
    }).decode(bytes);
  } catch {
    return failure("WORKSPACE_NOT_TEXT");
  }
  const windowEnd = range.offset + end;
  return success({
    kind: "workspace.text",
    text,
    bytes: bytes.length,
    page: {
      offset: range.offset + start,
      size: fileSize,
      nextOffset: windowEnd < fileSize ? windowEnd : null,
    },
  });
}

export function parseMutationReceipt(
  raw: Buffer,
  operation: WorkspaceMutationRequest["operation"],
): WorkspaceMutationResult {
  const parsed = parseJson(raw);
  if (
    !exactKeys(parsed, ["afterSha256", "beforeSha256", "bytes", "replacements"])
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !validSha256(value.afterSha256) ||
    !(value.beforeSha256 === null || validSha256(value.beforeSha256)) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAX_MUTATION_BYTES ||
    !Number.isSafeInteger(value.replacements) ||
    (value.replacements as number) < 0 ||
    (value.replacements as number) > 256 ||
    (operation.kind === "workspace.write" && value.replacements !== 0) ||
    (operation.kind === "workspace.edit" && (value.replacements as number) < 1)
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const receipt: WorkspaceMutationReceipt = {
    kind: "workspace.mutation",
    operation: operation.kind === "workspace.write" ? "write" : "edit",
    relativePath: operation.relativePath,
    bytes: value.bytes as number,
    replacements: value.replacements as number,
    beforeSha256: value.beforeSha256 as string | null,
    afterSha256: value.afterSha256,
  };
  return { ok: true, value: receipt };
}
