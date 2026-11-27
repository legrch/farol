import { TextDecoder } from "node:util";

import { validTrackedPath } from "./paths";

// The fixed status invocation: porcelain v1, NUL-terminated (`-z`), so every
// path arrives raw -- no C-quoting Git would otherwise apply to a space, a
// non-ASCII character or an arrow -- and is parsed structurally
// (`parsePorcelainStatus`) rather than by line. One `:(exclude,top,literal)`
// pathspec per denied prefix keeps Git from even considering a tracked path
// the workspace's own exclusions cover (such a path is never in the snapshot
// either, so without the exclusion Git would report it deleted);
// `literal` disables glob interpretation of the prefix and `top` anchors it
// at the snapshot root whatever the working directory. The rendered result
// is filtered against the same prefixes again (`isUnderAnyPrefix`, folded
// the way the helper folds), so nothing rests on Git's own matching alone.
// Exported for the per-layer tests: the denied prefixes are enforced in
// three independent places (the snapshot never carries them, Git is never
// asked for them, and the rendered result is filtered again), and each
// layer is proven on its own rather than only through the whole route.
export function statusArguments(
  deniedPrefixes: readonly string[],
): readonly string[] {
  return [
    "status",
    "--porcelain",
    "--branch",
    "-z",
    "--untracked-files=no",
    "--ignore-submodules=all",
    ...(deniedPrefixes.length > 0
      ? [
          "--",
          ...deniedPrefixes.map((prefix) => `:(exclude,top,literal)${prefix}`),
        ]
      : []),
  ];
}

// The two-character status field of a porcelain v1 record, per column.
const STATUS_CODE_CHARACTERS = new Set([
  " ",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
]);

export type StatusRecord = Readonly<{
  code: string;
  path: string;
  // Renames and copies carry the path the content came from as a second
  // NUL-terminated field.
  original?: string;
}>;

export type ParsedStatus =
  | Readonly<{
      kind: "ok";
      header: string | null;
      records: readonly StatusRecord[];
    }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "unsupported-path" }>;

// Parses `git status --porcelain --branch -z` structurally: an optional
// `## <branch>` header, then `XY <path>` records, each NUL-terminated, a
// rename or copy followed by one more NUL-terminated field holding the
// original path. Paths arrive raw (no quoting under `-z`), so a denied
// prefix can be matched against the exact bytes Git saw, and the rendered
// result never has to undo an escape. Anything outside this shape is
// `malformed`; a path this route will not render is `unsupported-path`.
export function parsePorcelainStatus(stdout: Buffer): ParsedStatus {
  if (stdout.length === 0) return { kind: "ok", header: null, records: [] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return { kind: "malformed" };
  }
  const fields = text.split("\0");
  if (fields.length < 2 || fields[fields.length - 1] !== "") {
    return { kind: "malformed" };
  }
  fields.pop();
  let header: string | null = null;
  let position = 0;
  const first = fields[0];
  if (first !== undefined && first.startsWith("## ")) {
    header = first.slice(3);
    if (header.length === 0 || /[\r\n]/u.test(header)) {
      return { kind: "malformed" };
    }
    position = 1;
  }
  const records: StatusRecord[] = [];
  while (position < fields.length) {
    const field = fields[position] ?? "";
    position += 1;
    const code = field.slice(0, 2);
    if (
      field.length < 4 ||
      field.charAt(2) !== " " ||
      code === "  " ||
      !STATUS_CODE_CHARACTERS.has(field.charAt(0)) ||
      !STATUS_CODE_CHARACTERS.has(field.charAt(1))
    ) {
      return { kind: "malformed" };
    }
    const target = field.slice(3);
    if (!validTrackedPath(target)) return { kind: "unsupported-path" };
    if (code.includes("R") || code.includes("C")) {
      const original = fields[position];
      position += 1;
      if (original === undefined) return { kind: "malformed" };
      if (!validTrackedPath(original)) return { kind: "unsupported-path" };
      records.push({ code, path: target, original });
    } else {
      records.push({ code, path: target });
    }
  }
  return { kind: "ok", header, records };
}

// Renders the parsed status the way `git status --short --branch` would,
// minus the C-quoting: `## <branch>`, then `XY <path>` or
// `XY <original> -> <path>`, one per line, paths as raw UTF-8.
export function renderStatus(
  header: string | null,
  records: readonly StatusRecord[],
): string {
  const lines: string[] = [];
  if (header !== null) lines.push(`## ${header}`);
  for (const record of records) {
    lines.push(
      record.original === undefined
        ? `${record.code} ${record.path}`
        : `${record.code} ${record.original} -> ${record.path}`,
    );
  }
  return lines.map((line) => `${line}\n`).join("");
}
