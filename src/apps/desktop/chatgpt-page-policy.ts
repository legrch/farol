export const CHATGPT_PARTITION = "persist:farol-next-chatgpt";
export const CHATGPT_HOME = "https://chatgpt.com/";

const exactAllowedHosts = new Set([
  "accounts.google.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "login.microsoftonline.com",
]);

function normalizedOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function allowedChatGptPageUrl(
  value: string,
  e2eOrigin: string | null,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const fixtureOrigin = normalizedOrigin(e2eOrigin);
  if (fixtureOrigin && parsed.origin === fixtureOrigin) return true;
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com") ||
    exactAllowedHosts.has(host)
  );
}

export type ChatGptPageSignals = Readonly<{
  load: "failed" | "loaded";
  composerVisible: boolean;
  signInVisible: boolean;
}>;

export type ChatGptPageObservation = Readonly<{
  state: "authenticated" | "signed_out" | "unreachable" | "unsupported";
  code:
    | "CHATGPT_PAGE_UNREACHABLE"
    | "CHATGPT_SIGN_IN_REQUIRED"
    | "CHATGPT_UI_UNRECOGNIZED"
    | null;
}>;

export function classifyChatGptPage(
  signals: ChatGptPageSignals,
): ChatGptPageObservation {
  if (signals.load === "failed") {
    return { state: "unreachable", code: "CHATGPT_PAGE_UNREACHABLE" };
  }
  if (signals.composerVisible) {
    return { state: "authenticated", code: null };
  }
  if (signals.signInVisible) {
    return { state: "signed_out", code: "CHATGPT_SIGN_IN_REQUIRED" };
  }
  return { state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" };
}
