import { describe, expect, it } from "vitest";
import {
  preparationFailureView,
  readyPreservedByRefusal,
  recoveredView,
  restoreTargetVersion,
} from "./view";

describe("preparation failure", () => {
  it("preserves Ready only for a known refusal", () => {
    expect(readyPreservedByRefusal({ code: "UPDATE_X" }, true)).toBe(true);
    expect(readyPreservedByRefusal({ code: "UPDATE_X" }, false)).toBe(false);
    expect(
      readyPreservedByRefusal(
        { code: "UPDATE_X", recoveryRequired: true },
        true,
      ),
    ).toBe(false);
    expect(
      readyPreservedByRefusal({ code: "UPDATE_STAGE_UNKNOWN" }, true),
    ).toBe(false);
  });

  it("requires recovery after a replacement and keeps rollback otherwise", () => {
    expect(preparationFailureView({ code: "C" }, true, "0.9.0")).toEqual({
      phase: "failed",
      code: "C",
      recoveryRequired: true,
    });
    expect(preparationFailureView({ code: "C" }, false, "0.9.0")).toEqual({
      phase: "failed",
      code: "C",
      recoveryRequired: false,
      rollbackVersion: "0.9.0",
    });
    expect(
      preparationFailureView(
        { code: "C", recoveryRequired: true },
        false,
        "0.9.0",
      ),
    ).toEqual({ phase: "failed", code: "C", recoveryRequired: true });
  });
});

describe("recovered view", () => {
  const update = { manifest: { version: "1.0.0" }, notes: "n" };

  it("follows failure, recovery, ready, rollback in that order", () => {
    expect(recoveredView({ ok: false, code: "C" })).toEqual({
      phase: "failed",
      code: "C",
      recoveryRequired: true,
    });
    expect(
      recoveredView({
        ok: true,
        update,
        recoveryVersion: "1.0.1",
        rollbackVersion: "0.9.0",
      }),
    ).toEqual({ phase: "recovery", version: "1.0.1", blockedBy: null });
    expect(
      recoveredView({ ok: true, update, rollbackVersion: "0.9.0" }),
    ).toEqual({
      phase: "ready",
      version: "1.0.0",
      deferred: true,
      blockedBy: null,
      notes: "n",
    });
    expect(
      recoveredView({ ok: true, update: null, rollbackVersion: "0.9.0" }),
    ).toEqual({
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.9.0",
    });
    expect(recoveredView({ ok: true, update: null })).toBeNull();
  });
});

describe("restore target", () => {
  it("offers recover from recovery and rollback from a known state", () => {
    const recovery = {
      phase: "recovery",
      version: "1.0.1",
      blockedBy: null,
    } as const;
    expect(restoreTargetVersion(recovery, "recover")).toBe("1.0.1");
    expect(restoreTargetVersion(recovery, "rollback")).toBeUndefined();
    expect(
      restoreTargetVersion(
        { phase: "idle", checkedAt: 1, rollbackVersion: "0.9.0" },
        "rollback",
      ),
    ).toBe("0.9.0");
    expect(
      restoreTargetVersion(
        {
          phase: "failed",
          code: "C",
          recoveryRequired: true,
          rollbackVersion: "0.9.0",
        },
        "rollback",
      ),
    ).toBeUndefined();
  });
});
