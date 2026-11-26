import { record } from "./shape";

// What a Codex request may ask the provider to type into the task's ChatGPT
// conversation: the user messages of this turn only, behind any trusted
// context, within the prompt budget. The host's checkpoint marker is lent by
// the caller, so this reads nothing from the chat module.

export const MAX_PROMPT_CHARACTERS = 128 * 1_024;

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!record(part) || typeof part.text !== "string") return [];
    return [part.text];
  });
}

export function promptFromInput(
  input: string | readonly unknown[],
  trustedContext: string | null,
  checkpointPrefix: string,
): string | null {
  if (typeof input === "string") {
    const prompt = trustedContext ? `${trustedContext}\n\n${input}` : input;
    return prompt.length <= MAX_PROMPT_CHARACTERS ? prompt : null;
  }
  // The host resends its whole history with every turn, while the task's
  // ChatGPT conversation already holds everything a previous turn sent. Only
  // the user messages after the last item the conversation produced (an
  // answer, a tool call or a compaction) are this turn's own.
  let turnStart = input.length;
  while (turnStart > 0) {
    const item = input[turnStart - 1];
    if (!record(item) || item.type !== "message" || item.role !== "user") {
      break;
    }
    turnStart -= 1;
  }
  const messages = input.slice(turnStart).flatMap((item) => {
    if (!record(item) || item.type !== "message") return [];
    if (item.role !== "user") return [];
    const content = textFromContent(item.content);
    return content.some((text) => text.includes(checkpointPrefix))
      ? []
      : content;
  });
  const prompt = [trustedContext, ...messages]
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return prompt.length > 0 && prompt.length <= MAX_PROMPT_CHARACTERS
    ? prompt
    : null;
}
