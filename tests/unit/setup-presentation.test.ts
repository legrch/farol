import { describe, expect, it } from "vitest";

import {
  agentRouteReadiness,
  computerVerificationStale,
  readinessDetail,
  readinessLabel,
  routeReadiness,
  setupStepStale,
  waitsForAgentRejoin,
  windowModeLabel,
  workspaceAccessLabel,
} from "../../src/ui/setup-presentation";

const readiness = {
  visited: true,
  skipped: false,
  configured: true,
  reachable: "unknown" as const,
  verified: null,
  needsAction: "Anything the copy says today.",
  unavailable: null,
  outcomeUnknown: false,
};

const blank = {
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown" as const,
  verified: null,
  needsAction: null,
  unavailable: null,
  outcomeUnknown: false,
};

const verifiedRecord = {
  profile: "computer.local.read/1",
  configRevision: 1,
  workspaceId: null,
  runtimeGeneration: "runtime",
  buildId: "a".repeat(64),
  protocol: "readonly-workspace/1",
  verifiedAt: "2026-01-01T00:00:00.000Z",
};

describe("setup presentation", () => {
  it("OUX-07 labels a rejoin from the typed recovery, not the wording", () => {
    expect(
      waitsForAgentRejoin({ ...readiness, recovery: "rejoin_agent" }),
    ).toBe(true);
    expect(
      waitsForAgentRejoin({
        ...readiness,
        needsAction: "Rejoin the same native Agent assignment.",
      }),
    ).toBe(false);
  });

  it("OUX-04 reports a verified route with zero tasks as ready", () => {
    expect(
      windowModeLabel({ demoMode: false, taskCount: 0, chatGptReady: true }),
    ).toBe("Local preview · ready for a new task");
    expect(
      windowModeLabel({ demoMode: false, taskCount: 0, chatGptReady: false }),
    ).toBe("Local preview · no task route configured");
    expect(
      windowModeLabel({ demoMode: false, taskCount: 2, chatGptReady: true }),
    ).toBe("Local preview · isolated ChatGPT tasks");
  });

  it("OUX-03 shows each workspace's effective access", () => {
    expect(workspaceAccessLabel({ access: "write" }, "none")).toBe(
      "guarded edits",
    );
    expect(workspaceAccessLabel({ access: "read" }, "none")).toBe("read-only");
    expect(workspaceAccessLabel({ access: "read" }, "verification")).toBe(
      "read-only · fixed Git checks",
    );
  });

  // UX34-03/04: one pure function is the single source of truth for whether
  // a route can be used right now. The header, New task control, Setup
  // checklist and Settings each call this instead of inlining their own
  // predicate, so they cannot silently drift out of agreement again.
  describe("routeReadiness", () => {
    it("reports an untouched route as not-configured", () => {
      expect(routeReadiness(blank)).toBe("not-configured");
    });

    it("reports a reachable-but-unverified route as action-required", () => {
      expect(routeReadiness({ ...blank, reachable: "reachable" })).toBe(
        "action-required",
      );
    });

    it("reports a configured-but-unverified route as action-required", () => {
      expect(routeReadiness({ ...blank, configured: true })).toBe(
        "action-required",
      );
    });

    it("reports an explicit needsAction as action-required even before configured/reachable flip", () => {
      expect(
        routeReadiness({ ...blank, needsAction: "Do the one required thing." }),
      ).toBe("action-required");
    });

    it("reports a verified route as ready", () => {
      expect(routeReadiness({ ...blank, verified: verifiedRecord })).toBe(
        "ready",
      );
    });

    it("reports a stale verification as action-required, never ready or not-configured", () => {
      expect(
        routeReadiness({ ...blank, verified: verifiedRecord }, { stale: true }),
      ).toBe("action-required");
    });

    it("reports unavailable as failed even when previously configured", () => {
      expect(
        routeReadiness({
          ...blank,
          configured: true,
          unavailable: "The route could not be reached.",
        }),
      ).toBe("failed");
    });

    it("reports an unreachable route as failed", () => {
      expect(routeReadiness({ ...blank, reachable: "unreachable" })).toBe(
        "failed",
      );
    });

    it("reports outcomeUnknown as outcome-unknown even when otherwise verified", () => {
      expect(
        routeReadiness({
          ...blank,
          verified: verifiedRecord,
          outcomeUnknown: true,
        }),
      ).toBe("outcome-unknown");
    });

    it("reports checking whenever an operation is explicitly in flight, overriding every other field", () => {
      expect(
        routeReadiness(
          { ...blank, verified: verifiedRecord, outcomeUnknown: true },
          { checking: true },
        ),
      ).toBe("checking");
    });
  });

  describe("agentRouteReadiness", () => {
    it("reports not-configured when neither the host nor the Agent check has started", () => {
      expect(agentRouteReadiness(blank, blank)).toBe("not-configured");
    });

    it("reports action-required once the host is reachable but not yet verified", () => {
      expect(
        agentRouteReadiness({ ...blank, reachable: "reachable" }, blank),
      ).toBe("action-required");
    });

    it("reports action-required once the host is verified but the Agent lineage check has not run", () => {
      expect(
        agentRouteReadiness({ ...blank, verified: verifiedRecord }, blank),
      ).toBe("action-required");
    });

    it("reports ready only once the Agent lineage check itself is verified", () => {
      expect(
        agentRouteReadiness(
          { ...blank, verified: verifiedRecord },
          { ...blank, verified: verifiedRecord },
        ),
      ).toBe("ready");
    });

    it("reports failed when the host is unreachable, even before any verification", () => {
      expect(
        agentRouteReadiness({ ...blank, reachable: "unreachable" }, blank),
      ).toBe("failed");
    });

    it("reports failed when the host is unavailable despite a stale prior verify record", () => {
      expect(
        agentRouteReadiness(
          { ...blank, unavailable: "The executable disappeared." },
          { ...blank, verified: verifiedRecord },
        ),
      ).toBe("ready"); // a verified Agent lineage record always wins
      expect(
        agentRouteReadiness(
          { ...blank, unavailable: "The executable disappeared." },
          blank,
        ),
      ).toBe("failed");
    });

    it("reports outcome-unknown when either half is outcome-unknown, even if the other half is verified", () => {
      expect(
        agentRouteReadiness(
          { ...blank, verified: verifiedRecord },
          { ...blank, outcomeUnknown: true },
        ),
      ).toBe("outcome-unknown");
      expect(
        agentRouteReadiness(
          { ...blank, outcomeUnknown: true },
          { ...blank, verified: verifiedRecord },
        ),
      ).toBe("outcome-unknown");
    });

    it("reports checking whenever an operation is explicitly in flight", () => {
      expect(agentRouteReadiness(blank, blank, { checking: true })).toBe(
        "checking",
      );
    });
  });
});

// The label and the state must never disagree. Both of these situations used
// to read "Verified": an attempt that ended with an unknown outcome on a
// route that had been verified before, and a verification the current setup
// has outgrown. Each is the state model being contradicted by the sentence
// printed next to it.
describe("what the owner reads beside a route's state", () => {
  const verified = {
    ...readiness,
    needsAction: null,
    verified: verifiedRecord,
  };

  it("never calls an unknown outcome verified, whatever was proven before", () => {
    const unknown = { ...verified, outcomeUnknown: true };
    expect(routeReadiness(unknown)).toBe("outcome-unknown");
    expect(readinessLabel(unknown)).toBe("Outcome unknown");
    expect(readinessDetail(unknown)).toContain("unknown outcome");
    // The earlier proof is still mentioned, but as something that does not
    // describe this attempt — never as the attempt's own result.
    expect(readinessDetail(unknown)).toContain("does not describe it");
  });

  it("says so even when nothing was ever verified", () => {
    const unknown = { ...readiness, outcomeUnknown: true };
    expect(readinessLabel(unknown)).toBe("Outcome unknown");
    expect(readinessDetail(unknown)).toBe(
      "The last attempt ended with an unknown outcome.",
    );
  });

  it("agrees with the amber state when a verification has gone stale", () => {
    expect(routeReadiness(verified, { stale: true })).toBe("action-required");
    expect(readinessLabel(verified, { stale: true })).toBe("Verify again");
    expect(readinessDetail(verified, { stale: true })).toContain(
      "no longer matches",
    );
  });

  it("still reads verified when the verification is current", () => {
    expect(routeReadiness(verified)).toBe("ready");
    expect(readinessLabel(verified)).toBe("Verified");
    expect(readinessDetail(verified)).toMatch(/^Verified /u);
  });

  it("keeps every label in step with the state for the remaining routes", () => {
    const cases = [
      [blank, {}, "not-configured", "Needs action"],
      [readiness, {}, "action-required", "Needs action"],
      [
        { ...readiness, needsAction: null, unavailable: "No host." },
        {},
        "failed",
        "Unavailable",
      ],
      [
        { ...readiness, needsAction: null, reachable: "unreachable" as const },
        {},
        "failed",
        "Unreachable",
      ],
      [
        { ...blank, reachable: "reachable" as const },
        {},
        "action-required",
        "Reachable · verify",
      ],
      [
        { ...blank, configured: true },
        {},
        "action-required",
        "Configured · verify",
      ],
    ] as const;
    for (const [record, options, state, label] of cases) {
      expect(routeReadiness(record, options)).toBe(state);
      expect(readinessLabel(record, options)).toBe(label);
    }
  });
});

// Setup and Settings must answer this from the same place. Settings computed
// it, Setup did not ask at all, so an outgrown verification showed amber in
// one surface and "Verified" with a completed progress dot in the other.
describe("one definition of a stale Computer verification", () => {
  const workspace = {
    workspaceId: "workspace-1",
    label: "Workspace",
    root: "/tmp/workspace",
    access: "read" as const,
    excludedPaths: [] as string[],
  };
  const verifiedHere = {
    ...verifiedRecord,
    workspaceId: workspace.workspaceId,
    configRevision: 7,
  };
  const computer = { ...readiness, needsAction: null, verified: verifiedHere };

  it("is not stale while the workspace and the generation both still match", () => {
    expect(computerVerificationStale(computer, [workspace], 7)).toBe(false);
  });

  it("is stale once the config generation has moved on", () => {
    expect(computerVerificationStale(computer, [workspace], 8)).toBe(true);
  });

  it("is stale when the verification names a different workspace", () => {
    expect(
      computerVerificationStale(
        computer,
        [{ ...workspace, workspaceId: "other" }],
        7,
      ),
    ).toBe(true);
  });

  it("is not stale when there is no workspace to have outgrown", () => {
    expect(computerVerificationStale(computer, [], 7)).toBe(false);
  });

  it("answers false, never undefined, for a step that has no staleness", () => {
    const settings = {
      setup: { computer },
      computer: { workspaces: [workspace], generation: 8 },
    } as unknown as Parameters<typeof setupStepStale>[0];
    expect(setupStepStale(settings, "computer")).toBe(true);
    for (const stepId of ["chatgpt", "connect", "hosts", "verify"]) {
      expect(setupStepStale(settings, stepId)).toBe(false);
    }
  });
});
