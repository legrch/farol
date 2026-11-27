import { describe, expect, it } from "vitest";
import {
  parseSummaryOutput,
  withoutUnverifiedAttachmentAvailability,
} from "./parse";

describe("summary output parsing", () => {
  it("parses one JSON value", () => {
    expect(parseSummaryOutput('{"goal":"one"}')).toEqual({
      ok: true,
      candidate: { goal: "one" },
    });
    expect(parseSummaryOutput("null")).toEqual({ ok: true, candidate: null });
  });

  it("refuses text that is not JSON", () => {
    for (const text of [
      "",
      "goal",
      "{",
      '```json\n{"goal":"one"}\n```',
      '{"a":1} tail',
    ]) {
      expect(parseSummaryOutput(text)).toEqual({ ok: false });
    }
  });

  it("treats a missing output as the empty string", () => {
    expect(parseSummaryOutput(undefined)).toEqual({ ok: false });
    expect(parseSummaryOutput(null)).toEqual({ ok: false });
  });
});

describe("attachment availability", () => {
  it("marks every claimed attachment unavailable and keeps the rest", () => {
    const content = {
      goal: "one",
      attachmentRefs: [
        { reference: "a", availability: "available" },
        { reference: "b", availability: "unavailable" },
      ],
    };
    const cleaned = withoutUnverifiedAttachmentAvailability(content);
    expect(cleaned).toEqual({
      goal: "one",
      attachmentRefs: [
        { reference: "a", availability: "unavailable" },
        { reference: "b", availability: "unavailable" },
      ],
    });
    expect(content.attachmentRefs[0]?.availability).toBe("available");
  });

  it("handles an empty attachment list", () => {
    expect(
      withoutUnverifiedAttachmentAvailability({ attachmentRefs: [] }),
    ).toEqual({ attachmentRefs: [] });
  });
});
