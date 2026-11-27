import { describe, expect, it } from "vitest";
import {
  manualReplacementApplies,
  promotionUnconfirmed,
  receiptTargetMismatch,
  repairIdentityMismatch,
  repairInstalledMismatch,
  repairPrevious,
  repairRollbackMismatch,
  repairUnresolved,
} from "./baseline";
import { ClosedRepairJournal, ClosedRepairReceipt } from "./record";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };
const slot = "/Applications/Farol.app";
const userData = "/Users/someone/Library/Application Support/farol";

const repair = ClosedRepairReceipt.parse({
  schema: "farol.closed-repair/1",
  operationId: "2".repeat(32),
  phase: "installed",
  destination: slot,
  userData,
  source,
  target,
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: d("e"),
  sourceDirty: false,
  previous: repairPreviousPath(),
  quarantine: `${userData}/installed-updates-quarantine-${"2".repeat(32)}`,
  quarantined: false,
  quitDigest: d("f"),
});
function repairPreviousPath(): string {
  return repairPrevious(slot, "2".repeat(32));
}
const journalRaw = {
  schema: "farol.closed-repair-journal/1",
  phase: "installed",
  receipt: repair,
  sourceInode: [1, 2],
  targetInode: [3, 4],
  updatesInode: null,
};

describe("repairUnresolved", () => {
  const parse = (raw: unknown) => ClosedRepairJournal.safeParse(raw);
  it("is quiet when no repair evidence exists", () => {
    expect(
      repairUnresolved({
        receiptRaw: null,
        journalRaw: null,
        repair: null,
        journal: parse(null),
      }),
    ).toBe(false);
  });
  it("accepts a receipt and journal that agree", () => {
    expect(
      repairUnresolved({
        receiptRaw: repair,
        journalRaw,
        repair,
        journal: parse(journalRaw),
      }),
    ).toBe(false);
  });
  it("holds when either half is missing, invalid or disagrees", () => {
    expect(
      repairUnresolved({
        receiptRaw: repair,
        journalRaw: null,
        repair,
        journal: parse(null),
      }),
    ).toBe(true);
    expect(
      repairUnresolved({
        receiptRaw: null,
        journalRaw,
        repair: null,
        journal: parse(journalRaw),
      }),
    ).toBe(true);
    const rolled = { ...journalRaw, phase: "rolled_back" };
    expect(
      repairUnresolved({
        receiptRaw: repair,
        journalRaw: rolled,
        repair,
        journal: parse(rolled),
      }),
    ).toBe(true);
    const other = { ...journalRaw, receipt: { ...repair, quarantined: true } };
    expect(
      repairUnresolved({
        receiptRaw: repair,
        journalRaw: other,
        repair,
        journal: parse(other),
      }),
    ).toBe(true);
  });
});

describe("receiptTargetMismatch", () => {
  it("compares the receipt target with the manifest release", () => {
    const release = {
      artifactSha256: target.digest,
      version: target.version,
      buildId: target.buildId,
    };
    expect(receiptTargetMismatch(operation, release)).toBe(false);
    expect(
      receiptTargetMismatch(operation, { ...release, version: "9.9.9" }),
    ).toBe(true);
  });
});

describe("manualReplacementApplies", () => {
  const base = {
    supervised: false,
    installLocation: "shared",
    settled: target,
    receiptRunningBuildId: target.buildId,
    running: { buildId: d("9"), version: "2.0.0" },
    target,
    compareVersions: (left: string, right: string) =>
      left === right ? 0 : left > right ? 1 : -1,
  };
  it("needs a newer unrelated copy in the shared slot", () => {
    expect(manualReplacementApplies(base)).toBe(true);
    expect(manualReplacementApplies({ ...base, supervised: true })).toBe(false);
    expect(
      manualReplacementApplies({ ...base, installLocation: "legacy" }),
    ).toBe(false);
    expect(manualReplacementApplies({ ...base, settled: null })).toBe(false);
    expect(
      manualReplacementApplies({ ...base, receiptRunningBuildId: d("8") }),
    ).toBe(false);
    expect(
      manualReplacementApplies({
        ...base,
        running: { buildId: target.buildId, version: "2.0.0" },
      }),
    ).toBe(false);
    expect(
      manualReplacementApplies({ ...base, compareVersions: () => null }),
    ).toBe(false);
  });
  it("does not compare versions once an earlier test fails", () => {
    let compared = 0;
    manualReplacementApplies({
      ...base,
      supervised: true,
      compareVersions: () => {
        compared += 1;
        return 1;
      },
    });
    expect(compared).toBe(0);
  });
});

describe("repair identity", () => {
  const previous = repairPrevious(slot, repair.operationId);
  it("places the predecessor beside the slot", () => {
    expect(previous).toBe(
      `/Applications/.farol-repair-${repair.operationId}/previous.app`,
    );
  });
  it("matches only the exact slot, profile and locations", () => {
    const input = { repair, slot, userData, previous };
    expect(repairIdentityMismatch(input)).toBe(false);
    expect(repairIdentityMismatch({ ...input, slot: "/other.app" })).toBe(true);
    expect(repairIdentityMismatch({ ...input, userData: "/other" })).toBe(true);
    expect(repairIdentityMismatch({ ...input, previous: "/other" })).toBe(true);
    expect(
      repairIdentityMismatch({
        ...input,
        repair: { ...repair, quarantine: "/other" },
      }),
    ).toBe(true);
  });
  it("compares installed and rollback repairs with the running build", () => {
    const running = {
      sourceCommit: "a".repeat(40),
      sourceTreeDigest: d("e"),
      buildId: target.buildId,
      version: target.version,
    };
    expect(repairInstalledMismatch(repair, running)).toBe(false);
    expect(
      repairInstalledMismatch(repair, {
        ...running,
        sourceCommit: "b".repeat(40),
      }),
    ).toBe(true);
    expect(repairInstalledMismatch(repair, { ...running, version: "0" })).toBe(
      true,
    );
    expect(
      repairRollbackMismatch(repair, {
        buildId: source.buildId,
        version: source.version,
      }),
    ).toBe(false);
    expect(
      repairRollbackMismatch(repair, {
        buildId: d("1"),
        version: source.version,
      }),
    ).toBe(true);
  });
});

describe("promotionUnconfirmed", () => {
  const file = `${slot}.receipt.json`;
  const receipt = {
    schema: "farol.promotion-plan/1" as const,
    operation: "applied" as const,
    product: "Farol" as const,
    version: "1.2.3",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: d("e"),
    sourceDirty: false as const,
    artifactSha256: d("a"),
    source: "/source",
    destination: slot,
    receipt: file,
    overwrite: false as const,
    legacyMutation: false as const,
    activation: {
      userData,
      drained: true as const,
      obligations: [] as never[],
    },
    verifiedDestinationSha256: d("a"),
  };
  const running = {
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: d("e"),
    version: "1.2.3",
  };
  const input = { receipt, slot, file, userData, running };
  it("anchors only a receipt that names this copy", () => {
    expect(promotionUnconfirmed(input)).toBe(false);
    expect(promotionUnconfirmed({ ...input, slot: "/other.app" })).toBe(true);
    expect(promotionUnconfirmed({ ...input, file: "/other" })).toBe(true);
    expect(promotionUnconfirmed({ ...input, userData: "/other" })).toBe(true);
    expect(
      promotionUnconfirmed({
        ...input,
        running: { ...running, version: "9.9.9" },
      }),
    ).toBe(true);
    expect(
      promotionUnconfirmed({
        ...input,
        receipt: { ...receipt, verifiedDestinationSha256: d("b") },
      }),
    ).toBe(true);
  });
});
