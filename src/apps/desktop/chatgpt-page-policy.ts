export const CHATGPT_PARTITION = "persist:farol-app-chatgpt";
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

export function canonicalChatGptConversationUrl(
  value: string,
  e2eOrigin: string | null,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") return null;
  const fixtureOrigin = normalizedOrigin(e2eOrigin);
  const productionConversation =
    parsed.protocol === "https:" &&
    parsed.origin === "https://chatgpt.com" &&
    /^\/c\/[A-Za-z0-9-]{8,128}\/?$/u.test(parsed.pathname);
  const fixtureConversation =
    fixtureOrigin !== null &&
    parsed.origin === fixtureOrigin &&
    /^\/chatgpt\/c\/[A-Za-z0-9-]{8,128}\/?$/u.test(parsed.pathname);
  if (!productionConversation && !fixtureConversation) return null;
  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  return `${parsed.origin}${pathname}`;
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
  // A guest composer is not authenticated while a visible sign-in barrier exists.
  if (signals.signInVisible) {
    return { state: "signed_out", code: "CHATGPT_SIGN_IN_REQUIRED" };
  }
  if (signals.composerVisible) {
    return { state: "authenticated", code: null };
  }
  return { state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" };
}
