import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The managed-config-block lifecycle for an ordinary Codex `config.toml`.
// See Decisions.md N04, item 3-4, and the N04 addendum. This module never
// parses the file into a TOML document and re-serializes it — that would
// risk reformatting sections Farol did not write. Instead it does byte
// surgery on marked regions, so every byte outside those regions is
// untouched, by construction.
//
// Two independent regions, each with its own marker pair, backup, and
// consent:
//   1. The provider block — `[model_providers.<name>]` only. Never a
//      `[profiles.<name>]` table: the addendum found that legacy on this
//      host version, and codex-cli 0.153.4 refuses `--profile` against a
//      config that carries one. Selecting the provider is a separate act.
//   2. The provider selection — the root-table `model_provider = "…"` and
//      `model = "…"` pair. TOML requires a root-table key to precede every
//      `[table]` header in the file, so this region is inserted before the
//      first table header (or before the provider block itself, whichever
//      comes first), never appended blindly.
//
// Exact-bytes invariant. A region is written as
//   <one "\n" when anything precedes it> BEGIN-marker … END-marker "\n"
// and nothing else: no trimming of what was there, no extra blank lines.
// Rollback therefore needs nothing but the current file: it removes the
// region plus the one line break Farol placed before it, and every other
// byte — including whatever the owner added after the apply — stays where
// it was. The backups this module keeps are secondary evidence for the
// owner; they are never the rollback source. The file's bytes travel as a
// latin1 string so the surgery is binary-safe (no UTF-8 re-encoding).

const BLOCK_BEGIN_MARKER = "# BEGIN FAROL MANAGED BLOCK — do not edit by hand";
const BLOCK_END_MARKER = "# END FAROL MANAGED BLOCK";
const BLOCK_BACKUP_SUFFIX = ".farol-backup";

const SELECTION_BEGIN_MARKER =
  "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand";
const SELECTION_END_MARKER = "# END FAROL MANAGED MODEL_PROVIDER SELECTION";
const SELECTION_BACKUP_SUFFIX = ".farol-selection-backup";

/**
 * Marks a `config.toml` that did not exist before Farol's first apply, so a
 * rollback that leaves no bytes at all removes the file instead of leaving
 * an empty one. It is the one fact the current bytes cannot carry.
 */
const CREATED_MARKER_SUFFIX = ".farol-created";

/** What the preview shows in place of a bearer-token literal. */
export const FAROL_MODEL_TOKEN_PLACEHOLDER = "<redacted: Farol Model token>";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

/**
 * The host-side retry contract the managed block pins, so an ordinary Codex
 * never retries or re-streams a Farol turn on its own: these are the same
 * values `codex-app-server-process.ts` passes for the host Farol launches
 * itself. A retried turn would be a second submission of the same request.
 */
export const FAROL_MODEL_HOST_TUNING = Object.freeze({
  requiresOpenAiAuth: false,
  requestMaxRetries: 0,
  streamMaxRetries: 0,
  streamIdleTimeoutMs: 120_000,
});

/**
 * How the bearer credential reaches Codex. `env-key` names an environment
 * variable Codex reads once at process start — Farol uses this when it
 * starts the host itself, so the literal token never touches disk. A GUI
 * Codex the owner starts themselves has no shell to receive an environment
 * variable from, so that case carries the token literal in the file
 * (`experimental_bearer_token`, the only credential field codex-cli 0.153.4
 * accepts besides `env_key`) — gated on the file not being group- or
 * other-readable.
 */
export type FarolModelDelivery =
  | Readonly<{ mode: "env-key"; envKeyName: string }>
  | Readonly<{ mode: "bearer-token"; token: string }>;

/** The two values the consented selection region writes into the root table. */
export type FarolModelProviderSelection = Readonly<{
  /** The `model_providers.<name>` table name Farol owns. */
  providerName: string;
  /** The one model the Farol Model endpoint serves (the Route B model). */
  model: string;
}>;

export type FarolModelProviderSpec = FarolModelProviderSelection &
  Readonly<{
    displayName: string;
    baseUrl: string;
    wireApi: "responses";
    delivery: FarolModelDelivery;
  }>;

export type FarolModelConfigConflict = Readonly<{
  /** The dotted key path the foreign entry defines (e.g. `model_providers.farol`). */
  table: string;
  line: string;
}>;

export type FarolModelConfigInsecurePermissions = Readonly<{
  status: "insecure_permissions";
  mode: number;
}>;

/**
 * Closed refusals shared by every operation: `symlink` — the path is a
 * symbolic link, which this module never reads through or renames over;
 * `malformed` — a Farol marker is present but missing, duplicated, moved
 * off its own line, or its partner is gone, so the region's extent is not
 * knowable and nothing is written.
 */
export type FarolModelConfigRefusal =
  Readonly<{ status: "symlink" }> | Readonly<{ status: "malformed" }>;

export type FarolModelConfigPreview =
  | Readonly<{
      status: "install" | "update";
      /** Line diff of the whole change; bearer-token literals are redacted. */
      diff: string;
      /** True when the diff carried at least one redacted token literal. */
      tokenRedacted: boolean;
    }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions
  | FarolModelConfigRefusal;

export type FarolModelConfigApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions
  | FarolModelConfigRefusal;

export type FarolModelConfigRollbackResult =
  | Readonly<{ status: "restored" }>
  | Readonly<{ status: "not_present" }>
  | FarolModelConfigRefusal;

export type FarolModelSelectionPreview =
  | Readonly<{ status: "install" | "update"; diff: string }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigRefusal;

export type FarolModelSelectionApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigRefusal;

// ---------------------------------------------------------------------------
// Bytes. The file travels as a latin1 string: one JS char per byte, so
// slicing and concatenation never re-encode anything the owner wrote.

type Bytes = string;

function bytesOf(text: string): Bytes {
  return Buffer.from(text, "utf8").toString("latin1");
}

function textOf(bytes: Bytes): string {
  return Buffer.from(bytes, "latin1").toString("utf8");
}

const BLOCK_BEGIN = bytesOf(BLOCK_BEGIN_MARKER);
const BLOCK_END = bytesOf(BLOCK_END_MARKER);
const SELECTION_BEGIN = bytesOf(SELECTION_BEGIN_MARKER);
const SELECTION_END = bytesOf(SELECTION_END_MARKER);

function tomlString(value: string): string {
  // JSON escaping is a subset of TOML basic-string escaping.
  return JSON.stringify(value);
}

function buildProviderBlockBody(spec: FarolModelProviderSpec): string {
  return [
    BLOCK_BEGIN_MARKER,
    `[model_providers.${spec.providerName}]`,
    `name = ${tomlString(spec.displayName)}`,
    `base_url = ${tomlString(spec.baseUrl)}`,
    spec.delivery.mode === "env-key"
      ? `env_key = ${tomlString(spec.delivery.envKeyName)}`
      : `experimental_bearer_token = ${tomlString(spec.delivery.token)}`,
    `wire_api = ${tomlString(spec.wireApi)}`,
    `requires_openai_auth = ${String(FAROL_MODEL_HOST_TUNING.requiresOpenAiAuth)}`,
    `request_max_retries = ${String(FAROL_MODEL_HOST_TUNING.requestMaxRetries)}`,
    `stream_max_retries = ${String(FAROL_MODEL_HOST_TUNING.streamMaxRetries)}`,
    `stream_idle_timeout_ms = ${String(FAROL_MODEL_HOST_TUNING.streamIdleTimeoutMs)}`,
    BLOCK_END_MARKER,
  ].join("\n");
}

function buildSelectionBody(selection: FarolModelProviderSelection): string {
  return [
    SELECTION_BEGIN_MARKER,
    `model_provider = ${tomlString(selection.providerName)}`,
    `model = ${tomlString(selection.model)}`,
    SELECTION_END_MARKER,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Regions.

type ManagedRegion = Readonly<{
  /** Offset of the BEGIN marker; always at a line start. */
  start: number;
  /** Offset just past the END marker's own line break (or end of file). */
  end: number;
  /**
   * Bytes of the one line break Farol placed before the region: 0 at
   * offset 0, else 1 (`\n`) — or 2 when an editor rewrote it as `\r\n`.
   */
  leading: number;
}>;

type LocatedRegion =
  | Readonly<{ ok: true; region: ManagedRegion | undefined }>
  | Readonly<{ ok: false }>;

function atLineStart(bytes: Bytes, offset: number): boolean {
  return offset === 0 || bytes.charAt(offset - 1) === "\n";
}

/** Length of the line break at `offset`; 0 at end of file; -1 if the line goes on. */
function lineBreakAt(bytes: Bytes, offset: number): number {
  if (offset >= bytes.length) return 0;
  if (bytes.startsWith("\r\n", offset)) return 2;
  if (bytes.charAt(offset) === "\n") return 1;
  return -1;
}

function locateRegion(bytes: Bytes, begin: Bytes, end: Bytes): LocatedRegion {
  const start = bytes.indexOf(begin);
  if (start === -1) {
    // An END marker with no BEGIN is a torn region, not "absent".
    return bytes.includes(end)
      ? { ok: false }
      : { ok: true, region: undefined };
  }
  if (bytes.indexOf(begin, start + 1) !== -1) return { ok: false };
  if (!atLineStart(bytes, start)) return { ok: false };
  if (lineBreakAt(bytes, start + begin.length) < 0) return { ok: false };
  const endAt = bytes.indexOf(end, start + begin.length);
  if (endAt === -1 || bytes.indexOf(end) !== endAt) return { ok: false };
  if (!atLineStart(bytes, endAt)) return { ok: false };
  const trailing = lineBreakAt(bytes, endAt + end.length);
  if (trailing < 0) return { ok: false };
  const leading = start === 0 ? 0 : bytes.startsWith("\r\n", start - 2) ? 2 : 1;
  return {
    ok: true,
    region: { start, end: endAt + end.length + trailing, leading },
  };
}

/** Marker to marker, without the region's own trailing line break. */
function regionText(bytes: Bytes, region: ManagedRegion): Bytes {
  const withBreak = bytes.slice(region.start, region.end);
  if (withBreak.endsWith("\r\n")) return withBreak.slice(0, -2);
  if (withBreak.endsWith("\n")) return withBreak.slice(0, -1);
  return withBreak;
}

function removeRegion(bytes: Bytes, region: ManagedRegion): Bytes {
  return (
    bytes.slice(0, region.start - region.leading) + bytes.slice(region.end)
  );
}

function replaceRegion(
  bytes: Bytes,
  region: ManagedRegion,
  body: Bytes,
): Bytes {
  return `${bytes.slice(0, region.start)}${body}\n${bytes.slice(region.end)}`;
}

function insertAt(bytes: Bytes, offset: number, body: Bytes): Bytes {
  const separator = offset === 0 ? "" : "\n";
  return `${bytes.slice(0, offset)}${separator}${body}\n${bytes.slice(offset)}`;
}

function nestedInside(inner: ManagedRegion, outer: ManagedRegion): boolean {
  return inner.start > outer.start && inner.end <= outer.end;
}

// ---------------------------------------------------------------------------
// TOML line classification — enough to recognise every spelling under which
// a foreign entry could define the keys Farol owns, never a full parser.

type KeyOccurrence = Readonly<{
  path: readonly string[];
  /** True for a `[table]` / `[[table]]` header, false for a `key = value` line. */
  header: boolean;
  /** True when the occurrence sits in the root table (before any header). */
  root: boolean;
  line: string;
}>;

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function isBareKeyChar(char: string): boolean {
  return /[A-Za-z0-9_-]/u.test(char);
}

/** Parses a dotted key (`a."b c".d`) starting at `from`; returns the offset after it. */
function parseDottedKey(
  text: string,
  from: number,
): Readonly<{ path: string[]; next: number }> | undefined {
  const segments: string[] = [];
  let index = from;
  for (;;) {
    while (isWhitespace(text.charAt(index))) index += 1;
    const quote = text.charAt(index);
    let segment = "";
    if (quote === '"' || quote === "'") {
      index += 1;
      let closed = false;
      while (index < text.length) {
        const char = text.charAt(index);
        if (quote === '"' && char === "\\") {
          segment += text.charAt(index + 1);
          index += 2;
          continue;
        }
        if (char === quote) {
          closed = true;
          index += 1;
          break;
        }
        segment += char;
        index += 1;
      }
      if (!closed) return undefined;
    } else {
      const startedAt = index;
      while (index < text.length && isBareKeyChar(text.charAt(index))) {
        index += 1;
      }
      segment = text.slice(startedAt, index);
      if (segment.length === 0) return undefined;
    }
    segments.push(segment);
    while (isWhitespace(text.charAt(index))) index += 1;
    if (text.charAt(index) === ".") {
      index += 1;
      continue;
    }
    return { path: segments, next: index };
  }
}

function parseHeader(line: string): readonly string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return undefined;
  const array = trimmed.startsWith("[[");
  const key = parseDottedKey(trimmed, array ? 2 : 1);
  if (!key) return undefined;
  const closer = array ? "]]" : "]";
  if (!trimmed.startsWith(closer, key.next)) return undefined;
  const rest = trimmed.slice(key.next + closer.length).trim();
  if (rest.length > 0 && !rest.startsWith("#")) return undefined;
  return key.path;
}

function parseKeyLine(
  line: string,
): Readonly<{ path: readonly string[]; value: string }> | undefined {
  const key = parseDottedKey(line, 0);
  if (!key || line.charAt(key.next) !== "=") return undefined;
  return { path: key.path, value: line.slice(key.next + 1).trim() };
}

/** Every dotted key path an inline table `{ … }` defines, at any depth. */
function inlineTableKeyPaths(value: string): readonly (readonly string[])[] {
  if (!value.startsWith("{")) return [];
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let index = 1; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += value.charAt(index + 1);
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "{" || char === "[") {
      depth += 1;
      current += char;
    } else if (char === "}" || char === "]") {
      if (depth === 0) break;
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  const paths: (readonly string[])[] = [];
  for (const item of items) {
    const parsed = parseKeyLine(item.trim());
    if (!parsed) continue;
    paths.push(parsed.path);
    for (const nested of inlineTableKeyPaths(parsed.value)) {
      paths.push([...parsed.path, ...nested]);
    }
  }
  return paths;
}

function keyOccurrences(bytes: Bytes): readonly KeyOccurrence[] {
  const occurrences: KeyOccurrence[] = [];
  let table: readonly string[] = [];
  let sawHeader = false;
  for (const rawLine of textOf(bytes).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const header = parseHeader(line);
    if (header) {
      table = header;
      sawHeader = true;
      occurrences.push({ path: header, header: true, root: false, line });
      continue;
    }
    const key = parseKeyLine(line);
    if (!key) continue;
    const root = !sawHeader;
    occurrences.push({
      path: [...table, ...key.path],
      header: false,
      root,
      line,
    });
    for (const nested of inlineTableKeyPaths(key.value)) {
      occurrences.push({
        path: [...table, ...key.path, ...nested],
        header: false,
        root,
        line,
      });
    }
  }
  return occurrences;
}

function hasPrefix(
  candidate: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    candidate.length >= prefix.length &&
    prefix.every((segment, index) => candidate[index] === segment)
  );
}

function conflictOf(occurrence: KeyOccurrence): FarolModelConfigConflict {
  return {
    table: occurrence.path.join("."),
    line: redactBearerTokenLiterals(occurrence.line).text.trimEnd(),
  };
}

/**
 * Any definition of a key under `model_providers.<name>` that Farol did not
 * write — a `[model_providers.<name>]` header in any spelling (quoted,
 * spaced, with a trailing comment, `[[…]]`), a sub-table header, a
 * `<name> = …` or `<name>.key = …` line inside `[model_providers]`, or a
 * root-level dotted key / inline table reaching the same path.
 */
function findForeignProviderConflicts(
  scan: Bytes,
  providerName: string,
): FarolModelConfigConflict[] {
  const owned = ["model_providers", providerName];
  const conflicts: FarolModelConfigConflict[] = [];
  const seen = new Set<string>();
  for (const occurrence of keyOccurrences(scan)) {
    if (!hasPrefix(occurrence.path, owned)) continue;
    if (seen.has(occurrence.line)) continue;
    seen.add(occurrence.line);
    conflicts.push(conflictOf(occurrence));
  }
  return conflicts;
}

/**
 * A `model_provider` or `model` key in the root table (bare or quoted, plain
 * or dotted) that Farol did not write. TOML has no other place for a
 * root-table key than before the first `[table]` header, and a duplicate
 * key would make the whole file unparsable for Codex, so this is a
 * conflict rather than something to override.
 */
function findForeignSelectionConflicts(
  scan: Bytes,
): FarolModelConfigConflict[] {
  const conflicts: FarolModelConfigConflict[] = [];
  const seen = new Set<string>();
  for (const occurrence of keyOccurrences(scan)) {
    if (occurrence.header || !occurrence.root) continue;
    const first = occurrence.path[0];
    if (first !== "model_provider" && first !== "model") continue;
    if (seen.has(occurrence.line)) continue;
    seen.add(occurrence.line);
    conflicts.push(conflictOf(occurrence));
  }
  return conflicts;
}

/**
 * Offset of the first `[table]` header line outside the provider block, or
 * undefined when there is none. Lines inside the block are skipped so the
 * block's own header never pulls the selection inside the block.
 */
function firstForeignHeaderOffset(
  bytes: Bytes,
  block: ManagedRegion | undefined,
): number | undefined {
  let offset = 0;
  for (const rawLine of bytes.split("\n")) {
    const inside =
      block !== undefined && offset >= block.start && offset < block.end;
    if (!inside && parseHeader(textOf(rawLine)) !== undefined) return offset;
    offset += rawLine.length + 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Diff and redaction.

const MAX_DIFF_CELLS = 4_000_000;
const DIFF_CONTEXT = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffOp = Readonly<{ kind: " " | "-" | "+"; line: string }>;

function diffOps(
  before: readonly string[],
  after: readonly string[],
): DiffOp[] {
  if (before.length * after.length > MAX_DIFF_CELLS) {
    return [
      ...before.map((line) => ({ kind: "-" as const, line })),
      ...after.map((line) => ({ kind: "+" as const, line })),
    ];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      ops.push({ kind: "-", line: before[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "+", line: after[j] ?? "" });
      j += 1;
    }
  }
  for (; i < before.length; i += 1)
    ops.push({ kind: "-", line: before[i] ?? "" });
  for (; j < after.length; j += 1)
    ops.push({ kind: "+", line: after[j] ?? "" });
  return ops;
}

/** A whole-file line diff, with unchanged runs folded down to a little context. */
function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const ops = diffOps(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (
      let near = Math.max(0, index - DIFF_CONTEXT);
      near <= Math.min(ops.length - 1, index + DIFF_CONTEXT);
      near += 1
    ) {
      keep[near] = true;
    }
  });
  const rendered: string[] = [];
  let elided = 0;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      elided += 1;
      return;
    }
    if (elided > 0) {
      rendered.push(`… ${elided} unchanged line${elided === 1 ? "" : "s"}`);
      elided = 0;
    }
    rendered.push(`${op.kind}${op.line}`);
  });
  if (elided > 0) {
    rendered.push(`… ${elided} unchanged line${elided === 1 ? "" : "s"}`);
  }
  return rendered.join("\n");
}

const BEARER_TOKEN_LINE =
  /^([-+ ]?\s*experimental_bearer_token\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/gmu;

function redactBearerTokenLiterals(
  text: string,
  literal?: string,
): Readonly<{ text: string; redacted: boolean }> {
  let redacted = false;
  let output = text.replace(BEARER_TOKEN_LINE, (_match, head: string) => {
    redacted = true;
    return `${head}"${FAROL_MODEL_TOKEN_PLACEHOLDER}"`;
  });
  if (literal !== undefined && literal.length > 0 && output.includes(literal)) {
    output = output.split(literal).join(FAROL_MODEL_TOKEN_PLACEHOLDER);
    redacted = true;
  }
  return { text: output, redacted };
}

// ---------------------------------------------------------------------------
// Filesystem.

type ConfigRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "file"; bytes: Bytes; mode: number }>;

/**
 * Reads the file without ever following a symbolic link: an `lstat` first
 * for a clear answer, then `O_NOFOLLOW` on the open itself so a link
 * planted between the two calls is still refused.
 */
async function readConfig(configPath: string): Promise<ConfigRead> {
  try {
    if ((await fs.lstat(configPath)).isSymbolicLink())
      return { kind: "symlink" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  let handle;
  try {
    handle = await fs.open(
      configPath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "symlink" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("FAROL_MODEL_CONFIG_NOT_A_FILE");
    const buffer = await handle.readFile();
    return {
      kind: "file",
      bytes: buffer.toString("latin1"),
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Writes `bytes` to `target` atomically: an exclusive, no-follow temporary
 * file in the same directory, fsync, mode set on the open descriptor, then
 * rename. A symbolic link sitting at `target` is replaced by the rename,
 * never written through.
 */
async function atomicWriteNoFollow(
  target: string,
  bytes: Bytes,
  mode: number,
): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      mode,
    );
    await handle.writeFile(Buffer.from(bytes, "latin1"));
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function insecurePermissionsRefusal(
  delivery: FarolModelDelivery,
  mode: number | undefined,
): FarolModelConfigInsecurePermissions | undefined {
  // Only the literal-token delivery writes a secret into the file. A newly
  // created file is written 0600 by this module (see `defaultModeFor`), so
  // only an EXISTING file's current mode can trigger this refusal.
  if (delivery.mode !== "bearer-token" || mode === undefined) return undefined;
  if ((mode & 0o077) !== 0) return { status: "insecure_permissions", mode };
  return undefined;
}

function defaultModeFor(delivery: FarolModelDelivery): number {
  return delivery.mode === "bearer-token" ? 0o600 : 0o644;
}

// ---------------------------------------------------------------------------
// Plans: preview and apply share one computation, so what the owner
// consented to is exactly what gets written.

type WritePlan = Readonly<{
  kind: "write";
  before: Bytes;
  desired: Bytes;
  /** The existing file's mode, or undefined when the file does not exist. */
  mode: number | undefined;
  update: boolean;
  /** True when the file already carried neither managed region. */
  pristine: boolean;
}>;

type BlockPlan =
  | WritePlan
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | Readonly<{ kind: "insecure_permissions"; mode: number }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "malformed" }>;

async function planProviderBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<BlockPlan> {
  const read = await readConfig(configPath);
  if (read.kind === "symlink") return { kind: "symlink" };
  const before = read.kind === "file" ? read.bytes : "";
  const mode = read.kind === "file" ? read.mode : undefined;
  const insecure = insecurePermissionsRefusal(spec.delivery, mode);
  if (insecure) return { kind: "insecure_permissions", mode: insecure.mode };

  const block = locateRegion(before, BLOCK_BEGIN, BLOCK_END);
  const selection = locateRegion(before, SELECTION_BEGIN, SELECTION_END);
  if (!block.ok || !selection.ok) return { kind: "malformed" };

  const scan = block.region ? removeRegion(before, block.region) : before;
  const conflicts = findForeignProviderConflicts(scan, spec.providerName);
  if (conflicts.length > 0) return { kind: "conflict", conflicts };

  const body = bytesOf(buildProviderBlockBody(spec));
  let desired: Bytes;
  if (!block.region) {
    desired = insertAt(before, before.length, body);
  } else if (selection.region && nestedInside(selection.region, block.region)) {
    // A layout an earlier build produced: the selection was inserted before
    // the block's own table header, inside the block. Lift it out in front
    // of the rewritten block so each region stays independently removable.
    const lifted = regionText(before, selection.region);
    desired = insertAt(
      replaceRegion(before, block.region, body),
      block.region.start - block.region.leading,
      lifted,
    );
  } else {
    desired = replaceRegion(before, block.region, body);
  }
  if (read.kind === "file" && desired === before) return { kind: "noop" };
  return {
    kind: "write",
    before,
    desired,
    mode,
    update: block.region !== undefined,
    pristine: block.region === undefined && selection.region === undefined,
  };
}

type SelectionPlan =
  | WritePlan
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "malformed" }>;

async function planSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<SelectionPlan> {
  const read = await readConfig(configPath);
  if (read.kind === "symlink") return { kind: "symlink" };
  const before = read.kind === "file" ? read.bytes : "";
  const mode = read.kind === "file" ? read.mode : undefined;

  const existing = locateRegion(before, SELECTION_BEGIN, SELECTION_END);
  if (!existing.ok || !locateRegion(before, BLOCK_BEGIN, BLOCK_END).ok) {
    return { kind: "malformed" };
  }
  const base = existing.region ? removeRegion(before, existing.region) : before;
  // Re-locate the block in `base`: removing the selection shifts offsets.
  const block = locateRegion(base, BLOCK_BEGIN, BLOCK_END);
  if (!block.ok) return { kind: "malformed" };

  const conflicts = findForeignSelectionConflicts(base);
  if (conflicts.length > 0) return { kind: "conflict", conflicts };

  const candidates = [
    firstForeignHeaderOffset(base, block.region),
    block.region ? block.region.start - block.region.leading : undefined,
  ].filter((offset): offset is number => offset !== undefined);
  const offset = candidates.length > 0 ? Math.min(...candidates) : base.length;
  const desired = insertAt(
    base,
    offset,
    bytesOf(buildSelectionBody(selection)),
  );
  if (read.kind === "file" && desired === before) return { kind: "noop" };
  return {
    kind: "write",
    before,
    desired,
    mode,
    update: existing.region !== undefined,
    pristine: existing.region === undefined && block.region === undefined,
  };
}

async function executePlan(
  configPath: string,
  plan: WritePlan,
  backupSuffix: string,
  createdMode: number,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // Secondary evidence only: the bytes as they stood before this write.
  await atomicWriteNoFollow(`${configPath}${backupSuffix}`, plan.before, 0o600);
  const createdMarker = `${configPath}${CREATED_MARKER_SUFFIX}`;
  if (plan.mode === undefined) {
    await atomicWriteNoFollow(createdMarker, "", 0o600);
  } else if (plan.pristine) {
    // The owner has a file of their own here now; a stale marker from an
    // earlier, fully rolled-back apply must not delete it later.
    await fs.rm(createdMarker, { force: true });
  }
  await atomicWriteNoFollow(configPath, plan.desired, plan.mode ?? createdMode);
}

async function removeManagedRegion(
  configPath: string,
  begin: Bytes,
  end: Bytes,
  lift: Readonly<{ begin: Bytes; end: Bytes }> | undefined,
): Promise<FarolModelConfigRollbackResult> {
  const read = await readConfig(configPath);
  if (read.kind === "missing") return { status: "not_present" };
  if (read.kind === "symlink") return { status: "symlink" };
  const located = locateRegion(read.bytes, begin, end);
  if (!located.ok) return { status: "malformed" };
  if (!located.region) return { status: "not_present" };
  const region = located.region;

  let remaining = removeRegion(read.bytes, region);
  if (lift) {
    const inner = locateRegion(read.bytes, lift.begin, lift.end);
    if (!inner.ok) return { status: "malformed" };
    if (inner.region && nestedInside(inner.region, region)) {
      // Legacy nesting (see `planProviderBlock`): keep the inner region,
      // now standing where the outer one began.
      const keep = regionText(read.bytes, inner.region);
      remaining = insertAt(
        `${read.bytes.slice(0, region.start - region.leading)}${read.bytes.slice(region.end)}`,
        region.start - region.leading,
        keep,
      );
    }
  }

  const createdMarker = `${configPath}${CREATED_MARKER_SUFFIX}`;
  if (remaining.length === 0 && (await pathExists(createdMarker))) {
    await fs.rm(configPath, { force: true });
    await fs.rm(createdMarker, { force: true });
  } else {
    await atomicWriteNoFollow(configPath, remaining, read.mode);
  }
  return { status: "restored" };
}

// ---------------------------------------------------------------------------
// Public surface.

/**
 * Computes what applying `spec` to `configPath` would do, without writing
 * anything. A foreign entry of the same name Farol did not write is a
 * conflict, reported and never overwritten. A literal-token delivery
 * against a group- or other-readable existing file is refused before any
 * diff is computed. The diff never carries a bearer-token literal.
 */
export async function previewFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigPreview> {
  const plan = await planProviderBlock(configPath, spec);
  if (plan.kind === "write") {
    const literal =
      spec.delivery.mode === "bearer-token" ? spec.delivery.token : undefined;
    const { text, redacted } = redactBearerTokenLiterals(
      lineDiff(textOf(plan.before), textOf(plan.desired)),
      literal,
    );
    return {
      status: plan.update ? "update" : "install",
      diff: text,
      tokenRedacted: redacted,
    };
  }
  if (plan.kind === "insecure_permissions") {
    return { status: "insecure_permissions", mode: plan.mode };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/**
 * Applies `spec` to `configPath`: preview → consent is the caller's job
 * (call `previewFarolModelConfigBlock` first and get the owner's yes). This
 * writes atomically (temp file, fsync, rename), preserves the original
 * mode (or creates the file 0600 for a literal-token delivery, 0644
 * otherwise), rewrites an existing block in place, and keeps the pre-write
 * bytes as a 0600 backup. A second apply of the same desired state is a
 * no-op — it never touches the backup.
 */
export async function applyFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigApplyResult> {
  const plan = await planProviderBlock(configPath, spec);
  if (plan.kind === "write") {
    await executePlan(
      configPath,
      plan,
      BLOCK_BACKUP_SUFFIX,
      defaultModeFor(spec.delivery),
    );
    return { status: "applied" };
  }
  if (plan.kind === "insecure_permissions") {
    return { status: "insecure_permissions", mode: plan.mode };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/**
 * Removes exactly the managed provider block from the file's current bytes
 * — the region and the one line break Farol placed before it — and leaves
 * every other byte, including anything the owner added since, untouched.
 * A file Farol created that has nothing left in it is removed. Never
 * restores a backup: a torn or moved marker is refused as `malformed`.
 */
export async function rollbackFarolModelConfigBlock(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return removeManagedRegion(configPath, BLOCK_BEGIN, BLOCK_END, {
    begin: SELECTION_BEGIN,
    end: SELECTION_END,
  });
}

/**
 * Computes what consenting to select Farol as the default provider would
 * do — a separate, separately consented act from installing the provider
 * block itself (Decisions.md N04 addendum, item 2). The region carries both
 * root keys the host needs, `model_provider` and `model`; a foreign
 * root-table `model_provider` or `model` key Farol did not write is a
 * conflict.
 */
export async function previewFarolModelProviderSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<FarolModelSelectionPreview> {
  const plan = await planSelection(configPath, selection);
  if (plan.kind === "write") {
    return {
      status: plan.update ? "update" : "install",
      diff: lineDiff(textOf(plan.before), textOf(plan.desired)),
    };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/** Applies the provider selection. See `previewFarolModelProviderSelection`. */
export async function applyFarolModelProviderSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<FarolModelSelectionApplyResult> {
  const plan = await planSelection(configPath, selection);
  if (plan.kind === "write") {
    await executePlan(configPath, plan, SELECTION_BACKUP_SUFFIX, 0o644);
    return { status: "applied" };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/** Removes exactly the managed selection region. See `rollbackFarolModelConfigBlock`. */
export async function rollbackFarolModelProviderSelection(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return removeManagedRegion(
    configPath,
    SELECTION_BEGIN,
    SELECTION_END,
    undefined,
  );
}
