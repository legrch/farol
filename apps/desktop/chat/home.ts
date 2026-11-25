import { CHATGPT_HOME } from "../../../src/apps/desktop/chatgpt-page-policy";

// Where the embedded ChatGPT page starts. Ordinary launches use the real home;
// only the E2E lane may point it at a loopback fixture, and only over plain
// http on 127.0.0.1. Anything else in that lane refuses startup rather than
// letting a test navigate the owner's browser profile somewhere unexpected.

export type ChatGptHomeEnvironment = Readonly<{
  FAROL_E2E?: string | undefined;
  FAROL_E2E_CHATGPT_URL?: string | undefined;
}>;

export function selectChatGptHome(env: ChatGptHomeEnvironment): Readonly<{
  url: string;
  e2eOrigin: string | null;
}> {
  const e2eUrl = env.FAROL_E2E === "1" ? env.FAROL_E2E_CHATGPT_URL : undefined;
  if (!e2eUrl) return { url: CHATGPT_HOME, e2eOrigin: null };
  const parsed = new URL(e2eUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("CHATGPT_E2E_URL_INVALID");
  }
  return { url: parsed.href, e2eOrigin: parsed.origin };
}
