import { describe, expect, it } from "vitest";
import { installedUpdateStartupDecision } from "./decision";
import {
  applyEntryRefusal,
  applyRolledBack,
  applyUnsettledCode,
  candidateDeferred,
  candidateSkipped,
  claimableInterruptedDownload,
  classifyPackageVerification,
  confirmationStale,
  downloadFailureCode,
  downloadIntentConflicts,
  downloadRecoveryAtStartup,
  downloadStageIdentityChanged,
  downloadStageScan,
  emptyRecoveryOutcome,
  handoffAdmitted,
  helperNoEffectCode,
  historicalReceiptSuperseded,
  increasingRelease,
  keptExtractionFencesVerification,
  prepareFailureHandoff,
  preparationUnreconciled,
  quitDeadlineExpired,
  quitFailureHandoff,
  quitTimerDelayMs,
  readinessTimeoutMs,
  restoreExitWitnessApplies,
  restoreFailureHandoff,
  restoreNotStartedMismatch,
  retainedBuildRelation,
  retainedReadyReclaimable,
  rollbackVersionFor,
  settledReceiptUnchanged,
  startupSettlement,
  unadmittedHandoff,
  verificationHandoff,
  verificationRefusalCode,
} from "./stage";

const d = (c: string) => c.repeat(64);
const build = (c: string, version: string) => ({
  digest: d(c),
  version,
  buildId: d(c === "a" ? "b" : c === "c" ? "d" : "f"),
});
const source = build("a", "1.2.3");
const target = build("c", "1.2.4");
const other = build("e", "9.9.9");
const operation = { operationId: "1".repeat(32), source, target };
const running = { buildId: source.buildId, version: source.version };

describe("increasingRelease", () => {
  it.each([
    [1, "11", "10", true],
    [1, "10", "10", false],
    [1, "9", "10", false],
    [0, "11", "10", false],
    [-1, "11", "10", false],
    [null, "11", "10", false],
  ])("order %s build %s over %s is %s", (order, next, now, expected) => {
    expect(increasingRelease(order, next, now)).toBe(expected);
  });

  it("compares build numbers beyond the safe integer range", () => {
    expect(increasingRelease(1, "9007199254740993", "9007199254740992")).toBe(
      true,
    );
  });
});

describe("package verification", () => {
  const cases: Array<
    [
      string,
      { ok: boolean; certainty?: string; reason?: string },
      boolean,
      "verified" | "outcome_unknown" | "capacity" | "invalid",
    ]
  > = [
    ["clean and matching", { ok: true }, true, "verified"],
    ["clean but a different release", { ok: true }, false, "invalid"],
    ["known failure", { ok: false, certainty: "known" }, false, "invalid"],
    [
      "unknown certainty",
      { ok: false, certainty: "unknown" },
      false,
      "outcome_unknown",
    ],
    [
      "unknown certainty with capacity reason",
      { ok: false, certainty: "unknown", reason: "stage_capacity" },
      false,
      "outcome_unknown",
    ],
    [
      "known capacity",
      { ok: false, certainty: "known", reason: "stage_capacity" },
      false,
      "capacity",
    ],
    [
      "capacity without certainty",
      { ok: false, reason: "stage_capacity" },
      false,
      "capacity",
    ],
    [
      "other reason",
      { ok: false, reason: "invalid_package" },
      false,
      "invalid",
    ],
    [
      "failed check that claims a match",
      { ok: false, certainty: "known" },
      true,
      "invalid",
    ],
  ];
  it.each(cases)("%s", (_name, check, matches, expected) => {
    expect(classifyPackageVerification(check, matches)).toBe(expected);
  });

  it("maps each refusal to its code and handoff status", () => {
    expect(verificationRefusalCode("outcome_unknown")).toBe(
      "UPDATE_STAGING_OUTCOME_UNKNOWN",
    );
    expect(verificationRefusalCode("capacity")).toBe(
      "UPDATE_VERIFICATION_RECOVERY_REQUIRED",
    );
    expect(verificationRefusalCode("invalid")).toBe(
      "UPDATE_RETAINED_PACKAGE_INVALID",
    );
    expect(verificationHandoff("outcome_unknown")).toEqual({
      status: "unknown",
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
    });
    expect(verificationHandoff("capacity")).toEqual({
      status: "blocked",
      code: "UPDATE_VERIFICATION_RECOVERY_REQUIRED",
    });
    expect(verificationHandoff("invalid")).toEqual({
      status: "blocked",
      code: "UPDATE_RETAINED_PACKAGE_INVALID",
    });
  });

  it("never reports a verified package as a success code", () => {
    expect(verificationRefusalCode("verified")).toBe(
      "UPDATE_RETAINED_PACKAGE_INVALID",
    );
    expect(verificationHandoff("verified").status).toBe("blocked");
  });
});

describe("download staging", () => {
  it("prefixes a known failure code once", () => {
    expect(downloadFailureCode("checksum_mismatch")).toBe(
      "UPDATE_CHECKSUM_MISMATCH",
    );
  });

  it("reconciles only an intent without a ready record, never over a restore", () => {
    const t = (
      hasIntent: boolean,
      fromReady: boolean,
      restorePending: boolean,
    ) => downloadRecoveryAtStartup({ hasIntent, fromReady, restorePending });
    expect(t(false, false, false)).toBe("none");
    expect(t(false, false, true)).toBe("none");
    expect(t(true, true, false)).toBe("none");
    expect(t(true, true, true)).toBe("none");
    expect(t(true, false, false)).toBe("reconcile");
    expect(t(true, false, true)).toBe("restore_unknown");
  });

  it("claims only a stage witnessed as downloading or verifying", () => {
    const stage = (phase?: "downloading" | "verifying") => ({
      ...(phase ? { phase } : {}),
      id: "a".repeat(32),
      producer: { pid: 5, processStart: "t" },
    });
    expect(claimableInterruptedDownload(undefined)).toBe(false);
    expect(claimableInterruptedDownload(stage())).toBe(false);
    expect(claimableInterruptedDownload(stage("verifying"))).toBe(true);
    expect(claimableInterruptedDownload(stage("downloading"))).toBe(true);
  });

  describe("a download stage that may hold verifier extractions", () => {
    const root = "/u/installed-updates";
    const stage = `${root}/download-${"a".repeat(32)}`;
    const other = `${root}/download-${"b".repeat(32)}`;
    const at = (path: string, ino = 1n) => ({ path, dev: 7n, ino });
    const scan = (
      over: Partial<{
        kept: { entry: string }[];
        unscanned: string[];
        scanned: { path: string; dev: bigint; ino: bigint }[];
        root: object | null;
        incomplete: boolean;
      }> = {},
    ) => ({
      kept: [],
      unscanned: [],
      scanned: [at(root, 5n), at(stage, 9n)],
      root: {},
      incomplete: false,
      ...over,
    });

    it("yields the identity the pass scanned when it kept nothing inside", () => {
      expect(downloadStageScan(scan(), root, stage)).toEqual({
        dev: 7n,
        ino: 9n,
      });
    });
    it("ignores what the scan kept in another staging parent", () => {
      expect(
        downloadStageScan(
          scan({
            kept: [
              { entry: `${root}/farol-update-verify-x` },
              { entry: `${other}/farol-update-verify-y` },
            ],
          }),
          root,
          stage,
        ),
      ).toEqual({ dev: 7n, ino: 9n });
    });
    it("is unknown while any extraction inside it was kept", () => {
      expect(
        downloadStageScan(
          scan({ kept: [{ entry: `${stage}/farol-update-verify-z` }] }),
          root,
          stage,
        ),
      ).toBeNull();
    });
    it("reports a stage the pass never listed as absent, not as clear", () => {
      expect(
        downloadStageScan(
          scan({ scanned: [at(root, 5n), at(other, 3n)] }),
          root,
          stage,
        ),
      ).toBe("absent");
    });
    it.each([
      ["the stage was skipped", { unscanned: [stage] }],
      ["the update root was skipped", { unscanned: [root] }],
      ["the update root was never scanned", { scanned: [at(stage, 9n)] }],
      ["the update root could not be captured", { root: null }],
      ["an error cut the pass short", { incomplete: true }],
    ])("is unknown when %s", (_name, over) => {
      expect(downloadStageScan(scan(over), root, stage)).toBeNull();
    });
    it("is unknown when no scan ran", () => {
      expect(downloadStageScan(null, root, stage)).toBeNull();
    });
  });

  describe("keptExtractionFencesVerification", () => {
    it("fences a retained package's verification when the pass kept any extraction", () => {
      expect(
        keptExtractionFencesVerification({
          kept: [{ entry: "/r/download-x/farol-update-verify-a" }],
          incomplete: false,
        }),
      ).toBe(true);
    });
    it("fences when an error cut the pass short, even with nothing kept", () => {
      expect(
        keptExtractionFencesVerification({ kept: [], incomplete: true }),
      ).toBe(true);
    });
    it("does not fence when the pass kept nothing (all reclaimed or none found)", () => {
      expect(
        keptExtractionFencesVerification({ kept: [], incomplete: false }),
      ).toBe(false);
    });
    it("does not fence without a pass (supervised, or the pass failed)", () => {
      expect(keptExtractionFencesVerification(null)).toBe(false);
    });
  });

  it("detects a stage directory that is no longer the recorded one", () => {
    const recorded = { dev: "1", ino: "2", birthtimeNs: "3" };
    const same = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    expect(downloadStageIdentityChanged(same, recorded)).toBe(false);
    expect(downloadStageIdentityChanged({ ...same, dev: 9n }, recorded)).toBe(
      true,
    );
    expect(downloadStageIdentityChanged({ ...same, ino: 9n }, recorded)).toBe(
      true,
    );
    expect(
      downloadStageIdentityChanged({ ...same, birthtimeNs: 9n }, recorded),
    ).toBe(true);
  });

  describe("leftover intent against the retained archive", () => {
    const id = "c".repeat(32);
    const intent = {
      schema: "farol.update-download-intent/1" as const,
      buildId: d("1"),
      archiveSha256: d("2"),
      download: {
        id,
        producer: { pid: 5, processStart: "t" },
      },
    };
    const manifest = { buildId: d("1"), archiveSha256: d("2") };
    const retained = { operation: null, downloadId: id };
    it("accepts the exact retained archive", () => {
      expect(downloadIntentConflicts(intent, retained, manifest)).toBe(false);
    });
    it.each([
      ["an operation exists", { ...retained, operation }, manifest],
      ["another build", retained, { ...manifest, buildId: d("9") }],
      ["another archive", retained, { ...manifest, archiveSha256: d("9") }],
      [
        "another download id",
        { ...retained, downloadId: "d".repeat(32) },
        manifest,
      ],
      ["no retained download id", { operation: null }, manifest],
    ])("conflicts when %s", (_name, r, m) => {
      expect(downloadIntentConflicts(intent, r, m)).toBe(true);
    });
    it("conflicts when the intent has no download witness", () => {
      const { download: _download, ...bare } = intent;
      expect(downloadIntentConflicts(bare, retained, manifest)).toBe(true);
    });
  });

  it("reports the empty startup outcome, restore first", () => {
    expect(
      emptyRecoveryOutcome({ restorePending: true, interruptedDownload: true }),
    ).toBe("restore_unknown");
    expect(
      emptyRecoveryOutcome({
        restorePending: true,
        interruptedDownload: false,
      }),
    ).toBe("restore_unknown");
    expect(
      emptyRecoveryOutcome({
        restorePending: false,
        interruptedDownload: true,
      }),
    ).toBe("download_interrupted");
    expect(
      emptyRecoveryOutcome({
        restorePending: false,
        interruptedDownload: false,
      }),
    ).toBe("none");
  });
});

describe("historical receipt superseded", () => {
  const compareVersions = (left: string, right: string) =>
    left === right ? 0 : left > right ? 1 : -1;
  const historical = (
    phase: string,
    runningBuildId: string,
    withOperation = true,
  ) =>
    ({
      phase,
      runningBuildId,
      operation: withOperation ? operation : null,
    }) as Parameters<typeof historicalReceiptSuperseded>[0]["historical"];
  const newer = { buildId: d("9"), version: "2.0.0" };
  const check = (
    h: ReturnType<typeof historical>,
    run: { buildId: string; version: string } = newer,
  ) =>
    historicalReceiptSuperseded({
      historical: h,
      running: run,
      compareVersions,
    });

  it("accepts a completed receipt seen by a strictly newer build", () => {
    expect(check(historical("completed", target.buildId))).toBe(true);
  });
  it("accepts a rolled-back receipt anchored on its source", () => {
    expect(check(historical("rolled_back", source.buildId))).toBe(true);
  });
  it.each(["verified", "launch_requested", "cancelled", "prepared"])(
    "never settles an unsettled phase %s",
    (phase) => {
      expect(check(historical(phase, target.buildId))).toBe(false);
      expect(check(historical(phase, source.buildId))).toBe(false);
    },
  );
  it("requires the receipt to be anchored on the settled build", () => {
    expect(check(historical("completed", source.buildId))).toBe(false);
    expect(check(historical("rolled_back", target.buildId))).toBe(false);
  });
  it("requires an operation", () => {
    expect(check(historical("completed", target.buildId, false))).toBe(false);
  });
  it("is not superseded by the target build itself", () => {
    expect(
      check(historical("completed", target.buildId), {
        buildId: target.buildId,
        version: "2.0.0",
      }),
    ).toBe(false);
  });
  it.each([
    ["the same version", "1.2.4"],
    ["an older version", "1.0.0"],
  ])("requires a strictly newer version, not %s", (_name, version) => {
    expect(
      check(historical("completed", target.buildId), {
        buildId: d("9"),
        version,
      }),
    ).toBe(false);
  });
  it("is not superseded when versions are incomparable", () => {
    expect(
      historicalReceiptSuperseded({
        historical: historical("completed", target.buildId),
        running: newer,
        compareVersions: () => null,
      }),
    ).toBe(false);
  });
});

describe("restore that never started", () => {
  const base = {
    pendingOperation: operation,
    retainedOperation: operation,
    notStartedAt: source,
    current: source,
    running,
  };
  it("matches only when everything recorded still holds", () => {
    expect(restoreNotStartedMismatch(base)).toBe(false);
  });
  it.each([
    ["no retained operation", { retainedOperation: null }],
    [
      "another retained operation",
      { retainedOperation: { ...operation, operationId: "2".repeat(32) } },
    ],
    [
      "another installed build id",
      { running: { ...running, buildId: d("9") } },
    ],
    [
      "another installed version",
      { running: { ...running, version: "0.0.1" } },
    ],
    ["a changed installed tree", { current: { ...source, digest: d("9") } }],
    ["a different recorded tree", { notStartedAt: other }],
  ])("mismatches on %s", (_name, change) => {
    expect(restoreNotStartedMismatch({ ...base, ...change })).toBe(true);
  });
});

describe("unfinished preparation", () => {
  const base = {
    fromReady: true,
    restorePending: false,
    retained: { operation: null, helper: null },
    current: source,
    running,
    preparation: operation,
    manifestTarget: target,
  };
  it("is reclaimable only in the one exact shape", () => {
    expect(preparationUnreconciled(base)).toBe(false);
    expect(
      preparationUnreconciled({
        ...base,
        retained: { operation: null, helper: undefined },
      }),
    ).toBe(false);
  });
  it.each([
    ["not from a ready record", { fromReady: false }],
    ["a restore pending", { restorePending: true }],
    ["an operation", { retained: { operation, helper: null } }],
    [
      "a helper",
      {
        retained: {
          operation: null,
          helper: { pid: 7, processStart: null },
        },
      },
    ],
    ["another running build", { running: { ...running, buildId: d("9") } }],
    ["another running version", { running: { ...running, version: "0.0.1" } }],
    ["a changed installed tree", { current: { ...source, digest: d("9") } }],
    ["another manifest target", { manifestTarget: other }],
  ])("is unreconciled with %s", (_name, change) => {
    expect(preparationUnreconciled({ ...base, ...change })).toBe(true);
  });
});

describe("startup settlement", () => {
  const decide = (
    helper: "running" | "exited" | "unknown",
    installed: typeof source,
    run: { version: string; buildId: string },
  ) =>
    installedUpdateStartupDecision({
      phase: null,
      helper,
      installed,
      running: run,
      operation,
    });
  const targetRun = { buildId: target.buildId, version: target.version };

  it("settles completed or rolled back from an exited helper", () => {
    expect(
      startupSettlement({
        decision: decide("exited", target, targetRun),
        helper: "ended",
      }),
    ).toEqual({ ok: true, phase: "completed" });
    expect(
      startupSettlement({
        decision: decide("exited", source, running),
        helper: "ended",
      }),
    ).toEqual({ ok: true, phase: "rolled_back" });
  });

  it("never settles while the helper runs", () => {
    expect(
      startupSettlement({
        decision: decide("running", target, targetRun),
        helper: "live",
      }),
    ).toEqual({ ok: false, code: "UPDATE_HELPER_EXIT_UNCONFIRMED" });
  });

  it("keeps an unknown helper outcome terminal, whatever was decided", () => {
    for (const decision of [
      decide("unknown", target, targetRun),
      decide("exited", target, targetRun),
      decide("running", target, targetRun),
    ])
      expect(startupSettlement({ decision, helper: "unknown" })).toEqual({
        ok: false,
        code: "UPDATE_HELPER_EXIT_UNCONFIRMED",
      });
  });

  it("refuses an identity the decision cannot accept", () => {
    expect(
      startupSettlement({
        decision: decide("exited", other, targetRun),
        helper: "ended",
      }),
    ).toEqual({ ok: false, code: "UPDATE_RECOVERY_IDENTITY_MISMATCH" });
  });

  it("refuses when the running build is not the accepted build", () => {
    expect(
      startupSettlement({
        decision: decide("exited", target, running),
        helper: "ended",
      }),
    ).toEqual({ ok: false, code: "UPDATE_RECOVERY_IDENTITY_MISMATCH" });
    expect(
      startupSettlement({
        decision: decide("exited", source, targetRun),
        helper: "ended",
      }),
    ).toEqual({ ok: false, code: "UPDATE_RECOVERY_IDENTITY_MISMATCH" });
  });
});

describe("restore exit witness", () => {
  const pending = { priorPhase: "verified", installedBefore: source };
  it("applies when the journal did not move and the build did not change", () => {
    expect(
      restoreExitWitnessApplies({
        pending,
        journalPhase: "verified",
        current: source,
      }),
    ).toBe(true);
  });
  it.each([
    ["no restore", null, "verified", source],
    ["a moved journal", pending, "completed", source],
    ["no journal", pending, undefined, source],
    ["a changed build", pending, "verified", target],
    [
      "no recorded build",
      { priorPhase: "verified", installedBefore: undefined },
      "verified",
      source,
    ],
  ])("does not apply with %s", (_name, p, journalPhase, current) => {
    expect(
      restoreExitWitnessApplies({ pending: p, journalPhase, current }),
    ).toBe(false);
  });
});

describe("rollback availability", () => {
  const requires = (_source: string, _target: string) => false;
  it("is offered for a completed operation with its preserved source", () => {
    expect(
      rollbackVersionFor({
        phase: "completed",
        predecessor: source,
        operation,
        requiresStateRecovery: requires,
      }),
    ).toBe(source.version);
  });
  it("is never offered after a rollback", () => {
    expect(
      rollbackVersionFor({
        phase: "rolled_back",
        predecessor: source,
        operation,
        requiresStateRecovery: requires,
      }),
    ).toBeUndefined();
  });
  it("is not offered without a matching preserved predecessor", () => {
    for (const predecessor of [null, other, target])
      expect(
        rollbackVersionFor({
          phase: "completed",
          predecessor,
          operation,
          requiresStateRecovery: requires,
        }),
      ).toBeUndefined();
  });
  it("is not offered when the predecessor needs state recovery", () => {
    const seen: string[][] = [];
    expect(
      rollbackVersionFor({
        phase: "completed",
        predecessor: source,
        operation,
        requiresStateRecovery: (from, to) => {
          seen.push([from, to]);
          return true;
        },
      }),
    ).toBeUndefined();
    expect(seen).toEqual([[source.version, target.version]]);
  });
  it("asks about state recovery only for a matching predecessor", () => {
    let asked = 0;
    rollbackVersionFor({
      phase: "completed",
      predecessor: other,
      operation,
      requiresStateRecovery: () => {
        asked += 1;
        return false;
      },
    });
    expect(asked).toBe(0);
  });
});

describe("settled receipt", () => {
  const retained = {
    schema: "farol.ready-update/1" as const,
    handle: "h",
    manifest: { a: 1 },
    operation,
  };
  const saved = {
    ...retained,
    observedAt: "2026-01-01T00:00:00.000Z",
    phase: "completed" as const,
    runningBuildId: d("9"),
  };
  const input = {
    fromReady: false,
    restorePending: false,
    saved,
    retained,
    phase: "completed" as const,
    runningBuildId: d("9"),
  };
  it("is unchanged when re-observation would rewrite the same bytes", () => {
    expect(settledReceiptUnchanged(input)).toBe(true);
  });
  it.each([
    ["from a ready record", { fromReady: true }],
    ["with a restore pending", { restorePending: true }],
    ["without a saved receipt", { saved: null }],
    ["with another phase", { phase: "rolled_back" as const }],
    ["with another running build", { runningBuildId: d("8") }],
    ["with changed retained bytes", { retained: { ...retained, handle: "g" } }],
  ])("is changed %s", (_name, change) => {
    expect(settledReceiptUnchanged({ ...input, ...change })).toBe(false);
  });
});

describe("rolled-back apply", () => {
  const input = {
    fromReady: true,
    restorePending: false,
    current: source,
    source,
  };
  it("reports a ready apply that left the source installed", () => {
    expect(applyRolledBack(input)).toBe(true);
  });
  it.each([
    ["not from a ready record", { fromReady: false }],
    ["with a restore pending", { restorePending: true }],
    ["with the target installed", { current: target }],
  ])("does not report %s", (_name, change) => {
    expect(applyRolledBack({ ...input, ...change })).toBe(false);
  });
});

describe("retained archive reclamation", () => {
  const manifest = {
    buildVersion: "100",
    buildId: d("b"),
    sourceCommit: "c".repeat(40),
    sourceTreeDigest: d("t"),
    artifactSha256: d("a"),
  };
  const run = {
    buildVersion: "100",
    buildId: d("b"),
    sourceCommit: "c".repeat(40),
    sourceTreeDigest: d("t"),
  };
  const relation = (
    order: number | null,
    m = manifest,
    r = run,
    installedDigest = d("a"),
  ) =>
    retainedBuildRelation({ order, manifest: m, running: r, installedDigest });

  it("recognises the exact installed build", () => {
    expect(relation(0)).toBe("exact");
  });
  it.each([
    ["another build number", { buildVersion: "101" }],
    ["another build id", { buildId: d("9") }],
    ["another commit", { sourceCommit: "d".repeat(40) }],
    ["another tree", { sourceTreeDigest: d("u") }],
    ["another archive", { artifactSha256: d("9") }],
  ])("is not exact with %s", (_name, change) => {
    expect(relation(0, { ...manifest, ...change })).toBe("other");
  });
  it("is not exact when the installed tree differs", () => {
    expect(relation(0, manifest, run, d("9"))).toBe("other");
  });
  it("recognises an older retained build only by both orders", () => {
    expect(relation(-1, { ...manifest, buildVersion: "99" })).toBe("older");
    expect(relation(-1, { ...manifest, buildVersion: "100" })).toBe("other");
    expect(relation(-1, { ...manifest, buildVersion: "101" })).toBe("other");
    expect(relation(1, { ...manifest, buildVersion: "99" })).toBe("other");
    expect(relation(null, { ...manifest, buildVersion: "99" })).toBe("other");
  });

  const reclaim = {
    fromReady: true,
    retained: {
      operation: null,
      preparation: undefined,
      helper: null,
      archiveReleased: undefined,
    },
    hasDownloadIntent: false,
    repository: "legrch/farol",
    channel: "stable",
    expectedChannel: "stable",
    relation: "exact" as const,
  };
  it("reclaims an exact or older ready-only archive", () => {
    expect(retainedReadyReclaimable(reclaim)).toBe(true);
    expect(retainedReadyReclaimable({ ...reclaim, relation: "older" })).toBe(
      true,
    );
    expect(
      retainedReadyReclaimable({
        ...reclaim,
        retained: { ...reclaim.retained, helper: undefined },
      }),
    ).toBe(true);
  });
  it.each([
    ["an unrelated build", { relation: "other" as const }],
    ["not from a ready record", { fromReady: false }],
    ["a download intent", { hasDownloadIntent: true }],
    ["another repository", { repository: "someone/else" }],
    ["another channel", { channel: "owner-beta" }],
    ["an operation", { retained: { ...reclaim.retained, operation } as never }],
    [
      "a preparation",
      { retained: { ...reclaim.retained, preparation: operation } },
    ],
    [
      "a helper",
      {
        retained: {
          ...reclaim.retained,
          helper: { pid: 7, processStart: null },
        },
      },
    ],
    [
      "a released archive",
      { retained: { ...reclaim.retained, archiveReleased: true } },
    ],
  ])("keeps the archive with %s", (_name, change) => {
    expect(retainedReadyReclaimable({ ...reclaim, ...change })).toBe(false);
  });
});

describe("candidate selection", () => {
  it("skips only the version the owner chose to skip", () => {
    expect(candidateSkipped("1.2.4", "1.2.4")).toBe(true);
    expect(candidateSkipped("1.2.5", "1.2.4")).toBe(false);
    expect(candidateSkipped("1.2.4", undefined)).toBe(false);
    expect(candidateSkipped(undefined, "1.2.4")).toBe(false);
  });
  it("defers a declined build or a deferred version", () => {
    const input = {
      buildId: d("1"),
      version: "1.2.4",
      declinedBuildId: null,
      deferredVersion: null,
    };
    expect(candidateDeferred(input)).toBe(false);
    expect(candidateDeferred({ ...input, declinedBuildId: d("1") })).toBe(true);
    expect(candidateDeferred({ ...input, declinedBuildId: d("2") })).toBe(
      false,
    );
    expect(candidateDeferred({ ...input, deferredVersion: "1.2.4" })).toBe(
      true,
    );
    expect(candidateDeferred({ ...input, deferredVersion: "1.2.3" })).toBe(
      false,
    );
    expect(candidateDeferred({ ...input, deferredVersion: undefined })).toBe(
      false,
    );
  });
});

describe("apply entry", () => {
  const ready = {
    releaseUnconfirmed: false,
    admissionHeld: false,
    operationActive: false,
    retainedOperation: false,
    retainedPreparation: false,
    packageReady: true,
    goCoreRequired: false,
    supervised: false,
    lifetimeAvailable: () => true,
  };
  it("proceeds when nothing refuses", () => {
    expect(applyEntryRefusal(ready)).toBeNull();
    expect(
      applyEntryRefusal({
        ...ready,
        supervised: true,
        lifetimeAvailable: () => false,
      }),
    ).toBeNull();
  });
  it.each([
    [
      "an unconfirmed browser release",
      { releaseUnconfirmed: true },
      { status: "blocked", code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" },
    ],
    [
      "a held admission",
      { admissionHeld: true },
      { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" },
    ],
    [
      "an active operation",
      { operationActive: true },
      { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" },
    ],
    [
      "a retained operation",
      { retainedOperation: true },
      { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" },
    ],
    [
      "a retained preparation",
      { retainedPreparation: true },
      { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" },
    ],
    [
      "no ready package",
      { packageReady: false },
      { status: "blocked", code: "UPDATE_PACKAGE_NOT_READY" },
    ],
    [
      "a build without its Go core",
      { goCoreRequired: true },
      { status: "blocked", code: "UPDATE_HELPER_GO_CORE_REQUIRED" },
    ],
    [
      "no helper lifetime",
      { lifetimeAvailable: () => false },
      { status: "blocked", code: "UPDATE_HELPER_LIFETIME_UNAVAILABLE" },
    ],
  ])("refuses with %s", (_name, change, expected) => {
    expect(applyEntryRefusal({ ...ready, ...change })).toEqual(expected);
  });

  it("keeps the order of the checks", () => {
    const all = {
      releaseUnconfirmed: true,
      admissionHeld: true,
      operationActive: true,
      retainedOperation: true,
      retainedPreparation: true,
      packageReady: false,
      goCoreRequired: true,
      supervised: false,
      lifetimeAvailable: () => false,
    };
    expect(applyEntryRefusal(all)?.code).toBe(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    expect(applyEntryRefusal({ ...all, releaseUnconfirmed: false })?.code).toBe(
      "UPDATE_HANDOFF_UNRECONCILED",
    );
    expect(
      applyEntryRefusal({
        ...all,
        releaseUnconfirmed: false,
        admissionHeld: false,
        operationActive: false,
        retainedOperation: false,
        retainedPreparation: false,
      })?.code,
    ).toBe("UPDATE_PACKAGE_NOT_READY");
    expect(
      applyEntryRefusal({
        ...all,
        releaseUnconfirmed: false,
        admissionHeld: false,
        operationActive: false,
        retainedOperation: false,
        retainedPreparation: false,
        packageReady: true,
      })?.code,
    ).toBe("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it("reads the helper lifetime only when nothing earlier refused", () => {
    let reads = 0;
    const lifetimeAvailable = () => {
      reads += 1;
      return true;
    };
    applyEntryRefusal({ ...ready, goCoreRequired: true, lifetimeAvailable });
    applyEntryRefusal({ ...ready, supervised: true, lifetimeAvailable });
    expect(reads).toBe(0);
    applyEntryRefusal({ ...ready, lifetimeAvailable });
    expect(reads).toBe(1);
  });
});

describe("restart confirmation", () => {
  const input = {
    confirmation: { kind: "interrupt-browser", version: "1.2.4" },
    quitApply: false,
    updateVersion: "1.2.4",
    retainedVersion: "1.2.4" as string | null,
  };
  it("is current for the browser interrupt of this very update", () => {
    expect(confirmationStale(input)).toBe(false);
  });
  it.each([
    ["a quit apply", { quitApply: true }],
    [
      "another kind",
      { confirmation: { kind: "something-else", version: "1.2.4" } },
    ],
    [
      "another confirmed version",
      { confirmation: { kind: "interrupt-browser", version: "1.2.5" } },
    ],
    ["another update version", { updateVersion: "1.2.5" }],
    ["an unreadable retained manifest", { retainedVersion: null }],
    ["another retained version", { retainedVersion: "1.2.5" }],
  ])("is stale with %s", (_name, change) => {
    expect(confirmationStale({ ...input, ...change })).toBe(true);
  });
});

describe("quit deadline arithmetic", () => {
  it("expires at the deadline, not before", () => {
    expect(quitDeadlineExpired(999, 1000)).toBe(false);
    expect(quitDeadlineExpired(1000, 1000)).toBe(true);
    expect(quitDeadlineExpired(1001, 1000)).toBe(true);
  });
  it("treats a clock that is not finite as expired", () => {
    expect(quitDeadlineExpired(Number.NaN, 1000)).toBe(true);
    expect(quitDeadlineExpired(Number.POSITIVE_INFINITY, 1000)).toBe(true);
    expect(quitDeadlineExpired(Number.NEGATIVE_INFINITY, 1000)).toBe(true);
  });
  it("floors a timer at one millisecond and caps it at the timer limit", () => {
    expect(quitTimerDelayMs(1000, 1500)).toBe(500);
    expect(quitTimerDelayMs(1000, 1001)).toBe(1);
    expect(quitTimerDelayMs(1000, 1000)).toBe(1);
    expect(quitTimerDelayMs(1000, 500)).toBe(1);
    expect(quitTimerDelayMs(0, 2_147_483_647)).toBe(2_147_483_647);
    expect(quitTimerDelayMs(0, 2_147_483_648)).toBe(2_147_483_647);
    expect(quitTimerDelayMs(0, 1e15)).toBe(2_147_483_647);
  });
  it("caps the launcher readiness budget at five minutes", () => {
    expect(readinessTimeoutMs(1000, 1500)).toBe(500);
    expect(readinessTimeoutMs(1000, 1000)).toBe(1);
    expect(readinessTimeoutMs(1000, 0)).toBe(1);
    expect(readinessTimeoutMs(0, 300_000)).toBe(300_000);
    expect(readinessTimeoutMs(0, 300_001)).toBe(300_000);
  });
});

describe("helper launch outcomes", () => {
  it("names a confirmed no-effect launch by its own status", () => {
    expect(helperNoEffectCode("refused")).toBe("UPDATE_HELPER_REFUSED");
    expect(helperNoEffectCode("not_started")).toBe("UPDATE_HELPER_NOT_STARTED");
  });

  const clean = {
    status: "terminal",
    result: {
      code: 0,
      signal: null,
      protocolError: null,
      terminal: { phase: "verified", error: null },
    },
  };
  describe("an ordinary owner", () => {
    it("is admitted only by a ready launch", () => {
      expect(handoffAdmitted({ status: "ready" }, false)).toBe(true);
      for (const status of [
        "continued",
        "terminal",
        "refused",
        "not_started",
        "outcome_unknown",
      ])
        expect(handoffAdmitted({ status }, false)).toBe(false);
      expect(handoffAdmitted(clean, false)).toBe(false);
    });
  });
  describe("a supervised owner", () => {
    it("is admitted by a continued launch or a clean verified exit", () => {
      expect(handoffAdmitted({ status: "continued" }, true)).toBe(true);
      expect(handoffAdmitted(clean, true)).toBe(true);
    });
    it("is not admitted by a ready launch or any unknown outcome", () => {
      for (const status of [
        "ready",
        "refused",
        "not_started",
        "outcome_unknown",
      ])
        expect(handoffAdmitted({ status }, true)).toBe(false);
    });
    it.each([
      ["a non-zero code", { code: 1 }],
      ["no exit code", { code: null }],
      ["a signal", { signal: "SIGKILL" }],
      ["a protocol error", { protocolError: "bad frame" }],
      ["no terminal record", { terminal: null }],
      ["another phase", { terminal: { phase: "completed", error: null } }],
      [
        "a terminal error",
        { terminal: { phase: "verified", error: "failed" } },
      ],
    ])("is not admitted by a terminal exit with %s", (_name, change) => {
      expect(
        handoffAdmitted(
          { status: "terminal", result: { ...clean.result, ...change } },
          true,
        ),
      ).toBe(false);
    });
    it("is not admitted by a terminal status without a result", () => {
      expect(handoffAdmitted({ status: "terminal" }, true)).toBe(false);
    });
  });

  it("keeps an unadmitted handoff unknown, naming only a refusal", () => {
    expect(unadmittedHandoff("refused")).toEqual({
      status: "unknown",
      code: "UPDATE_HELPER_REFUSED",
    });
    for (const status of [
      "outcome_unknown",
      "terminal",
      "not_started",
      "ready",
    ])
      expect(unadmittedHandoff(status)).toEqual({
        status: "unknown",
        code: "UPDATE_HANDOFF_UNKNOWN",
      });
  });

  it("stays unknown once admission was kept, blocked otherwise", () => {
    expect(quitFailureHandoff(true)).toEqual({
      status: "unknown",
      code: "UPDATE_QUIT_OUTCOME_UNKNOWN",
    });
    expect(quitFailureHandoff(false)).toEqual({
      status: "blocked",
      code: "UPDATE_QUIT_DEADLINE_EXPIRED",
    });
    expect(prepareFailureHandoff(true)).toEqual({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    expect(prepareFailureHandoff(false)).toEqual({
      status: "blocked",
      code: "UPDATE_PREPARE_FAILED",
    });
    expect(restoreFailureHandoff(true)).toEqual({
      status: "unknown",
      code: "UPDATE_RESTORE_OUTCOME_UNKNOWN",
    });
    expect(restoreFailureHandoff(false)).toEqual({
      status: "blocked",
      code: "UPDATE_RESTORE_PREPARE_FAILED",
    });
    expect(applyUnsettledCode(true)).toBe("UPDATE_HANDOFF_UNKNOWN");
    expect(applyUnsettledCode(false)).toBe("UPDATE_STAGING_OUTCOME_UNKNOWN");
  });

  it("never reports an unknown outcome as retryable-blocked while kept", () => {
    for (const refusal of [
      quitFailureHandoff(true),
      prepareFailureHandoff(true),
      restoreFailureHandoff(true),
      unadmittedHandoff("outcome_unknown"),
      verificationHandoff("outcome_unknown"),
    ])
      expect(refusal.status).toBe("unknown");
  });
});
