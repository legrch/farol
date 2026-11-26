import { describe, expect, it } from "vitest";
import {
  automaticWriteResult,
  quitWriteResult,
  settledAutomaticPreference,
  settledQuitPreference,
} from "./preference";

const quitOn = {
  status: "confirmed",
  scope: "install-on-normal-quit",
  enabled: true,
} as const;

describe("install-on-quit write result", () => {
  it("accepts only an ACK that echoes the requested value", () => {
    expect(quitWriteResult(quitOn, true)).toEqual(quitOn);
    expect(quitWriteResult(quitOn, false)).toEqual({
      status: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
    });
  });

  it("keeps a well-formed refusal and rejects extra keys", () => {
    expect(
      quitWriteResult({ status: "refused", code: "UPDATE_X" }, true),
    ).toEqual({ status: "refused", code: "UPDATE_X" });
    expect(
      quitWriteResult(
        { status: "refused", code: "UPDATE_X", extra: 1 } as never,
        true,
      ),
    ).toEqual({
      status: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
    });
  });
});

describe("automatic write result", () => {
  it("flags a mismatched enabled value or scope as unknown", () => {
    const ok = { status: "confirmed", enabled: true } as const;
    expect(automaticWriteResult(ok, true, undefined)).toBe(ok);
    expect(automaticWriteResult(ok, false, undefined).status).toBe("unknown");
    expect(automaticWriteResult(ok, true, "download-and-install").status).toBe(
      "unknown",
    );
  });
});

describe("settled preferences", () => {
  it("fences refusals as blocked and unknown outcomes as unknown", () => {
    expect(settledQuitPreference(quitOn)).toBe(quitOn);
    expect(
      settledQuitPreference({ status: "refused", code: "UPDATE_X" }),
    ).toEqual({ status: "blocked", enabled: false, code: "UPDATE_X" });
    expect(
      settledAutomaticPreference({ status: "unknown", code: "UPDATE_X" }),
    ).toEqual({ status: "unknown", enabled: false, code: "UPDATE_X" });
  });
});
