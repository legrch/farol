import { redactBearerTokenLiterals } from "./redact";
import { textOf, type Bytes, type ManagedRegion } from "./region";
import { keyText, lexToml, lineStartsInsideStrings } from "./lex";

// TOML line classification — enough to recognise every spelling under which a
// foreign entry could define the keys Farol owns, never a full parser.

export type FarolModelConfigConflict = Readonly<{
  /** The dotted key path the foreign entry defines (e.g. `model_providers.farol`). */
  table: string;
  line: string;
}>;

type KeyOccurrence = Readonly<{
  path: readonly string[];
  /** True for a `[table]` / `[[table]]` header, false for a `key = value` line. */
  header: boolean;
  /** True when the occurrence sits in the root table (before any header). */
  root: boolean;
  line: string;
}>;

/**
 * Parses a dotted key (`a."b c".d`) starting at `from` with the shared lexer,
 * so a quoted segment is decoded exactly as the redactor decodes it. Returns
 * the segments and the offset of the first token after the key.
 */
function parseDottedKey(
  text: string,
  from: number,
): Readonly<{ path: string[]; next: number }> | undefined {
  const rest = text.slice(from);
  const tokens = lexToml(rest);
  const segments: string[] = [];
  let at = 0;
  for (;;) {
    const token = tokens[at];
    if (token === undefined) return undefined;
    const segment = keyText(rest, token);
    if (segment === undefined) return undefined;
    segments.push(segment);
    at += 1;
    if (tokens[at]?.kind === "dot") {
      at += 1;
      continue;
    }
    return { path: segments, next: from + (tokens[at]?.start ?? rest.length) };
  }
}

export function parseHeader(line: string): readonly string[] | undefined {
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

export function keyOccurrences(bytes: Bytes): readonly KeyOccurrence[] {
  const occurrences: KeyOccurrence[] = [];
  let table: readonly string[] = [];
  let sawHeader = false;
  const text = textOf(bytes);
  // A line that starts inside a multi-line string is value content, however
  // much it looks like a header or a key.
  const insideString = lineStartsInsideStrings(text);
  let lineStart = 0;
  for (const rawLine of text.split("\n")) {
    const thisStart = lineStart;
    lineStart += rawLine.length + 1;
    if (insideString.has(thisStart)) continue;
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
export function findForeignProviderConflicts(
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
export function findForeignSelectionConflicts(
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
export function firstForeignHeaderOffset(
  bytes: Bytes,
  block: ManagedRegion | undefined,
): number | undefined {
  let offset = 0;
  const insideString = lineStartsInsideStrings(bytes);
  for (const rawLine of bytes.split("\n")) {
    const inside =
      (block !== undefined && offset >= block.start && offset < block.end) ||
      insideString.has(offset);
    if (!inside && parseHeader(textOf(rawLine)) !== undefined) return offset;
    offset += rawLine.length + 1;
  }
  return undefined;
}
