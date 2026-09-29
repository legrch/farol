import { describe, expect, it } from "vitest";
import { chatGptPreSubmitRemedy } from "../../src/ui/chatgpt-pre-submit-remedy";

describe("ChatGPT pre-submit remedies for the owner-selected app", () => {
  it.each([
    "CHATGPT_APP_SELECTION_MISSING",
    "CHATGPT_APP_SELECTION_AMBIGUOUS",
    "CHATGPT_APP_SELECTION_CONFLICT",
    "CHATGPT_APP_SELECTION_LOST",
  ])("does not redirect %s to a hard-coded Dev app", (code) => {
    const message = chatGptPreSubmitRemedy(code);
    expect(message).toContain("app chosen in Setup");
    expect(message).not.toContain("Farol Dev");
    expect(message).not.toContain("@Farol");
    expect(message).toMatch(/before send|Nothing was sent/u);
  });

  it("preserves the draft and does not suggest an automatic app switch", () => {
    expect(chatGptPreSubmitRemedy("CHATGPT_COMPOSER_DRAFT_PRESENT")).toContain(
      "Your draft was preserved",
    );
    expect(chatGptPreSubmitRemedy("CHATGPT_APP_SELECTION_CONFLICT")).toContain(
      "Farol did not switch apps automatically",
    );
  });

  it.each([
    null,
    "CHATGPT_TASK_OUTCOME_UNKNOWN",
    "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    "CHATGPT_UNKNOWN_ERROR",
  ])("does not give a pre-submit retry remedy for %s", (code) => {
    expect(chatGptPreSubmitRemedy(code)).toBeNull();
  });
});
