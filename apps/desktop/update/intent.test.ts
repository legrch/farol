import { describe, expect, it } from "vitest";
import {
  applyRefusalRecord,
  cleanupMarkerFor,
  downloadIntentFor,
  DrainReport,
  interruptedDownloadRecord,
  newDownloadStage,
  preparedEntryAllowed,
  restoreExitRecord,
  restoreIntentFor,
  restoreIntentWithHelper,
  restoreNotStartedRecord,
  restoreRefusalRecord,
  retainedFromReceipt,
  settledJournal,
  settledReceiptRecord,
  stageIdentityOf,
} from "./intent";
import { DownloadIntent, RestoreIntent, SavedReceipt } from "./record";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };

describe("download records", () => {
  it("allocates a stage and binds it to the release in a valid intent", () => {
    const stage = newDownloadStage("2".repeat(32), {
      pid: 4242,
      processStart: "Mon Jan  1 00:00:00 2026",
    });
    expect(stage.phase).toBe("downloading");
    const intent = downloadIntentFor(
      { buildId: d("b"), archiveSha256: d("f") },
      stage,
    );
    expect(DownloadIntent.safeParse(intent).success).toBe(true);
    expect(Object.keys(intent)).toEqual([
      "schema",
      "buildId",
      "archiveSha256",
      "download",
    ]);
  });
  it("names a created directory by its decimal identity", () => {
    expect(stageIdentityOf({ dev: 1n, ino: 22n, birthtimeNs: 333n })).toEqual({
      dev: "1",
      ino: "22",
      birthtimeNs: "333",
    });
  });
  it("notes a reconciled interruption", () => {
    const intent = downloadIntentFor(
      { buildId: d("b"), archiveSha256: d("f") },
      newDownloadStage("2".repeat(32), { pid: 4242, processStart: "x" }),
    );
    expect(
      interruptedDownloadRecord(intent, "2026-01-01T00:00:00.000Z"),
    ).toEqual({
      schema: "farol.interrupted-download/1",
      intent,
      outcome: "producer-ended-stage-removed",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
  });
  it("fences a package with or without its operation copy", () => {
    expect(cleanupMarkerFor("/h")).toEqual({
      schema: "farol.update-package-cleanup/1",
      handle: "/h",
    });
    expect(Object.keys(cleanupMarkerFor("/h", "/r"))).toEqual([
      "schema",
      "handle",
      "operationRoot",
    ]);
  });
  it("parses the obligations report strictly", () => {
    const report = {
      drained: true,
      obligationCount: 0,
      unreadableCount: 0,
      changedCount: 0,
    };
    expect(DrainReport.parse(report)).toEqual(report);
    expect(DrainReport.safeParse({ ...report, extra: 1 }).success).toBe(false);
  });
  it("admits only the three entries a pre-dispatch directory may hold", () => {
    for (const name of ["staged.app", "slot-binding.json", "helper.log.jsonl"])
      expect(preparedEntryAllowed(name, "slot-binding.json")).toBe(true);
    for (const name of ["journal.json", "previous.app", "other"])
      expect(preparedEntryAllowed(name, "slot-binding.json")).toBe(false);
  });
});

describe("restore records", () => {
  const start = restoreIntentFor({
    action: "rollback",
    operation,
    priorPhase: "completed",
    installedBefore: target,
  });
  it("starts without a helper and stays a valid intent as the helper is learned", () => {
    expect(start.helper).toBeNull();
    expect(RestoreIntent.safeParse(start).success).toBe(true);
    const spawned = restoreIntentWithHelper(start, 4242, null);
    expect(spawned.helper).toEqual({ pid: 4242, processStart: null });
    const started = restoreIntentWithHelper(spawned, 4242, "t0");
    expect(started.helper).toEqual({ pid: 4242, processStart: "t0" });
    expect(RestoreIntent.safeParse(started).success).toBe(true);
    expect(start.helper).toBeNull();
  });
  it("records a launch that never started and the refusal beside it", () => {
    const notStarted = restoreNotStartedRecord({
      action: "recover",
      operation,
      priorPhase: "verified",
      notStartedAt: source,
    });
    expect(RestoreIntent.safeParse(notStarted).success).toBe(true);
    expect(notStarted).not.toHaveProperty("helper");
    expect(
      restoreRefusalRecord({
        action: "recover",
        operation,
        code: "helper_refused",
        priorPhase: "verified",
      }),
    ).toEqual({
      schema: "farol.update-refusal/1",
      action: "recover",
      operation,
      code: "helper_refused",
      priorPhase: "verified",
    });
  });
  it("witnesses a helper that exited without a journal change", () => {
    const pending = { ...start, helper: { pid: 9, processStart: "t0" } };
    expect(restoreExitRecord(pending, operation)).toEqual({
      schema: "farol.update-refusal/1",
      action: "rollback",
      operation,
      helper: { pid: 9, processStart: "t0" },
      priorPhase: "completed",
      installedBefore: target,
      code: "helper_exited_without_journal_change",
    });
  });
  it("records an apply refusal without a prior phase", () => {
    expect(applyRefusalRecord(operation, "helper_refused")).toEqual({
      schema: "farol.update-refusal/1",
      action: "apply",
      operation,
      code: "helper_refused",
    });
  });
});

describe("settlement records", () => {
  it("keeps an existing journal and replaces only its phase", () => {
    const journal = {
      schema: "farol.installed-update-journal/1" as const,
      ...operation,
      phase: "verified" as const,
    };
    expect(settledJournal(journal, operation, "completed")).toEqual({
      ...journal,
      phase: "completed",
    });
  });
  it("builds a fresh journal when none was written", () => {
    expect(settledJournal(null, operation, "rolled_back")).toEqual({
      schema: "farol.installed-update-journal/1",
      ...operation,
      phase: "rolled_back",
    });
  });
  it("round-trips a retained update through a saved receipt", () => {
    const retained = {
      schema: "farol.ready-update/1" as const,
      handle: "/h",
      manifest: {},
      operation,
    };
    const saved = settledReceiptRecord(
      retained,
      "2026-01-01T00:00:00.000Z",
      "completed",
      d("d"),
    );
    expect(SavedReceipt.safeParse(saved).success).toBe(true);
    expect(retainedFromReceipt(SavedReceipt.parse(saved))).toEqual(retained);
  });
});
