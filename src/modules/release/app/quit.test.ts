import { describe, expect, it } from "vitest";
import {
  classifyQuitHandoff,
  quitConsentReceipt,
  quitRequestValid,
  quitViewReceipt,
} from "./quit";

const off = {
  status: "confirmed",
  scope: "install-on-normal-quit",
  enabled: false,
} as const;
const on = { ...off, enabled: true } as const;

describe("quit request", () => {
  it("accepts only the ordinary kind with a safe deadline", () => {
    expect(quitRequestValid({ kind: "ordinary-quit", deadlineAt: 1 })).toBe(
      true,
    );
    expect(quitRequestValid({ kind: "ordinary-quit", deadlineAt: -1 })).toBe(
      false,
    );
    expect(quitRequestValid({ kind: "ordinary-quit", deadlineAt: 1.5 })).toBe(
      false,
    );
    expect(
      quitRequestValid({ kind: "ordinary-quit", deadlineAt: 1, extra: 1 }),
    ).toBe(false);
    expect(quitRequestValid(null)).toBe(false);
  });
});

describe("quit consent", () => {
  const auto = { status: "confirmed", enabled: false } as const;

  it("lets an unconfirmed automatic choice speak first when it is loaded", () => {
    const blocked = {
      status: "blocked",
      enabled: false,
      code: "UPDATE_X",
    } as const;
    expect(quitConsentReceipt(blocked, true, on)).toEqual({
      status: "blocked",
      code: "UPDATE_X",
    });
    expect(quitConsentReceipt(blocked, false, on)).toBeNull();
  });

  it("prefers the unified scope over the legacy Quit choice", () => {
    expect(
      quitConsentReceipt(
        { status: "confirmed", enabled: true, scope: "download-and-install" },
        true,
        off,
      ),
    ).toBeNull();
    expect(quitConsentReceipt(auto, true, off)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_NOT_OPTED_IN",
    });
  });
});

describe("quit view receipt", () => {
  it("classifies an unresolved failure as unknown, not blocked", () => {
    expect(
      quitViewReceipt(
        {
          phase: "failed",
          code: "UPDATE_HANDOFF_UNKNOWN",
          recoveryRequired: true,
        },
        true,
      ),
    ).toEqual({ status: "unknown", code: "UPDATE_HANDOFF_UNKNOWN" });
    expect(
      quitViewReceipt(
        { phase: "failed", code: "UPDATE_X", recoveryRequired: true },
        true,
      ),
    ).toEqual({ status: "blocked", code: "UPDATE_X" });
  });

  it("skips without a retained package and passes a clean Ready", () => {
    const ready = {
      phase: "ready",
      version: "1.0.0",
      deferred: false,
      blockedBy: null,
    } as const;
    expect(quitViewReceipt(ready, false)).toEqual({
      status: "skipped",
      code: "UPDATE_PACKAGE_NOT_READY",
    });
    expect(quitViewReceipt(ready, true)).toBeNull();
    expect(
      quitViewReceipt({ ...ready, blockedBy: "UPDATE_BROWSER_OPEN" }, true),
    ).toEqual({ status: "blocked", code: "UPDATE_BROWSER_OPEN" });
  });
});

describe("quit handoff", () => {
  it("understands only the exact accepted shape", () => {
    expect(classifyQuitHandoff({ status: "accepted" })).toEqual({
      kind: "accepted",
    });
    expect(
      classifyQuitHandoff({ status: "accepted", code: "UPDATE_X" }),
    ).toBeNull();
    expect(classifyQuitHandoff(undefined)).toBeNull();
  });

  it("rejects a refusal with a malformed code", () => {
    expect(
      classifyQuitHandoff({ status: "unknown", code: "UPDATE_X" }),
    ).toEqual({ kind: "refused", status: "unknown", code: "UPDATE_X" });
    expect(classifyQuitHandoff({ status: "blocked", code: "bad" })).toBeNull();
  });
});
