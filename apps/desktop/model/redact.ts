// Redaction of bearer-token literals from anything the owner is shown. The
// one boundary every evidence string (conflict line, provider diff, selection
// diff) crosses: it runs over the WHOLE config text, before any diff folds
// lines away, so a value that spans lines is replaced as one span and no
// continuation line is ever left without its key. It walks the lexer's
// tokens, so key-like text inside a string or a comment is never an
// assignment.

import { keyText, lexToml, lineEndOf } from "./lex";

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

/**
 * Replaces the value of every `experimental_bearer_token` assignment in
 * `text` — under any key spelling, in any table or inline table, whatever its
 * string form — with a placeholder. A value that is not a delimited string,
 * or whose string never closes, fails closed: it is withheld to the end of
 * its line (a multi-line opener, to the end of the text).
 */
export function redactConfigText(
  text: string,
  registry: RedactionRegistry = newRedactionRegistry(),
): Readonly<{ text: string; redacted: boolean }> {
  const tokens = lexToml(text);
  let output = "";
  let copied = 0;
  let redacted = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const equals = tokens[index];
    const key = tokens[index - 1];
    if (equals?.kind !== "equals" || key === undefined) continue;
    if (keyText(text, key) !== TOKEN_KEY) continue;
    const value = tokens[index + 1];
    if (value === undefined || value.kind === "newline") continue;
    // A comment right after `=` hides nothing; skip it without consuming.
    if (value.kind === "comment") continue;
    const start = value.start;
    const end = value.kind === "string" ? value.end : lineEndOf(text, start);
    if (end <= start || start < copied) continue;
    output += text.slice(copied, start);
    output += placeholderFor(registry, text.slice(start, end));
    copied = end;
    redacted = true;
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
