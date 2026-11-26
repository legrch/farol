import { describe, expect, it } from "vitest";
import { chatGptPreSubmitRemedy } from "../../../src/ui/chatgpt-pre-submit-remedy";
import { fullCheckNotSent } from "./fullcheck";

describe("fullCheckNotSent", () => {
  it("explains a busy ChatGPT task", () => {
    expect(fullCheckNotSent("CHATGPT_TASK_IN_PROGRESS")).toContain(
      "another ChatGPT task or check is still running",
    );
  });
  it("explains unready prerequisites", () => {
    expect(fullCheckNotSent("CONNECTOR_APP_VERIFICATION_NOT_READY")).toContain(
      "tunnel, runtime or app prerequisites are not ready",
    );
  });
  it("appends the pre-submit remedy when one exists", () => {
    const code = "CONNECTION_CHECK_RUNTIME_NOT_RUNNING";
    expect(fullCheckNotSent(code)).toBe(
      `Full check was not sent. ${chatGptPreSubmitRemedy(code)}`,
    );
  });
  it("falls back to a generic retry message", () => {
    for (const code of [null, undefined, "SOMETHING_ELSE"])
      expect(fullCheckNotSent(code)).toBe(
        "Full check was not sent. You can try again.",
      );
  });
});
