// Byte surgery on the marked regions of a Codex `config.toml`: the markers,
// the latin1 byte string they travel as, and locating, replacing, removing and
// inserting one region. Pure: nothing here touches a file.

export const BLOCK_BEGIN_MARKER =
  "# BEGIN FAROL MANAGED BLOCK — do not edit by hand";
export const BLOCK_END_MARKER = "# END FAROL MANAGED BLOCK";

export const SELECTION_BEGIN_MARKER =
  "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand";
export const SELECTION_END_MARKER =
  "# END FAROL MANAGED MODEL_PROVIDER SELECTION";

// The file's bytes travel as a latin1 string: one JS char per byte, so slicing
// and concatenation never re-encode anything the owner wrote.

export type Bytes = string;

export function bytesOf(text: string): Bytes {
  return Buffer.from(text, "utf8").toString("latin1");
}

export function textOf(bytes: Bytes): string {
  return Buffer.from(bytes, "latin1").toString("utf8");
}

export const BLOCK_BEGIN = bytesOf(BLOCK_BEGIN_MARKER);
export const BLOCK_END = bytesOf(BLOCK_END_MARKER);
export const SELECTION_BEGIN = bytesOf(SELECTION_BEGIN_MARKER);
export const SELECTION_END = bytesOf(SELECTION_END_MARKER);

export type ManagedRegion = Readonly<{
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

export type LocatedRegion =
  | Readonly<{ ok: true; region: ManagedRegion | undefined }>
  | Readonly<{ ok: false }>;

export function atLineStart(bytes: Bytes, offset: number): boolean {
  return offset === 0 || bytes.charAt(offset - 1) === "\n";
}

/** Length of the line break at `offset`; 0 at end of file; -1 if the line goes on. */
export function lineBreakAt(bytes: Bytes, offset: number): number {
  if (offset >= bytes.length) return 0;
  if (bytes.startsWith("\r\n", offset)) return 2;
  if (bytes.charAt(offset) === "\n") return 1;
  return -1;
}

export function locateRegion(
  bytes: Bytes,
  begin: Bytes,
  end: Bytes,
): LocatedRegion {
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
export function regionText(bytes: Bytes, region: ManagedRegion): Bytes {
  const withBreak = bytes.slice(region.start, region.end);
  if (withBreak.endsWith("\r\n")) return withBreak.slice(0, -2);
  if (withBreak.endsWith("\n")) return withBreak.slice(0, -1);
  return withBreak;
}

/**
 * The byte span a removal cuts: the region with its own line terminator, plus
 * the one separator `insertAt` put before it — but only where that separator
 * can be told apart from an owner line terminator, so removal never joins two
 * owner lines. Of what precedes the region:
 *
 * - nothing: the region sat first; no separator was added.
 * - a blank line (a terminator right before the leading break): that break is
 *   the inserted separator.
 * - an owner line, with the file ending or a blank line following the region:
 *   `insertAt` put its separator after an unterminated line (a file with no
 *   final newline, or an offset at the end of a line), so the break goes too.
 * - an owner line, with owner text following: the break terminates the owner's
 *   line and stays; only the region goes.
 *
 * Documented residual: when the owner removed Farol's own separator and the
 * region is then at the end of the file or in front of a blank line, the
 * break before it looks exactly like the one `insertAt` adds after an
 * unterminated line, and the bytes cannot say which it is. Removal prefers
 * round-tripping Farol's own insertion, so in that one layout it may drop or
 * normalise the owner's final line terminator (never joining two lines).
 */
export function removalSpan(
  bytes: Bytes,
  region: ManagedRegion,
): Readonly<{ from: number; to: number }> {
  const separatorAt = region.start - region.leading;
  const after = bytes.slice(region.end);
  const separatorWasInserted =
    separatorAt > 0 &&
    (bytes.charAt(separatorAt - 1) === "\n" ||
      after.length === 0 ||
      after.startsWith("\n") ||
      after.startsWith("\r\n"));
  return {
    from: separatorWasInserted ? separatorAt : region.start,
    to: region.end,
  };
}

export function removeRegion(bytes: Bytes, region: ManagedRegion): Bytes {
  const { from, to } = removalSpan(bytes, region);
  return bytes.slice(0, from) + bytes.slice(to);
}

export function replaceRegion(
  bytes: Bytes,
  region: ManagedRegion,
  body: Bytes,
): Bytes {
  return `${bytes.slice(0, region.start)}${body}\n${bytes.slice(region.end)}`;
}

export function insertAt(bytes: Bytes, offset: number, body: Bytes): Bytes {
  const separator = offset === 0 ? "" : "\n";
  return `${bytes.slice(0, offset)}${separator}${body}\n${bytes.slice(offset)}`;
}

export function nestedInside(
  inner: ManagedRegion,
  outer: ManagedRegion,
): boolean {
  return inner.start > outer.start && inner.end <= outer.end;
}
