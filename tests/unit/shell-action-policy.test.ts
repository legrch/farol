import { describe, expect, it } from "vitest";
import {
  AGENT_AUTHORITY_CHANGED,
  agentAuthorityUnchanged,
  completionMayNavigate,
  decideShellAction,
  type ShellActionContext,
  type ShellActionProvenance,
} from "../../src/ui/shell-action-policy";

const noProvenance: ShellActionProvenance = {
  eventId: null,
  source: null,
  authWindowGeneration: null,
};

const writing: ShellActionContext = {
  draftHeld: true,
  currentAuthWindowGeneration: null,
  handledEventIds: new Set(),
};

describe("what a shell action may do to an assignment being written", () => {
  it("keeps the editor and offers a way out when a background publisher fires", () => {
    // The owner's rule: a background completion, auth-window close or
    // runtime refresh must not tear down the editor solely to navigate.
    for (const source of ["auth-window-closed"]) {
      const decision = decideShellAction({ ...noProvenance, source }, writing);
      expect(decision.navigate, source).toBe(false);
      expect(decision.offerReturn, source).toBe(true);
      // Readiness is not optional. A background event still carries a real
      // outcome, and not reading it is how a revoked grant goes unnoticed.
      expect(decision.refreshReadiness, source).toBe(true);
      expect(decision.reason).toBe("background-publisher");
    }
  });

  it("ignores the navigation of an auth window older than the one held", () => {
    const decision = decideShellAction(
      {
        ...noProvenance,
        source: "auth-window-closed",
        authWindowGeneration: 1,
      },
      { ...writing, currentAuthWindowGeneration: 2 },
    );
    expect(decision.navigate).toBe(false);
    expect(decision.offerReturn).toBe(true);
    expect(decision.refreshReadiness).toBe(true);
    expect(decision.reason).toBe("stale-auth-window");
  });

  it("keeps the editor even for the current auth window's own close", () => {
    // A's facts corrected my first reading: that window can close without
    // the owner touching anything, and the owner's sentence names its close
    // directly. Being the current window does not make it a navigation.
    const decision = decideShellAction(
      {
        ...noProvenance,
        authWindowGeneration: 2,
        source: "auth-window-closed",
      },
      { ...writing, currentAuthWindowGeneration: 2 },
    );
    expect(decision.navigate).toBe(false);
    expect(decision.offerReturn).toBe(true);
    expect(decision.reason).toBe("background-publisher");
  });

  it("honours every owner publisher, and keeps the draft while doing it", () => {
    for (const source of [
      "settings-command",
      "quick-switcher-command",
      "overlay-dismissed",
    ]) {
      const decision = decideShellAction({ ...noProvenance, source }, writing);
      expect(decision.navigate, source).toBe(true);
      expect(decision.offerReturn, source).toBe(false);
      expect(decision.reason, source).toBe("owner-return");
    }
  });

  it("does today's navigation when there is no draft to protect", () => {
    const decision = decideShellAction(noProvenance, {
      ...writing,
      draftHeld: false,
    });
    expect(decision.navigate).toBe(true);
    expect(decision.offerReturn).toBe(false);
    expect(decision.reason).toBe("no-draft");
  });

  it("has no second effect for a proven duplicate", () => {
    const decision = decideShellAction(
      { ...noProvenance, eventId: "e-1" },
      { ...writing, handledEventIds: new Set(["e-1"]) },
    );
    expect(decision).toEqual({
      navigate: false,
      refreshReadiness: false,
      offerReturn: false,
      reason: "duplicate-event",
    });
  });

  it("treats two identical events without ids as two events", () => {
    // Only an id proves a duplicate. Dropping the second on a timer would
    // be a guess, and a dropped real event is a missed outcome.
    const first = decideShellAction(noProvenance, writing);
    const second = decideShellAction(noProvenance, writing);
    expect(second).toEqual(first);
    expect(second.refreshReadiness).toBe(true);
  });

  it("still acts on an event with no id after other events were handled", () => {
    // A mutation-found gap: a dedupe written as "have we handled anything"
    // rather than "have we handled THIS" passes every test whose handled set
    // is empty. An envelope with no id can never be proven a duplicate, so it
    // must be acted on however many ids came before it.
    const decision = decideShellAction(noProvenance, {
      ...writing,
      handledEventIds: new Set(["e-1", "e-2"]),
    });
    expect(decision.refreshReadiness).toBe(true);
    expect(decision.reason).not.toBe("duplicate-event");
  });

  it("acts on a new id even when other ids were handled", () => {
    const decision = decideShellAction(
      { ...noProvenance, eventId: "e-3" },
      { ...writing, handledEventIds: new Set(["e-1", "e-2"]) },
    );
    expect(decision.refreshReadiness).toBe(true);
    expect(decision.reason).not.toBe("duplicate-event");
  });

  it("keeps the editor when the envelope says nothing at all", () => {
    // The schema now requires a source, so this is unreachable from a real
    // publish. It is where a softened parse would land, and it must land on
    // the side that cannot lose the owner's work.
    const decision = decideShellAction(noProvenance, writing);
    expect(decision.navigate).toBe(false);
    expect(decision.offerReturn).toBe(true);
    expect(decision.reason).toBe("provenance-unknown");
  });
});

describe("whether a surviving assignment may still be run", () => {
  const grant = {
    workspaceId: "workspace-1",
    configGeneration: 4,
    hostExecutablePath: "/opt/codex",
  };

  it("runs when the grant it was written under has not moved", () => {
    expect(agentAuthorityUnchanged(grant, { ...grant })).toBe(true);
  });

  it("refuses when the workspace, the generation or the host changed", () => {
    expect(
      agentAuthorityUnchanged(grant, { ...grant, workspaceId: "workspace-2" }),
    ).toBe(false);
    expect(
      agentAuthorityUnchanged(grant, { ...grant, configGeneration: 5 }),
    ).toBe(false);
    expect(
      agentAuthorityUnchanged(grant, { ...grant, hostExecutablePath: null }),
    ).toBe(false);
  });

  it("refuses when either side has no grant at all", () => {
    // Revocation reads as an absent grant; preserving text is not
    // permission to execute stale input.
    expect(agentAuthorityUnchanged(grant, null)).toBe(false);
    expect(agentAuthorityUnchanged(null, grant)).toBe(false);
    expect(agentAuthorityUnchanged(null, null)).toBe(false);
  });

  it("has a sentence that says what changed and what to do", () => {
    expect(AGENT_AUTHORITY_CHANGED).toContain("workspace or host changed");
    expect(AGENT_AUTHORITY_CHANGED).toContain("run it again");
  });
});

describe("whether an awaited completion may still navigate", () => {
  it("finishes what it started when the surface has not moved", () => {
    expect(completionMayNavigate("none", "none")).toBe(true);
    expect(completionMayNavigate("task-menu", "task-menu")).toBe(true);
  });

  it("does not close an overlay opened while it was in flight", () => {
    // Measured: New task was pressed with nothing open, the route answered
    // 1.7 s later, and by then the owner had a task menu open with an Agent
    // assignment being typed. The handler closed it.
    expect(completionMayNavigate("none", "task-menu")).toBe(false);
  });

  it("does not navigate away from any surface the owner opened", () => {
    for (const now of [
      "task-menu",
      "quick-switcher",
      "context-preview",
      "sidebar",
    ]) {
      expect(completionMayNavigate("none", now), now).toBe(false);
    }
  });
});
