import {
  captureChatModelSnapshot,
  type CompiledChatModelProfile,
} from "./go-chat-model-snapshot.ts";

export function chatWorkerInitialUrl(
  homeUrl: string,
  conversationId?: string,
): string {
  if (conversationId === undefined) return homeUrl;
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(conversationId))
    throw new Error("CHAT_WORKER_CONVERSATION_INVALID");
  const url = new URL(homeUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/c/${conversationId}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

// Explicit synthetic adapter profile for the existing controlled behavioral
// site. It is never a production model default or evidence of current provider
// compatibility. The production catalogue remains closed until qualified.
const controlled: CompiledChatModelProfile = {
  metadata: {
    id: "controlled-fixture-v1",
    executor: "browser",
    runtimeModel: "controlled-model",
    modelId: "controlled-model",
    defaultEffort: "low",
    mode: "",
    efforts: [{ requested: "low", resolved: "low" }],
    required: { model: true, effort: true, mode: false, connector: false },
  },
  controls: {
    model: [{ value: "controlled-model", literal: "Test model" }],
    effort: [{ value: "low", literal: "Light" }],
    mode: [],
    connector: [],
  },
};
export function captureChatStartupProfile(
  input: Readonly<{
    environment: "dev" | "preview";
    e2e: boolean;
    origin: string | null;
    tasks: unknown;
  }>,
) {
  if (input.environment !== "dev" || !input.e2e || !input.origin) return null;
  const url = new URL(input.origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.origin !== input.origin
  )
    return null;
  return {
    snapshot: captureChatModelSnapshot(input.tasks, [controlled]),
    route: {
      publicOutputProfile: "message-anchors-v1" as const,
      accountObservationProfile: "provider-session-v1" as const,
      physicalContentProfile: "farol-controlled-settled-segments-v1" as const,
    },
    origin: input.origin,
  };
}
