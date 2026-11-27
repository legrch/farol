// The refusal code a failed step is reported under. A code the step already
// carries in its own namespace passes through; anything else collapses to the
// step's generic code, so no free text reaches the host.

export function toolCatalogueCode(error: unknown): string {
  return error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
    ? error.message
    : "FAROL_TOOL_CATALOGUE_INVALID";
}

export function continuationCode(message: string): string {
  return /^FAROL_CONTINUATION_[A-Z_]+$/u.test(message)
    ? message
    : "FAROL_CONTINUATION_INVALID";
}

export function goRefusal(error: unknown): Readonly<{
  code: string;
  status: 409 | 422;
}> {
  const code =
    error instanceof Error && /^FAROL_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "FAROL_GO_OUTCOME_UNKNOWN";
  return {
    code,
    status:
      code.includes("UNSUPPORTED") || code.includes("UNAVAILABLE") ? 422 : 409,
  };
}

// A durable admission that did not admit: replayed, conflicting or unknown.
export function admissionCode(admission: string): string {
  return admission === "replayed"
    ? "FAROL_TURN_ALREADY_SUBMITTED"
    : admission === "conflict"
      ? "FAROL_TURN_INTENT_CONFLICT"
      : "FAROL_TURN_STATE_UNKNOWN";
}
