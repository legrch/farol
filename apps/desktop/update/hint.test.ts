import { describe, expect, it } from "vitest";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import {
  parseRelaunchHint,
  relaunchExpected,
  relaunchIdentityMismatch,
  relaunchPairMismatch,
  relaunchPhaseInvalid,
  relaunchReceiptMismatch,
  updateIneligible,
} from "./hint";
import { RELAUNCH_ARGUMENT } from "./record";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };
const hintJson = {
  operationId: operation.operationId,
  action: "apply",
  phase: "completed",
  helper: { pid: 4242, processStart: "Mon Jan  1 00:00:00 2026" },
  buildId: d("d"),
};
const argument = (value: unknown) =>
  `${RELAUNCH_ARGUMENT}=${JSON.stringify(value)}`;
const hint = parseRelaunchHint([argument(hintJson)])!;
const invalid = "UPDATE_RELAUNCH_HINT_INVALID";

describe("parseRelaunchHint", () => {
  it("returns null when no hint is present", () => {
    expect(parseRelaunchHint([])).toBeNull();
    expect(parseRelaunchHint(["--other", "x"])).toBeNull();
  });
  it("parses exactly one well-formed hint", () => {
    expect(hint).toMatchObject({ action: "apply", phase: "completed" });
  });
  it("refuses a repeated, bare, oversized or malformed hint", () => {
    expect(() =>
      parseRelaunchHint([argument(hintJson), argument(hintJson)]),
    ).toThrow(invalid);
    expect(() => parseRelaunchHint([RELAUNCH_ARGUMENT])).toThrow(invalid);
    expect(() =>
      parseRelaunchHint([`${RELAUNCH_ARGUMENT}=${"x".repeat(2049)}`]),
    ).toThrow(invalid);
    expect(() => parseRelaunchHint([`${RELAUNCH_ARGUMENT}={`])).toThrow(
      invalid,
    );
    expect(() =>
      parseRelaunchHint([argument({ ...hintJson, extra: 1 })]),
    ).toThrow(invalid);
  });
});

describe("updateIneligible", () => {
  const eligible = {
    updateChannel: "github-stable" as const,
    buildVersion: "7",
    sourceDirty: false,
  };
  it("accepts a clean build on an update channel", () => {
    expect(updateIneligible(eligible)).toBe(false);
    expect(
      updateIneligible({ ...eligible, updateChannel: "github-owner-beta" }),
    ).toBe(false);
  });
  it("refuses a preview, an unnumbered or a dirty build", () => {
    expect(
      updateIneligible({ ...eligible, updateChannel: "local-preview-only" }),
    ).toBe(true);
    const { buildVersion: _omitted, ...bare } = eligible;
    expect(updateIneligible(bare)).toBe(true);
    expect(updateIneligible({ ...eligible, sourceDirty: true })).toBe(true);
  });
});

describe("relaunchIdentityMismatch", () => {
  const base = {
    updateChannel: "github-stable",
    buildVersion: "7",
    sourceDirty: false,
    buildId: d("d"),
  } as BuildIdentity;
  const input = {
    hint,
    build: base,
    userData: "/p",
    profile: "/p",
    directory: "/app",
    expectedDirectory: "/app",
  };
  it("refuses a different profile, directory or build id", () => {
    expect(relaunchIdentityMismatch({ ...input, userData: "/q" })).toBe(true);
    expect(relaunchIdentityMismatch({ ...input, directory: "/x" })).toBe(true);
    expect(
      relaunchIdentityMismatch({
        ...input,
        build: { ...base, buildId: d("e") },
      }),
    ).toBe(true);
  });
  it("refuses an ineligible build before it digests the identity", () => {
    expect(
      relaunchIdentityMismatch({
        ...input,
        build: { ...base, sourceDirty: true },
      }),
    ).toBe(true);
  });
});

describe("relaunchPhaseInvalid", () => {
  it("pairs each action with the phases it can leave", () => {
    expect(relaunchPhaseInvalid(hint)).toBe(false);
    expect(relaunchPhaseInvalid({ ...hint, phase: "rollback_completed" })).toBe(
      false,
    );
    expect(relaunchPhaseInvalid({ ...hint, phase: "cancel_completed" })).toBe(
      true,
    );
    expect(
      relaunchPhaseInvalid({
        ...hint,
        action: "rollback",
        phase: "completed",
      }),
    ).toBe(true);
    expect(
      relaunchPhaseInvalid({
        ...hint,
        action: "recover",
        phase: "cancel_completed",
      }),
    ).toBe(false);
  });
});

describe("relaunchExpected", () => {
  it("expects the target after completion and the source otherwise", () => {
    expect(relaunchExpected("completed", operation)).toBe(target);
    expect(relaunchExpected("rollback_completed", operation)).toBe(source);
    expect(relaunchExpected("cancel_completed", operation)).toBe(source);
  });
});

describe("relaunchReceiptMismatch", () => {
  const retained = {
    schema: "farol.ready-update/1" as const,
    handle: "/h",
    manifest: {},
    operation,
    helper: { pid: 4242, processStart: "Mon Jan  1 00:00:00 2026" },
  };
  const check = (
    receipt: Parameters<typeof relaunchReceiptMismatch>[0]["receipt"],
    over: Partial<Parameters<typeof relaunchReceiptMismatch>[0]> = {},
  ) => relaunchReceiptMismatch({ receipt, hint, pinned: undefined, ...over });

  it("accepts the receipt the hint's helper was dispatched with", () => {
    expect(check(retained)).toBe(false);
    expect(check(retained, { pinned: operation })).toBe(false);
  });
  it("refuses another operation, helper or pinned pair", () => {
    expect(check({ ...retained, operation: null })).toBe(true);
    expect(
      check({
        ...retained,
        operation: { ...operation, operationId: "2".repeat(32) },
      }),
    ).toBe(true);
    expect(check({ ...retained, helper: null })).toBe(true);
    expect(
      check({ ...retained, helper: { pid: 1111, processStart: "x" } }),
    ).toBe(true);
    expect(
      check(retained, {
        pinned: { ...operation, target: { ...target, version: "9.9.9" } },
      }),
    ).toBe(true);
  });
  it("needs a matching restore record for a rollback and refuses one never started", () => {
    const rollback = { ...hint, action: "rollback" as const };
    const restore = {
      schema: "farol.update-restore-intent/1" as const,
      action: "rollback" as const,
      operation,
      priorPhase: "completed" as const,
      helper: retained.helper,
    };
    const run = (receipt: Parameters<typeof check>[0]) =>
      relaunchReceiptMismatch({ receipt, hint: rollback, pinned: undefined });
    expect(run(restore)).toBe(false);
    expect(run(retained)).toBe(true);
    expect(run({ ...restore, action: "recover" })).toBe(true);
    expect(run({ ...restore, notStartedAt: source })).toBe(true);
  });
});

describe("relaunchPairMismatch", () => {
  const running = { buildId: target.buildId, version: target.version };
  it("accepts the expected running build of a distinct pair", () => {
    expect(relaunchPairMismatch(target, running, operation)).toBe(false);
  });
  it("refuses another build or a degenerate pair", () => {
    expect(relaunchPairMismatch(source, running, operation)).toBe(true);
    expect(
      relaunchPairMismatch({ ...target, version: "9.9.9" }, running, operation),
    ).toBe(true);
    expect(
      relaunchPairMismatch(target, running, {
        ...operation,
        source: { ...source, buildId: target.buildId },
      }),
    ).toBe(true);
    expect(
      relaunchPairMismatch(target, running, {
        ...operation,
        source: { ...source, digest: target.digest },
      }),
    ).toBe(true);
  });
});
