// Redaction of bearer-token literals from anything the owner is shown.

/** What the preview shows in place of a bearer-token literal. */
export const FAROL_MODEL_TOKEN_PLACEHOLDER = "<redacted: Farol Model token>";

const BEARER_TOKEN_LINE =
  /^([-+ ]?\s*experimental_bearer_token\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/gmu;

export function redactBearerTokenLiterals(
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
