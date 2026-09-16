import { describe, expect, it } from "vitest";
import {
  CHATGPT_PARTITION,
  allowedChatGptPageUrl,
  classifyChatGptPage,
} from "../../src/apps/desktop/chatgpt-page-policy";

describe("Farol Next ChatGPT page policy", () => {
  it("owns a partition distinct from both preview tasks and Legacy", () => {
    expect(CHATGPT_PARTITION).toBe("persist:farol-next-chatgpt");
    expect(CHATGPT_PARTITION).not.toBe("persist:farol-next-preview");
    expect(CHATGPT_PARTITION).not.toBe("persist:farol-chatgpt");
  });

  it("allows only the supported HTTPS sign-in navigation set", () => {
    expect(allowedChatGptPageUrl("https://chatgpt.com/", null)).toBe(true);
    expect(
      allowedChatGptPageUrl("https://accounts.openai.com/login", null),
    ).toBe(true);
    expect(
      allowedChatGptPageUrl("https://accounts.google.com/o/oauth2/auth", null),
    ).toBe(true);
    expect(
      allowedChatGptPageUrl("https://login.microsoftonline.com/common", null),
    ).toBe(true);
    expect(allowedChatGptPageUrl("http://chatgpt.com/", null)).toBe(false);
    expect(allowedChatGptPageUrl("https://chatgpt.com.evil.test/", null)).toBe(
      false,
    );
    expect(allowedChatGptPageUrl("file:///tmp/session", null)).toBe(false);
    expect(allowedChatGptPageUrl("javascript:alert(1)", null)).toBe(false);
  });

  it("admits only the exact loopback fixture origin in E2E", () => {
    const fixture = "http://127.0.0.1:43123";
    expect(
      allowedChatGptPageUrl("http://127.0.0.1:43123/chatgpt", fixture),
    ).toBe(true);
    expect(
      allowedChatGptPageUrl("http://127.0.0.1:43124/chatgpt", fixture),
    ).toBe(false);
    expect(
      allowedChatGptPageUrl("http://localhost:43123/chatgpt", fixture),
    ).toBe(false);
  });

  it("classifies only content-free readiness signals", () => {
    expect(
      classifyChatGptPage({
        load: "loaded",
        composerVisible: true,
        signInVisible: false,
      }),
    ).toEqual({ state: "authenticated", code: null });
    expect(
      classifyChatGptPage({
        load: "loaded",
        composerVisible: false,
        signInVisible: true,
      }),
    ).toEqual({ state: "signed_out", code: "CHATGPT_SIGN_IN_REQUIRED" });
    expect(
      classifyChatGptPage({
        load: "failed",
        composerVisible: false,
        signInVisible: false,
      }),
    ).toEqual({ state: "unreachable", code: "CHATGPT_PAGE_UNREACHABLE" });
    expect(
      classifyChatGptPage({
        load: "loaded",
        composerVisible: false,
        signInVisible: false,
      }),
    ).toEqual({ state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" });
  });
});
