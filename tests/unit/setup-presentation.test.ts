import { describe, expect, it } from "vitest";

import {
  agentRouteReadiness,
  routeReadiness,
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
