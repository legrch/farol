export const FAROL_MODEL_MAX_BODY_BYTES = 1024 * 1024;

/** The declared length alone already puts the body over the bound. */
export function declaredLengthExceeds(
  contentLength: string | string[] | undefined,
  maxBodyBytes: number,
): boolean {
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > maxBodyBytes;
}

export type TurnBodyParse =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "mismatch"; detail: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "ok"; parsed: object }>;

/** JSON, then the one served model; evaluated in exactly that order. */
export function parseTurnBody(raw: string, model: string): TurnBodyParse {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? undefined : JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { model?: unknown }).model !== model
  ) {
    return {
      kind: "mismatch",
      detail: {
        expected_model: model,
        message: `This Farol Model endpoint serves only model ${JSON.stringify(model)}; the Farol-managed selection in config.toml sets it.`,
      },
    };
  }
  return { kind: "ok", parsed };
}
