import { describe, expect, it } from "vitest";

import {
  agentRouteReadiness,
  agentVerifyStepPresentation,
  connectorChoosePrerequisite,
  connectorStartPrerequisite,
  connectorStopPrerequisite,
  computerVerificationStale,
  readinessDetail,
  readinessLabel,
  nativeHostActionPrerequisite,
  routeReadiness,
  routeRowDetail,
  routeRowLabel,
  setupConnectPrimary,
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

// The fifth condition on "Start & check" is the one the row never showed:
// the connector serves an approved workspace, and Computer is where those
// live, so a fully configured tunnel still cannot start without one.
describe("why the connection cannot start yet", () => {
  const ready = {
    tunnelClient: { version: "1.2.3" },
    tunnelId: "tunnel_abc",
    credential: "stored" as const,
    runtime: null,
  };

  it("has nothing left to say once every prerequisite is met", () => {
    expect(connectorStartPrerequisite(ready, 1, false)).toBeNull();
  });

  it("names the approved workspace, which is the one the row never showed", () => {
    const reason = connectorStartPrerequisite(ready, 0, false);
    expect(reason).toContain("Approve at least one workspace");
    expect(reason).toContain("Computer");
  });

  it("names the earliest unmet prerequisite, in the order the owner meets them", () => {
    expect(
      connectorStartPrerequisite({ ...ready, tunnelClient: null }, 0, false),
    ).toBe("Choose the tunnel client first.");
    expect(
      connectorStartPrerequisite({ ...ready, tunnelId: null }, 0, false),
    ).toBe("Enter the tunnel ID and save the route first.");
    expect(
      connectorStartPrerequisite({ ...ready, credential: "missing" }, 0, false),
    ).toBe("Save the runtime key for this tunnel first.");
  });

  it("explains a running connector rather than a missing prerequisite", () => {
    expect(
      connectorStartPrerequisite(
        { ...ready, runtime: { state: "ready" } },
        1,
        false,
      ),
    ).toBe("The connector is already running.");
  });

  it("lets a running connector be pressed while its attachment is unchecked", () => {
    expect(
      connectorStartPrerequisite(
        { ...ready, runtime: { state: "ready" } },
        1,
        true,
      ),
    ).toBeNull();
  });

  it("lets an outcome-unknown runtime be repaired", () => {
    expect(
      connectorStartPrerequisite(
        { ...ready, runtime: { state: "outcome_unknown" } },
        1,
        false,
      ),
    ).toBeNull();
  });
});

describe("why a connection or host control cannot be used yet", () => {
  it("explains that a running connector is what blocks replacing its client", () => {
    expect(connectorChoosePrerequisite(true)).toBe(
      "Stop the connector before replacing its client.",
    );
    expect(connectorChoosePrerequisite(false)).toBeNull();
  });

  it("explains that there is nothing to stop", () => {
    expect(connectorStopPrerequisite(false)).toBe(
      "The connector is not running.",
    );
    expect(connectorStopPrerequisite(true)).toBeNull();
  });

  it("names the missing host once, for whichever action asked", () => {
    for (const action of ["recheck", "remove"]) {
      expect(nativeHostActionPrerequisite(false, action)).toBe(
        `Choose a Codex executable before you ${action} it.`,
      );
      expect(nativeHostActionPrerequisite(true, action)).toBeNull();
    }
  });
});

describe("Setup's own primary action on the Connect step", () => {
  const saved = {
    tunnelClient: { version: "1.2.3" },
    tunnelId: "tunnel_abc",
    credential: "stored" as const,
    runtime: null,
    challenge: null,
  };

  it("does not offer to start what the backend will refuse", () => {
    // The approved workspace is the condition this step used to omit while
    // Settings' sibling already enforced it. With none, Setup offered
    // "Start & check" and pressing it was refused.
    const withoutWorkspace = setupConnectPrimary(saved, 0);
    expect(withoutWorkspace.label).toBe("Start & check");
    expect(withoutWorkspace.disabled).toBe(true);
    expect(withoutWorkspace.reason).toContain("Approve at least one workspace");
  });

  it("offers it once a workspace exists", () => {
    const ready = setupConnectPrimary(saved, 1);
    expect(ready).toEqual({
      hidden: false,
      label: "Start & check",
      disabled: false,
      reason: null,
    });
  });

  it("keeps saving the route available before any workspace exists", () => {
    // The workspace belongs to starting, not to saving; a step that refused
    // to save the route until a workspace existed would be a new dead end.
    for (const unsaved of [
      { ...saved, tunnelId: null },
      { ...saved, credential: "missing" as const },
    ]) {
      const primary = setupConnectPrimary(unsaved, 0);
      expect(primary.label).toBe("Save connector");
      expect(primary.disabled).toBe(false);
    }
  });

  it("hides itself with no client chosen", () => {
    expect(
      setupConnectPrimary({ ...saved, tunnelClient: null }, 1).hidden,
    ).toBe(true);
  });

  it("keeps the captions it had, each agreeing with its own disabled flag", () => {
    const running = setupConnectPrimary(
      { ...saved, runtime: { state: "ready" } },
      1,
    );
    expect(running.label).toBe("Connection verified");
    expect(running.disabled).toBe(true);
    expect(running.reason).toBe("The connector is already running.");

    const pending = setupConnectPrimary(
      { ...saved, runtime: { state: "ready" }, challenge: {} },
      1,
    );
    expect(pending.label).toBe("Check attachment");
    expect(pending.disabled).toBe(false);

    const unknown = setupConnectPrimary(
      { ...saved, runtime: { state: "outcome_unknown" } },
      1,
    );
    expect(unknown.label).toBe("Repair explicitly");
    expect(unknown.disabled).toBe(false);
  });
});

describe("a connections row's words against its own tone", () => {
  const verified = {
    ...readiness,
    needsAction: null,
    verified: verifiedRecord,
  };

  it("never says Verified for a route whose merged state is unknown", () => {
    // The Native Agent row's tone comes from agentRouteReadiness, which
    // checks outcome-unknown across BOTH halves of the Codex route. Its
    // words came from the verify record alone, which can still hold a proof.
    expect(routeRowLabel("outcome-unknown", verified)).toBe("Outcome unknown");
    expect(routeRowDetail("outcome-unknown", verified)).toContain(
      "unknown outcome",
    );
  });

  it("never says Verified for a route whose verification has gone stale", () => {
    expect(routeRowLabel("action-required", verified)).toBe("Verify again");
    expect(routeRowDetail("action-required", verified)).toContain(
      "no longer matches",
    );
  });

  it("says Verified exactly when the merged state is ready", () => {
    expect(routeRowLabel("ready", verified)).toBe("Verified");
    expect(routeRowDetail("ready", verified)).toMatch(/^Verified /u);
  });

  it("keeps the nuance the state alone cannot express", () => {
    expect(
      routeRowLabel("failed", {
        ...readiness,
        needsAction: null,
        unavailable: "No host.",
      }),
    ).toBe("Unavailable");
    expect(
      routeRowLabel("failed", {
        ...readiness,
        needsAction: null,
        reachable: "unreachable",
      }),
    ).toBe("Unreachable");
    expect(
      routeRowLabel("action-required", { ...blank, reachable: "reachable" }),
    ).toBe("Reachable · verify");
    expect(
      routeRowLabel("action-required", { ...blank, configured: true }),
    ).toBe("Configured · verify");
    expect(routeRowLabel("not-configured", blank)).toBe("Needs action");
  });

  it("agrees with the tone for every state a route can be in", () => {
    // The contradiction this replaces was exactly one word appearing under
    // the wrong tone, so the invariant is worth stating directly.
    for (const state of [
      "not-configured",
      "action-required",
      "failed",
      "outcome-unknown",
    ] as const) {
      expect(routeRowLabel(state, verified)).not.toBe("Verified");
    }
  });
});

describe("Setup's verify step, sentence and button together", () => {
  const base = {
    outcomeUnknown: false,
    proof: null,
    needsRejoin: false,
    prerequisitesReady: true,
  };
  const proof = { model: "gpt-6-astra", workspaceEnforcement: "verified" };

  it("does not offer a rejoin under a sentence telling the owner not to", () => {
    // The sentence tested outcomeUnknown and the caption did not test it at
    // all, so this exact state showed "Rejoin Agent" beneath "Inspect the
    // existing Codex task before deliberate recovery."
    const shown = agentVerifyStepPresentation({
      ...base,
      outcomeUnknown: true,
      needsRejoin: true,
    });
    expect(shown.summary).toContain("Inspect the existing Codex task");
    expect(shown.label).toBe("Agent outcome unknown");
    expect(shown.disabled).toBe(true);
  });

  it("puts an unknown outcome ahead of an earlier proof", () => {
    const shown = agentVerifyStepPresentation({
      ...base,
      outcomeUnknown: true,
      proof,
    });
    expect(shown.label).toBe("Agent outcome unknown");
    expect(shown.summary).toContain("unknown");
  });

  it("keeps the proof wording and its two enforcement cases", () => {
    expect(agentVerifyStepPresentation({ ...base, proof }).summary).toContain(
      "verified native workspace enforcement",
    );
    expect(
      agentVerifyStepPresentation({
        ...base,
        proof: { ...proof, workspaceEnforcement: "not_verified" },
      }).summary,
    ).toContain("remains not verified");
    expect(agentVerifyStepPresentation({ ...base, proof }).disabled).toBe(true);
  });

  it("offers a rejoin only once its prerequisites are met", () => {
    expect(
      agentVerifyStepPresentation({ ...base, needsRejoin: true }).disabled,
    ).toBe(false);
    expect(
      agentVerifyStepPresentation({
        ...base,
        needsRejoin: true,
        prerequisitesReady: false,
      }).disabled,
    ).toBe(true);
  });

  it("keeps the two remaining captions and their sentences", () => {
    expect(agentVerifyStepPresentation(base)).toEqual({
      summary:
        "Ready to verify lineage, unchanged TaskGrant transport, bounded same-child rejoin and durable parent delivery.",
      label: "Verify Agent",
      disabled: false,
    });
    expect(
      agentVerifyStepPresentation({ ...base, prerequisitesReady: false }),
    ).toEqual({
      summary: "Run the live Codex host check and verify one workspace first.",
      label: "Verify Agent",
      disabled: true,
    });
  });
});
