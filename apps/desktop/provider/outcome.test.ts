import { describe, expect, it } from "vitest";
import {
  admissionCode,
  continuationCode,
  goRefusal,
  toolCatalogueCode,
} from "./outcome";

describe("provider outcome codes", () => {
  it("passes a tool code through and collapses anything else", () => {
    expect(toolCatalogueCode(new Error("CODEX_TOOL_CALL_INVALID"))).toBe(
      "CODEX_TOOL_CALL_INVALID",
    );
    expect(toolCatalogueCode(new Error("boom"))).toBe(
      "FAROL_TOOL_CATALOGUE_INVALID",
    );
    expect(toolCatalogueCode("CODEX_TOOL_X")).toBe(
      "FAROL_TOOL_CATALOGUE_INVALID",
    );
  });

  it("passes a continuation code through and collapses anything else", () => {
    expect(continuationCode("FAROL_CONTINUATION_CALL_INVALID")).toBe(
      "FAROL_CONTINUATION_CALL_INVALID",
    );
    expect(continuationCode("FAROL_TURN_STATE_INVALID")).toBe(
      "FAROL_CONTINUATION_INVALID",
    );
  });

  it("maps a Go refusal to 422 for unsupported or unavailable, else 409", () => {
    expect(goRefusal(new Error("FAROL_INPUT_UNSUPPORTED"))).toEqual({
      code: "FAROL_INPUT_UNSUPPORTED",
      status: 422,
    });
    expect(goRefusal(new Error("FAROL_GO_UNAVAILABLE"))).toEqual({
      code: "FAROL_GO_UNAVAILABLE",
      status: 422,
    });
    expect(goRefusal(new Error("FAROL_TURN_BUSY"))).toEqual({
      code: "FAROL_TURN_BUSY",
      status: 409,
    });
    expect(goRefusal(new Error("free text"))).toEqual({
      code: "FAROL_GO_OUTCOME_UNKNOWN",
      status: 409,
    });
  });

  it("reports an unrecognized admission as state unknown, never replayed", () => {
    expect(admissionCode("replayed")).toBe("FAROL_TURN_ALREADY_SUBMITTED");
    expect(admissionCode("conflict")).toBe("FAROL_TURN_INTENT_CONFLICT");
    expect(admissionCode("unknown")).toBe("FAROL_TURN_STATE_UNKNOWN");
    expect(admissionCode("anything")).toBe("FAROL_TURN_STATE_UNKNOWN");
  });
});
