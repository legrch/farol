import { describe, expect, it } from "vitest";
import { CHATGPT_HOME } from "../../../src/apps/desktop/chatgpt-page-policy";
import { selectChatGptHome } from "./home";

describe("ChatGPT home", () => {
  it("uses the real home outside the E2E lane, even with a fixture URL set", () => {
    expect(selectChatGptHome({})).toEqual({
      url: CHATGPT_HOME,
      e2eOrigin: null,
    });
    expect(
      selectChatGptHome({ FAROL_E2E_CHATGPT_URL: "http://127.0.0.1:9/x" }),
    ).toEqual({ url: CHATGPT_HOME, e2eOrigin: null });
  });

  it("points the E2E lane at a loopback fixture", () => {
    expect(
      selectChatGptHome({
        FAROL_E2E: "1",
        FAROL_E2E_CHATGPT_URL: "http://127.0.0.1:4310/start",
      }),
    ).toEqual({
      url: "http://127.0.0.1:4310/start",
      e2eOrigin: "http://127.0.0.1:4310",
    });
  });

  it.each([
    "https://127.0.0.1:4310/",
    "http://localhost:4310/",
    "http://chatgpt.com/",
  ])("refuses the E2E fixture URL %s", (url) => {
    expect(() =>
      selectChatGptHome({ FAROL_E2E: "1", FAROL_E2E_CHATGPT_URL: url }),
    ).toThrow("CHATGPT_E2E_URL_INVALID");
  });
});
