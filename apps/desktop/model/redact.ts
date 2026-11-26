// Redaction of bearer-token literals from anything the owner is shown. The
// one boundary every evidence string (conflict line, provider diff, selection
// diff) crosses before it leaves the block module.

/** What the preview shows in place of a bearer-token literal. */
export const FAROL_MODEL_TOKEN_PLACEHOLDER = "<redacted: Farol Model token>";

const TOKEN_KEY = "experimental_bearer_token";

// A TOML string value: multi-line basic/literal, then basic (escapes), then
// literal. Multi-line forms may span lines (and diff prefixes inside them).
const VALUE = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'`;

// The key anywhere in a line: bare, quoted ("…"/'…'), the last segment of a
// dotted path, or inside an inline table at any depth. No anchoring: only
// the key and its `=` matter, never what precedes them.
const TOKEN_ASSIGNMENT = new RegExp(
  String.raw`(${TOKEN_KEY}["']?[ \t]*=[ \t]*)(${VALUE})`,
  "g",
);

// A quoted key that spells the token key with escapes (`\u005f` for `_`).
const ESCAPED_KEY_ASSIGNMENT = new RegExp(
  String.raw`("(?:[^"\\\n]|\\.)*\\[^"\n]*"[ \t]*=[ \t]*)(${VALUE})`,
  "g",
);

// A token key whose value is not a string we can delimit (an unterminated or
// non-string value): redact the rest of the line rather than leave it.
const TOKEN_REST_OF_LINE = new RegExp(
  String.raw`(${TOKEN_KEY}["']?[ \t]*=[ \t]*)(?!"${FAROL_MODEL_TOKEN_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")([^\s].*)$`,
  "gm",
);

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

export function redactBearerTokenLiterals(
  text: string,
  literal?: string,
): Readonly<{ text: string; redacted: boolean }> {
  let redacted = false;
  const quote = (head: string): string => {
    redacted = true;
    return `${head}"${FAROL_MODEL_TOKEN_PLACEHOLDER}"`;
  };
  let output = text.replace(TOKEN_ASSIGNMENT, (_match, head: string) =>
    quote(head),
  );
  output = output.replace(ESCAPED_KEY_ASSIGNMENT, (match, head: string) =>
    decodeKey(head).includes(TOKEN_KEY) ? quote(head) : match,
  );
  output = output.replace(TOKEN_REST_OF_LINE, (_match, head: string) =>
    quote(head),
  );
  if (literal !== undefined && literal.length > 0 && output.includes(literal)) {
    output = output.split(literal).join(FAROL_MODEL_TOKEN_PLACEHOLDER);
    redacted = true;
  }
  return { text: output, redacted };
}
