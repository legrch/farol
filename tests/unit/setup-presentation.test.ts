import { describe, expect, it } from "vitest";

import {
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
});
