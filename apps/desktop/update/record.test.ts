import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AcceptedBuild,
  AutomaticUpdatePreferences,
  CANCELLED_PHASES,
  ClosedRepairJournal,
  ClosedRepairReceipt,
  Digest,
  DownloadIntent,
  DownloadStage,
  InstallOnQuitPreferences,
  InstallOnQuitUnconfirmed,
  Journal,
  MAX_RECORD_BYTES,
  NoticePreferences,
  Operation,
  ProcessStart,
  PromotionReceipt,
  RELAUNCH_ARGUMENT,
  RelaunchHint,
  RepairInode,
  RestoreIntent,
  Retained,
  ROLLED_BACK_PHASES,
  SavedReceipt,
  TARGET_PHASES,
  UpdatePreferences,
  sameBuild,
  sameOperation,
} from "./record";

const d = (c: string) => c.repeat(64);
const build = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const operation = {
  operationId: "c".repeat(32),
  source: build,
  target: { ...build, version: "1.2.4" },
};
const commit = "d".repeat(40);
const accepts = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).success;

describe("record schemas", () => {
  it("accepts only lowercase 64-hex digests", () => {
    expect(accepts(Digest, d("0"))).toBe(true);
    expect(accepts(Digest, "a".repeat(63))).toBe(false);
    expect(accepts(Digest, "a".repeat(65))).toBe(false);
    expect(accepts(Digest, d("A"))).toBe(false);
  });

  it("parses skip/later preferences strictly", () => {
    const base = {
      schema: "farol.installed-update-preferences/1",
      skipped: { version: "1.0.0", buildId: d("a") },
    };
    expect(accepts(UpdatePreferences, base)).toBe(true);
    expect(accepts(UpdatePreferences, { ...base, skipped: null })).toBe(true);
    expect(accepts(UpdatePreferences, { ...base, deferredVersion: null })).toBe(
      true,
    );
    expect(accepts(UpdatePreferences, { ...base, extra: 1 })).toBe(false);
    expect(
      accepts(UpdatePreferences, {
        ...base,
        skipped: { version: "v".repeat(129), buildId: d("a") },
      }),
    ).toBe(false);
    expect(accepts(UpdatePreferences, { ...base, schema: "other/1" })).toBe(
      false,
    );
    expect(accepts(UpdatePreferences, { schema: base.schema })).toBe(false);
  });

  it("parses notice preferences and the failure notice key", () => {
    const schema = "farol.installed-update-notices/1";
    const failureNotice = {
      version: null,
      code: "UPDATE_FAILED",
      key: `failure:${"1".repeat(24)}`,
      seen: false,
    };
    expect(accepts(NoticePreferences, { schema })).toBe(true);
    expect(accepts(NoticePreferences, { schema, failureNotice })).toBe(true);
    expect(accepts(NoticePreferences, { schema, failureNotice: null })).toBe(
      true,
    );
    expect(
      accepts(NoticePreferences, {
        schema,
        failureNotice: { ...failureNotice, code: "lower" },
      }),
    ).toBe(false);
    expect(
      accepts(NoticePreferences, {
        schema,
        failureNotice: { ...failureNotice, key: "failure:abc" },
      }),
    ).toBe(false);
    expect(accepts(NoticePreferences, { schema, extra: true })).toBe(false);
  });

  it("discriminates the automatic update preference by schema", () => {
    expect(
      accepts(AutomaticUpdatePreferences, {
        schema: "farol.installed-automatic-update-preference/1",
        enabled: true,
      }),
    ).toBe(true);
    expect(
      accepts(AutomaticUpdatePreferences, {
        schema: "farol.installed-automatic-update-preference/2",
        scope: "download-and-install",
        enabled: false,
      }),
    ).toBe(true);
    expect(
      accepts(AutomaticUpdatePreferences, {
        schema: "farol.installed-automatic-update-preference/2",
        enabled: false,
      }),
    ).toBe(false);
    expect(
      accepts(AutomaticUpdatePreferences, {
        schema: "farol.installed-automatic-update-preference/1",
        scope: "download-and-install",
        enabled: true,
      }),
    ).toBe(false);
    expect(
      accepts(AutomaticUpdatePreferences, {
        schema: "farol.installed-automatic-update-preference/3",
        enabled: true,
      }),
    ).toBe(false);
  });

  it("parses install-on-quit preference and its unconfirmed fence", () => {
    const pref = {
      schema: "farol.installed-install-on-quit-preference/1",
      scope: "install-on-normal-quit",
      enabled: true,
    };
    expect(accepts(InstallOnQuitPreferences, pref)).toBe(true);
    expect(accepts(InstallOnQuitPreferences, { ...pref, scope: "other" })).toBe(
      false,
    );
    expect(accepts(InstallOnQuitPreferences, { ...pref, x: 1 })).toBe(false);
    const fence = {
      schema: "farol.installed-install-on-quit-unconfirmed/1",
      enabled: false,
    };
    expect(accepts(InstallOnQuitUnconfirmed, fence)).toBe(true);
    expect(accepts(InstallOnQuitUnconfirmed, { ...fence, x: 1 })).toBe(false);
    expect(accepts(InstallOnQuitUnconfirmed, { schema: fence.schema })).toBe(
      false,
    );
  });

  it("parses accepted builds and operations strictly", () => {
    expect(accepts(AcceptedBuild, build)).toBe(true);
    expect(accepts(AcceptedBuild, { ...build, extra: 1 })).toBe(false);
    expect(accepts(AcceptedBuild, { ...build, digest: "x" })).toBe(false);
    expect(accepts(AcceptedBuild, { ...build, version: "v".repeat(129) })).toBe(
      false,
    );
    expect(accepts(Operation, operation)).toBe(true);
    expect(
      accepts(Operation, { ...operation, operationId: "c".repeat(31) }),
    ).toBe(false);
    expect(accepts(Operation, { ...operation, extra: 1 })).toBe(false);
  });

  it("parses the journal with every phase and rejects others", () => {
    const journal = {
      ...operation,
      schema: "farol.installed-update-journal/1",
      phase: "prepared",
    };
    for (const phase of Journal.shape.phase.options)
      expect(accepts(Journal, { ...journal, phase })).toBe(true);
    expect(Journal.shape.phase.options).toHaveLength(13);
    expect(accepts(Journal, { ...journal, phase: "bogus" })).toBe(false);
    expect(accepts(Journal, { ...journal, extra: 1 })).toBe(false);
    expect(accepts(Journal, { ...journal, schema: "x" })).toBe(false);
  });

  it("parses a retained ready update", () => {
    const retained = {
      schema: "farol.ready-update/1",
      handle: "h",
      manifest: { anything: true },
      operation: null,
    };
    expect(accepts(Retained, retained)).toBe(true);
    expect(
      accepts(Retained, {
        ...retained,
        operation,
        notes: "n",
        downloadId: "e".repeat(32),
        preparation: operation,
        archiveReleased: true,
        helper: { pid: 2, processStart: null },
      }),
    ).toBe(true);
    expect(accepts(Retained, { ...retained, helper: null })).toBe(true);
    expect(
      accepts(Retained, { ...retained, helper: { pid: 1, processStart: "x" } }),
    ).toBe(false);
    expect(
      accepts(Retained, { ...retained, helper: { pid: 2, processStart: "" } }),
    ).toBe(false);
    expect(accepts(Retained, { ...retained, notes: "n".repeat(4097) })).toBe(
      false,
    );
    expect(accepts(Retained, { ...retained, downloadId: "zz" })).toBe(false);
    expect(accepts(Retained, { ...retained, extra: 1 })).toBe(false);
    const { operation: _omitted, ...missing } = retained;
    expect(accepts(Retained, missing)).toBe(false);
  });

  it("parses saved receipts as retained plus observation", () => {
    const saved = {
      schema: "farol.ready-update/1",
      handle: "h",
      manifest: null,
      operation: null,
      observedAt: "2026-11-26T00:00:00Z",
      phase: "verified",
      runningBuildId: d("a"),
    };
    expect(accepts(SavedReceipt, saved)).toBe(true);
    expect(accepts(SavedReceipt, { ...saved, phase: "nope" })).toBe(false);
    expect(
      accepts(SavedReceipt, { ...saved, observedAt: "x".repeat(65) }),
    ).toBe(false);
    expect(accepts(SavedReceipt, { ...saved, runningBuildId: "x" })).toBe(
      false,
    );
  });

  it("parses download stages and intents", () => {
    const stage = {
      id: "f".repeat(32),
      producer: { pid: 2, processStart: "p" },
    };
    expect(accepts(DownloadStage, stage)).toBe(true);
    expect(
      accepts(DownloadStage, {
        ...stage,
        phase: "verifying",
        identity: { dev: "1", ino: "2", birthtimeNs: "3" },
      }),
    ).toBe(true);
    expect(accepts(DownloadStage, { ...stage, phase: "done" })).toBe(false);
    expect(
      accepts(DownloadStage, {
        ...stage,
        identity: { dev: "1", ino: "2", birthtimeNs: "-3" },
      }),
    ).toBe(false);
    expect(
      accepts(DownloadStage, {
        ...stage,
        identity: { dev: "9".repeat(31), ino: "2", birthtimeNs: "3" },
      }),
    ).toBe(false);
    expect(
      accepts(DownloadStage, {
        ...stage,
        producer: { pid: 2, processStart: "" },
      }),
    ).toBe(false);
    const intent = {
      schema: "farol.update-download-intent/1",
      buildId: d("a"),
      archiveSha256: d("b"),
    };
    expect(accepts(DownloadIntent, intent)).toBe(true);
    expect(accepts(DownloadIntent, { ...intent, download: stage })).toBe(true);
    expect(accepts(DownloadIntent, { ...intent, extra: 1 })).toBe(false);
    expect(accepts(DownloadIntent, { ...intent, buildId: "x" })).toBe(false);
  });

  it("parses restore intents", () => {
    const intent = {
      schema: "farol.update-restore-intent/1",
      action: "rollback",
      operation,
      priorPhase: "verified",
    };
    expect(accepts(RestoreIntent, intent)).toBe(true);
    expect(accepts(RestoreIntent, { ...intent, action: "recover" })).toBe(true);
    expect(
      accepts(RestoreIntent, {
        ...intent,
        notStartedAt: build,
        installedBefore: build,
        helper: null,
      }),
    ).toBe(true);
    expect(accepts(RestoreIntent, { ...intent, action: "apply" })).toBe(false);
    expect(accepts(RestoreIntent, { ...intent, priorPhase: "x" })).toBe(false);
    expect(accepts(RestoreIntent, { ...intent, extra: 1 })).toBe(false);
  });

  const promotion = {
    schema: "farol.promotion-plan/1",
    operation: "applied",
    product: "Farol",
    version: "1.2.3",
    sourceCommit: commit,
    sourceTreeDigest: d("a"),
    sourceDirty: false,
    artifactSha256: d("b"),
    source: "/s",
    destination: "/d",
    receipt: "/r",
    overwrite: false,
    legacyMutation: false,
    activation: { userData: "/u", drained: true, obligations: [] },
    verifiedDestinationSha256: d("c"),
  };

  it("parses promotion receipts with closed literals", () => {
    expect(accepts(PromotionReceipt, promotion)).toBe(true);
    for (const patch of [
      { sourceDirty: true },
      { overwrite: true },
      { legacyMutation: true },
      { product: "Other" },
      { operation: "rolled_back" },
      { sourceCommit: "d".repeat(39) },
      { destination: "d".repeat(4097) },
      { activation: { userData: "/u", drained: false, obligations: [] } },
      { activation: { userData: "/u", drained: true, obligations: [1] } },
      { extra: 1 },
    ])
      expect(accepts(PromotionReceipt, { ...promotion, ...patch })).toBe(false);
  });

  const repair = {
    schema: "farol.closed-repair/1",
    operationId: "c".repeat(32),
    phase: "installed",
    destination: "/d",
    userData: "/u",
    source: build,
    target: build,
    sourceCommit: commit,
    sourceTreeDigest: d("a"),
    sourceDirty: false,
    previous: "/p",
    quarantine: "/q",
    quarantined: true,
    quitDigest: d("b"),
  };

  it("parses closed repair receipts and journals", () => {
    expect(accepts(ClosedRepairReceipt, repair)).toBe(true);
    expect(
      accepts(ClosedRepairReceipt, { ...repair, phase: "rolled_back" }),
    ).toBe(true);
    expect(accepts(ClosedRepairReceipt, { ...repair, phase: "prepared" })).toBe(
      false,
    );
    expect(accepts(ClosedRepairReceipt, { ...repair, sourceDirty: true })).toBe(
      false,
    );
    expect(accepts(ClosedRepairReceipt, { ...repair, extra: 1 })).toBe(false);
    const journal = {
      schema: "farol.closed-repair-journal/1",
      phase: "installed",
      receipt: repair,
      sourceInode: [1, 2],
      targetInode: [0, 0],
      updatesInode: null,
    };
    expect(accepts(ClosedRepairJournal, journal)).toBe(true);
    expect(
      accepts(ClosedRepairJournal, { ...journal, updatesInode: [3, 4] }),
    ).toBe(true);
    expect(
      accepts(ClosedRepairJournal, { ...journal, sourceInode: [-1, 2] }),
    ).toBe(false);
    expect(
      accepts(ClosedRepairJournal, { ...journal, sourceInode: [1.5, 2] }),
    ).toBe(false);
    expect(
      accepts(ClosedRepairJournal, { ...journal, targetInode: [1, 2, 3] }),
    ).toBe(false);
    const { updatesInode: _omitted, ...missing } = journal;
    expect(accepts(ClosedRepairJournal, missing)).toBe(false);
  });

  it("parses repair inodes as non-negative integer pairs", () => {
    expect(accepts(RepairInode, [0, 0])).toBe(true);
    expect(accepts(RepairInode, [1])).toBe(false);
    expect(accepts(RepairInode, ["1", 2])).toBe(false);
  });

  it("parses process starts and relaunch hints", () => {
    expect(accepts(ProcessStart, "Thu Nov  5 09:08:07 2026")).toBe(true);
    expect(accepts(ProcessStart, "Thu Nov 15 09:08:07 2026")).toBe(true);
    expect(accepts(ProcessStart, "Thursday Nov 5 09:08:07 2026")).toBe(false);
    expect(accepts(ProcessStart, "Thu Nov 5 09:08 2026")).toBe(false);
    const hint = {
      operationId: "c".repeat(32),
      action: "apply",
      phase: "completed",
      helper: { pid: 2, processStart: "Thu Nov  5 09:08:07 2026" },
      buildId: d("a"),
    };
    expect(accepts(RelaunchHint, hint)).toBe(true);
    expect(
      accepts(RelaunchHint, {
        ...hint,
        helper: { ...hint.helper, pid: Number.MAX_SAFE_INTEGER },
      }),
    ).toBe(true);
    expect(
      accepts(RelaunchHint, {
        ...hint,
        helper: { ...hint.helper, pid: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toBe(false);
    expect(
      accepts(RelaunchHint, { ...hint, helper: { ...hint.helper, pid: 1 } }),
    ).toBe(false);
    expect(accepts(RelaunchHint, { ...hint, phase: "verified" })).toBe(false);
    expect(accepts(RelaunchHint, { ...hint, action: "cancel" })).toBe(false);
    expect(accepts(RelaunchHint, { ...hint, extra: 1 })).toBe(false);
  });

  it("keeps the phase groups and limits fixed", () => {
    expect(ROLLED_BACK_PHASES).toEqual([
      "rolled_back",
      "rollback_launch_requested",
      "rollback_completed",
    ]);
    expect(CANCELLED_PHASES).toEqual([
      "cancelled",
      "cancel_launch_requested",
      "cancel_completed",
    ]);
    expect(TARGET_PHASES).toEqual([
      "verified",
      "launch_requested",
      "completed",
    ]);
    expect(MAX_RECORD_BYTES).toBe(65536);
    expect(RELAUNCH_ARGUMENT).toBe("--farol-installed-update-relaunch");
  });
});

describe("comparators", () => {
  it("compares builds by digest, version and build id", () => {
    expect(sameBuild(build, { ...build })).toBe(true);
    expect(sameBuild(build, { ...build, digest: d("c") })).toBe(false);
    expect(sameBuild(build, { ...build, version: "1.2.4" })).toBe(false);
    expect(sameBuild(build, { ...build, buildId: d("c") })).toBe(false);
  });

  it("compares operations by id, source and target", () => {
    expect(sameOperation(operation, structuredClone(operation))).toBe(true);
    expect(
      sameOperation(operation, { ...operation, operationId: "d".repeat(32) }),
    ).toBe(false);
    expect(
      sameOperation(operation, { ...operation, source: operation.target }),
    ).toBe(false);
    expect(
      sameOperation(operation, { ...operation, target: operation.source }),
    ).toBe(false);
  });
});
