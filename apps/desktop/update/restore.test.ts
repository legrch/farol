import { describe, expect, it } from "vitest";
import { restoreEntryRefusal, restoreSourceMismatch } from "./restore";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };

describe("restoreEntryRefusal", () => {
  const open = {
    supervised: false,
    goCoreMissing: false,
    releaseUnconfirmed: false,
    admissionHeld: false,
    action: "rollback" as const,
    operation,
    requiresStateRecovery: () => false,
  };
  it("admits an unobstructed request", () => {
    expect(restoreEntryRefusal(open)).toBeNull();
    expect(restoreEntryRefusal({ ...open, operation: null })).toBeNull();
  });
  it("refuses in the documented order", () => {
    const all = {
      ...open,
      supervised: true,
      goCoreMissing: true,
      releaseUnconfirmed: true,
      admissionHeld: true,
      requiresStateRecovery: () => true,
    };
    expect(restoreEntryRefusal(all)?.code).toBe(
      "UPDATE_SUPERVISED_RESTORE_UNQUALIFIED",
    );
    expect(restoreEntryRefusal({ ...all, supervised: false })?.code).toBe(
      "UPDATE_HELPER_GO_CORE_REQUIRED",
    );
    expect(
      restoreEntryRefusal({ ...all, supervised: false, goCoreMissing: false })
        ?.code,
    ).toBe("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
    expect(
      restoreEntryRefusal({
        ...all,
        supervised: false,
        goCoreMissing: false,
        releaseUnconfirmed: false,
      }),
    ).toEqual({ status: "unknown", code: "UPDATE_RESTORE_OUTCOME_UNKNOWN" });
  });
  it("blocks a rollback whose predecessor state is unrecoverable, only for rollback", () => {
    const needs = { ...open, requiresStateRecovery: () => true };
    expect(restoreEntryRefusal(needs)).toEqual({
      status: "blocked",
      code: "UPDATE_PREDECESSOR_STATE_UNQUALIFIED",
    });
    expect(restoreEntryRefusal({ ...needs, action: "recover" })).toBeNull();
    expect(restoreEntryRefusal({ ...needs, operation: undefined })).toBeNull();
  });
  it("asks about the operation's own source and target versions", () => {
    const asked: string[] = [];
    restoreEntryRefusal({
      ...open,
      requiresStateRecovery: (from, to) => {
        asked.push(from, to);
        return false;
      },
    });
    expect(asked).toEqual(["1.2.3", "1.2.4"]);
  });
});

describe("restoreSourceMismatch", () => {
  it("accepts either side of the pair while this build runs", () => {
    const running = { buildId: d("b") };
    expect(restoreSourceMismatch(source, operation, running)).toBe(false);
    expect(
      restoreSourceMismatch(target, operation, { buildId: target.buildId }),
    ).toBe(false);
  });
  it("refuses another running build or a build outside the pair", () => {
    expect(
      restoreSourceMismatch(source, operation, { buildId: target.buildId }),
    ).toBe(true);
    const other = { ...source, digest: d("9") };
    expect(restoreSourceMismatch(other, operation, { buildId: d("b") })).toBe(
      true,
    );
  });
});
