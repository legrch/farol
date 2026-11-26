// How a summary turn that did not finish maps to a classified code. A turn
// that failed before the submit carries its own code; a turn whose outcome is
// unknown after the send stays unknown and is never offered for a retry.

export function notSubmittedCode(code: string | null | undefined): string {
  return code ?? "SUMMARY_NOT_SUBMITTED";
}

export function unknownAfterSendCode(
  code: string | null | undefined,
): "SUMMARY_USAGE_LIMITED_AFTER_SEND" | "SUMMARY_SUBMISSION_UNRESOLVED" {
  return code === "CHATGPT_USAGE_LIMITED"
    ? "SUMMARY_USAGE_LIMITED_AFTER_SEND"
    : "SUMMARY_SUBMISSION_UNRESOLVED";
}
