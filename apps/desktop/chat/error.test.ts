import { describe, expect, it } from "vitest";
import { notSubmittedCode, unknownAfterSendCode } from "./error";

describe("summary error classification", () => {
  it("keeps the code a failed-before-submit turn reported", () => {
    expect(notSubmittedCode("CHATGPT_PAGE_UNREACHABLE")).toBe(
      "CHATGPT_PAGE_UNREACHABLE",
    );
  });

  it("falls back to the generic not-submitted code", () => {
    expect(notSubmittedCode(undefined)).toBe("SUMMARY_NOT_SUBMITTED");
    expect(notSubmittedCode(null)).toBe("SUMMARY_NOT_SUBMITTED");
  });

  it("names a usage limit hit after the send", () => {
    expect(unknownAfterSendCode("CHATGPT_USAGE_LIMITED")).toBe(
      "SUMMARY_USAGE_LIMITED_AFTER_SEND",
    );
  });

  it("keeps every other unknown outcome unresolved", () => {
    for (const code of [undefined, null, "", "CHATGPT_PAGE_UNREACHABLE"]) {
      expect(unknownAfterSendCode(code)).toBe("SUMMARY_SUBMISSION_UNRESOLVED");
    }
  });
});
