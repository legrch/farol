import { describe, expect, it } from "vitest";
import {
  manifestExpected,
  operationSide,
  promotionAccepted,
  promotionExpected,
  repairAccepted,
  repairExpected,
  replacementRefused,
  retainedBuild,
  settledBuild,
  type RetainedRead,
} from "./receipt";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const op = { operationId: "1".repeat(32), source, target };

describe("startup build shapes", () => {
  it("maps retained and manifest identities to an accepted build", () => {
    expect(
      retainedBuild({
        artifactSha256: d("c"),
        version: "1.2.4",
        buildId: d("d"),
        buildVersion: "9",
      }),
    ).toEqual(target);
    expect(
      manifestExpected({
        artifactSha256: d("c"),
        version: "1.2.4",
        buildId: d("d"),
      }),
    ).toEqual(target);
  });

  it("finds the operation side the running build is", () => {
    expect(operationSide(op, source)).toBe(source);
    expect(operationSide(op, target)).toBe(target);
    expect(operationSide(op, { buildId: d("e"), version: "1.2.4" })).toBe(
      undefined,
    );
    expect(operationSide(op, { buildId: d("d"), version: "9.9.9" })).toBe(
      undefined,
    );
  });
});

describe("promotion receipt", () => {
  const receipt = {
    destination: "/Applications/Farol.app",
    receipt: "/Applications/Farol.app.receipt.json",
    activation: { userData: "/u" },
    sourceCommit: "e".repeat(40),
    sourceTreeDigest: d("f"),
    version: "1.2.4",
    artifactSha256: d("c"),
    verifiedDestinationSha256: d("c"),
  } as never;
  const context = {
    app: "/Applications/Farol.app",
    file: "/Applications/Farol.app.receipt.json",
    profile: "/u",
    build: {
      sourceCommit: "e".repeat(40),
      sourceTreeDigest: d("f"),
      version: "1.2.4",
    },
  };

  it("accepts a receipt bound to this build and slot", () => {
    expect(promotionAccepted(receipt, context)).toBe(true);
    expect(promotionExpected(receipt, d("d"))).toEqual(target);
  });

  it("refuses each mismatch", () => {
    for (const patch of [
      { app: "/x" },
      { file: "/x" },
      { profile: "/x" },
      { build: { ...context.build, sourceCommit: "0".repeat(40) } },
      { build: { ...context.build, sourceTreeDigest: d("0") } },
      { build: { ...context.build, version: "0.0.1" } },
    ])
      expect(promotionAccepted(receipt, { ...context, ...patch })).toBe(false);
    expect(
      promotionAccepted(
        { ...(receipt as object), artifactSha256: d("0") } as never,
        context,
      ),
    ).toBe(false);
  });
});

describe("closed repair receipt", () => {
  const receipt = {
    destination: "/Applications/Farol.app",
    userData: "/u",
    phase: "installed",
    source,
    target,
  } as never;
  const journal = { phase: "installed", receipt } as never;

  it("accepts the journal that carries the same receipt", () => {
    expect(
      repairAccepted(receipt, journal, "/Applications/Farol.app", "/u"),
    ).toBe(true);
    expect(repairExpected(receipt)).toBe(target);
    expect(
      repairExpected({ ...(receipt as object), phase: "rolled_back" } as never),
    ).toBe(source);
  });

  it("refuses a foreign slot, profile, phase or receipt", () => {
    expect(repairAccepted(receipt, journal, "/x", "/u")).toBe(false);
    expect(
      repairAccepted(receipt, journal, "/Applications/Farol.app", "/x"),
    ).toBe(false);
    expect(
      repairAccepted(
        receipt,
        { ...(journal as object), phase: "rolled_back" } as never,
        "/Applications/Farol.app",
        "/u",
      ),
    ).toBe(false);
    expect(
      repairAccepted(
        receipt,
        {
          phase: "installed",
          receipt: { ...(receipt as object), x: 1 },
        } as never,
        "/Applications/Farol.app",
        "/u",
      ),
    ).toBe(false);
  });
});

describe("manual replacement", () => {
  const ok: RetainedRead = {
    ok: true,
    value: {
      artifactSha256: d("c"),
      version: "1.2.4",
      buildId: d("d"),
      buildVersion: "5",
    },
  };
  const previous = (phase: string) =>
    ({ operation: op, phase, runningBuildId: d("d") }) as never;
  const input = (patch: object = {}) => ({
    previous: previous("completed"),
    parsed: ok,
    build: { version: "1.3.0", buildVersion: "6" },
    repair: null,
    repairJournal: null,
    ready: null,
    compareVersions: () => 1,
    retained: () => ok,
    ...patch,
  });

  it("settles the target after completion and the source after rollback", () => {
    expect(settledBuild(previous("completed"))).toBe(target);
    expect(settledBuild(previous("rolled_back"))).toBe(source);
    expect(settledBuild(previous("verified"))).toBeNull();
    expect(
      settledBuild({ phase: "completed", operation: null } as never),
    ).toBeNull();
  });

  it("admits a newer build over a settled receipt", () => {
    expect(replacementRefused(input())).toBe(false);
  });

  it("refuses each unsettled or stale shape", () => {
    expect(replacementRefused(input({ previous: previous("verified") }))).toBe(
      true,
    );
    expect(
      replacementRefused(
        input({
          previous: {
            ...(previous("completed") as object),
            runningBuildId: d("0"),
          },
        }),
      ),
    ).toBe(true);
    expect(replacementRefused(input({ parsed: { ok: false } }))).toBe(true);
    expect(replacementRefused(input({ compareVersions: () => 0 }))).toBe(true);
    expect(replacementRefused(input({ compareVersions: () => null }))).toBe(
      true,
    );
    expect(
      replacementRefused(
        input({ build: { version: "1.3.0", buildVersion: "5" } }),
      ),
    ).toBe(true);
    expect(replacementRefused(input({ repair: {} }))).toBe(true);
    expect(replacementRefused(input({ repairJournal: {} }))).toBe(true);
    expect(replacementRefused(input({ ready: { helper: {} } }))).toBe(true);
    expect(
      replacementRefused(input({ ready: {}, retained: () => ({ ok: false }) })),
    ).toBe(true);
    expect(replacementRefused(input({ ready: {} }))).toBe(false);
  });
});
