// A small TOML lexer with exact spans. It exists so that the redactor and the
// conflict scanner agree on what is a comment, a string and a key, and never
// look for keys inside strings or comments. It is not a validator: anything it
// cannot delimit is consumed to the end of the line (a string opener that
// never closes: to the end of the line, or to the end of the text for a
// multi-line opener), so it fails closed rather than resynchronising inside a
// value.

export type TomlTokenKind =
  | "comment"
  | "string"
  | "bare"
  | "dot"
  | "equals"
  | "punct"
  | "newline"
  | "other";

export type TomlToken = Readonly<{
  kind: TomlTokenKind;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the last character. */
  end: number;
  /** Strings only: a triple-quoted string. */
  multiline?: boolean;
  /** Strings only: the closing delimiter was found. */
  terminated?: boolean;
  /** Strings only: a `'` or `'''` string, which has no escapes. */
  literal?: boolean;
}>;

function isBareChar(char: string): boolean {
  return /[A-Za-z0-9_-]/u.test(char);
}

/** End of the line holding `from`, excluding a CR before the line feed. */
export function lineEndOf(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline === -1 ? text.length : newline;
  return end > from && text.charAt(end - 1) === "\r" ? end - 1 : end;
}

// A multi-line string may close with up to two extra quote characters.
function absorbQuotes(text: string, at: number, quote: string): number {
  let end = at;
  while (end < text.length && end - at < 2 && text.charAt(end) === quote) {
    end += 1;
  }
  return end;
}

function lexString(text: string, start: number): TomlToken {
  const quote = text.charAt(start);
  const literal = quote === "'";
  const triple = text.startsWith(quote.repeat(3), start);
  if (triple) {
    for (let i = start + 3; i < text.length; i += 1) {
      if (!literal && text.charAt(i) === "\\") i += 1;
      else if (text.startsWith(quote.repeat(3), i)) {
        return {
          kind: "string",
          start,
          end: absorbQuotes(text, i + 3, quote),
          multiline: true,
          terminated: true,
          literal,
        };
      }
    }
    return {
      kind: "string",
      start,
      end: text.length,
      multiline: true,
      terminated: false,
      literal,
    };
  }
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === "\n") break;
    if (!literal && char === "\\") {
      // A single-line string never continues past its line, escaped or not:
      // a backslash before the newline still ends it there (fail closed).
      if (text.charAt(i + 1) === "\n") break;
      i += 1;
    } else if (char === quote) {
      return {
        kind: "string",
        start,
        end: i + 1,
        multiline: false,
        terminated: true,
        literal,
      };
    }
  }
  return {
    kind: "string",
    start,
    end: lineEndOf(text, start),
    multiline: false,
    terminated: false,
    literal,
  };
}

export function lexToml(text: string): readonly TomlToken[] {
  const tokens: TomlToken[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === " " || char === "\t" || char === "\r") {
      at += 1;
    } else if (char === "\n") {
      tokens.push({ kind: "newline", start: at, end: at + 1 });
      at += 1;
    } else if (char === "#") {
      const end = lineEndOf(text, at);
      tokens.push({ kind: "comment", start: at, end });
      at = end;
    } else if (char === '"' || char === "'") {
      const token = lexString(text, at);
      tokens.push(token);
      at = token.end;
    } else if (isBareChar(char)) {
      let end = at + 1;
      while (end < text.length && isBareChar(text.charAt(end))) end += 1;
      tokens.push({ kind: "bare", start: at, end });
      at = end;
    } else {
      const kind: TomlTokenKind =
        char === "."
          ? "dot"
          : char === "="
            ? "equals"
            : "{}[],".includes(char)
              ? "punct"
              : "other";
      tokens.push({ kind, start: at, end: at + 1 });
      at += 1;
    }
  }
  return tokens;
}

/**
 * Offsets of the line starts that fall inside a multi-line string: such a line
 * is value content, never a header, comment or key line.
 */
export function lineStartsInsideStrings(text: string): ReadonlySet<number> {
  const inside = new Set<number>();
  for (const token of lexToml(text)) {
    if (token.kind !== "string" || token.multiline !== true) continue;
    let newline = text.indexOf("\n", token.start);
    while (newline !== -1 && newline + 1 < token.end) {
      inside.add(newline + 1);
      newline = text.indexOf("\n", newline + 1);
    }
  }
  return inside;
}

/** The text a key token names: escapes decoded for a basic string. */
export function keyText(text: string, token: TomlToken): string | undefined {
  if (token.kind === "bare") return text.slice(token.start, token.end);
  if (token.kind !== "string" || token.multiline === true) return undefined;
  if (token.terminated !== true) return undefined;
  const body = text.slice(token.start + 1, token.end - 1);
  if (token.literal === true) return body;
  return body.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/gu,
    (
      _m,
      short: string | undefined,
      long: string | undefined,
      other: string,
    ) => {
      if (short !== undefined || long !== undefined) {
        const code = Number.parseInt(short ?? long ?? "", 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      switch (other) {
        case "b":
          return "\b";
        case "t":
          return "\t";
        case "n":
          return "\n";
        case "f":
          return "\f";
        case "r":
          return "\r";
        default:
          return other;
      }
    },
  );
}
