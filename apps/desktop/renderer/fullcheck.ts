import { chatGptPreSubmitRemedy } from "../../../src/ui/chatgpt-pre-submit-remedy";

// A refused Full check sent nothing, so the owner can simply run it again.
export function fullCheckNotSent(code: string | null | undefined): string {
  if (code === "CHATGPT_TASK_IN_PROGRESS")
    return "Full check was not sent: another ChatGPT task or check is still running. Try again when it finishes.";
  if (code === "CONNECTOR_APP_VERIFICATION_NOT_READY")
    return "Full check was not sent: tunnel, runtime or app prerequisites are not ready. Connected alone is not enough if the ChatGPT page or runtime is missing.";
  const remedy = chatGptPreSubmitRemedy(code ?? null);
  return remedy
    ? `Full check was not sent. ${remedy}`
    : "Full check was not sent. You can try again.";
}
