import { describe, expect, it } from "vitest";
import {
  captureChatStartupProfile,
  chatWorkerInitialUrl,
} from "../../apps/desktop/go-chat-startup-profile.ts";
const tasks = {
  defaultHarness: "browser",
  harnesses: {
    browser: {
      defaultModel: "chatgpt",
      models: { chatgpt: { model: "controlled-model", defaultEffort: "low" } },
    },
  },
};
const input = {
  environment: "dev" as const,
  e2e: true,
  origin: "http://127.0.0.1:34567",
  tasks,
};
describe("explicit normal-startup controlled profile", () => {
  it("preserves the supported base path when reopening an exact owned worker target", () => {
    expect(chatWorkerInitialUrl("https://chatgpt.com/", "same-id")).toBe(
      "https://chatgpt.com/c/same-id",
    );
    expect(
      chatWorkerInitialUrl("http://127.0.0.1:34567/chatgpt", "same-id"),
    ).toBe("http://127.0.0.1:34567/chatgpt/c/same-id");
    expect(chatWorkerInitialUrl("http://127.0.0.1:34567/chatgpt/")).toBe(
      "http://127.0.0.1:34567/chatgpt/",
    );
    expect(() =>
      chatWorkerInitialUrl("https://chatgpt.com/", "../replacement"),
    ).toThrow("CHAT_WORKER_CONVERSATION_INVALID");
  });
  it("wires model, account, public output and synthetic content together from existing settings", () => {
    const p = captureChatStartupProfile(input)!;
    expect(p.snapshot.translations).toHaveLength(1);
    expect(p.snapshot.translations[0]!.model).toEqual([
      { value: "controlled-model", literal: "Test model" },
    ]);
    expect(p.route).toEqual({
      publicOutputProfile: "message-anchors-v1",
      accountObservationProfile: "provider-session-v1",
      physicalContentProfile: "farol-controlled-settled-segments-v1",
    });
  });
  it.each([
    { environment: "preview" as const },
    { environment: "owner-preview" as const },
    { e2e: false },
    { origin: null },
    { origin: "https://chatgpt.com" },
    { origin: "http://localhost:34567" },
    { origin: "http://127.0.0.1:34567/path" },
  ])(
    "does not expose fixture profiles outside exact Dev loopback: %j",
    (patch) => {
      expect(captureChatStartupProfile({ ...input, ...patch })).toBeNull();
    },
  );
  it("never invents missing model configuration", () => {
    expect(() =>
      captureChatStartupProfile({ ...input, tasks: undefined }),
    ).toThrow();
  });
});
