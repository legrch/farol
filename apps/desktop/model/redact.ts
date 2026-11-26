// Redaction of bearer-token literals from anything the owner is shown. The
// one boundary every evidence string (conflict line, provider diff, selection
// diff) crosses: it runs over the WHOLE config text, before any diff folds
// lines away, so a value that spans lines is replaced as one span and no
// continuation line is ever left without its key.

/** What the preview shows in place of a bearer-token literal. */
export const FAROL_MODEL_TOKEN_PLACEHOLDER = "<redacted: Farol Model token>";

const TOKEN_KEY = "experimental_bearer_token";

/**
 * Tells distinct redacted values apart without revealing them: the first
 * distinct value is the plain placeholder, later ones are numbered. Share one
 * registry between the texts of one diff so an unchanged value stays an
 * unchanged line and a changed one still shows as a change.
 */
export type RedactionRegistry = Map<string, number>;

export function newRedactionRegistry(): RedactionRegistry {
  return new Map();
}

function placeholderFor(registry: RedactionRegistry, raw: string): string {
  let id = registry.get(raw);
  if (id === undefined) {
    id = registry.size;
    registry.set(raw, id);
  }
  const label =
    id === 0
      ? FAROL_MODEL_TOKEN_PLACEHOLDER
      : `${FAROL_MODEL_TOKEN_PLACEHOLDER.slice(0, -1)} #${id + 1}>`;
  return `"${label}"`;
}

// Candidates, leftmost first: the key itself (bare, or followed by the closing
// quote of a quoted key), and any complete double-quoted string, which is
// inspected for an escaped spelling of the key (`_` for `_`).
const CANDIDATE = new RegExp(`${TOKEN_KEY}["']?|"(?:[^"\\\\\\n]|\\\\.)*"`, "g");

function decodeKey(raw: string): string {
  return raw.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g,
    (_m, short: string | undefined, long: string | undefined) => {
      const code = Number.parseInt(short ?? long ?? "", 16);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline === -1 ? text.length : newline;
  return end > from && text.charAt(end - 1) === "\r" ? end - 1 : end;
}

/**
 * End of the value that starts at `start`. A value that cannot be delimited
 * is withheld to the end of its line; an unterminated multi-line opener, to
 * the end of the text.
 */
function valueEnd(text: string, start: number): number {
  if (text.startsWith('"""', start)) {
    for (let i = start + 3; i < text.length; i += 1) {
      if (text.charAt(i) === "\\") i += 1;
      else if (text.startsWith('"""', i))
        return trailingQuotes(text, i + 3, '"');
    }
    return text.length;
  }
  if (text.startsWith("'''", start)) {
    const close = text.indexOf("'''", start + 3);
    return close === -1 ? text.length : trailingQuotes(text, close + 3, "'");
  }
  const quote = text.charAt(start);
  if (quote === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      const c = text.charAt(i);
      if (c === "\n") break;
      if (c === "\\") i += 1;
      else if (c === '"') return i + 1;
    }
    return lineEnd(text, start);
  }
  if (quote === "'") {
    const close = text.indexOf("'", start + 1);
    const end = lineEnd(text, start);
    return close !== -1 && close < end ? close + 1 : end;
  }
  return lineEnd(text, start);
}

// A multi-line string may close with up to two extra quote characters.
function trailingQuotes(text: string, at: number, quote: string): number {
  let end = at;
  while (end < text.length && end - at < 2 && text.charAt(end) === quote) {
    end += 1;
  }
  return end;
}

/**
 * Replaces the value of every `experimental_bearer_token` assignment in
 * `text` — under any key spelling, in any table or inline table, whatever its
 * string form — with a placeholder. A value that cannot be delimited fails
 * closed rather than open.
 */
export function redactConfigText(
  text: string,
  registry: RedactionRegistry = newRedactionRegistry(),
): Readonly<{ text: string; redacted: boolean }> {
  let output = "";
  let copied = 0;
  let redacted = false;
  CANDIDATE.lastIndex = 0;
  for (;;) {
    const match = CANDIDATE.exec(text);
    if (match === null) break;
    const candidate = match[0];
    const quotedString = candidate.startsWith('"');
    const isKey = quotedString
      ? candidate.includes("\\") && decodeKey(candidate).includes(TOKEN_KEY)
      : true;
    if (!isKey) {
      // A string that is not an escaped key: look inside it for a bare one.
      CANDIDATE.lastIndex = match.index + 1;
      continue;
    }
    let at = match.index + candidate.length;
    while (text.charAt(at) === " " || text.charAt(at) === "\t") at += 1;
    if (text.charAt(at) !== "=") {
      CANDIDATE.lastIndex = match.index + 1;
      continue;
    }
    at += 1;
    while (text.charAt(at) === " " || text.charAt(at) === "\t") at += 1;
    const end = valueEnd(text, at);
    if (end > at) {
      output += text.slice(copied, at);
      output += placeholderFor(registry, text.slice(at, end));
      copied = end;
      redacted = true;
    }
    CANDIDATE.lastIndex = Math.max(end, match.index + 1);
  }
  return { text: output + text.slice(copied), redacted };
}

export function redactBearerTokenLiterals(
  text: string,
  literal?: string,
  registry?: RedactionRegistry,
): Readonly<{ text: string; redacted: boolean }> {
  const base = redactConfigText(text, registry);
  let output = base.text;
  let redacted = base.redacted;
  if (literal !== undefined && literal.length > 0 && output.includes(literal)) {
    output = output.split(literal).join(FAROL_MODEL_TOKEN_PLACEHOLDER);
    redacted = true;
  }
  return { text: output, redacted };
}
