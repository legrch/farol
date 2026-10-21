import { describe, expect, it } from "vitest";
import {
  adjacentSetupSection,
  projectSetupChecklist,
  setupSections,
  visibleSetupSection,
  type SetupChecklistInput,
} from "../../src/ui/renderer/setup-checklist";
const ready: SetupChecklistInput = {
  current: true,
  signedIn: true,
  hasWorkspaces: true,
  workspacesVerified: true,
  localConnectionCurrent: true,
  externalAccessVerified: true,
  computerReady: true,
  signInActivity: "settled",
  computerActivity: "settled",
};
describe("guided Setup evidence", () => {
  it("has one four-step order after welcome", () => {
    expect(setupSections).toEqual([
      ["overview", "Overview"],
      ["signin", "Sign in"],
      ["folders", "Workspaces"],
      ["connection", "Connect this Mac"],
      ["attachment", "Add to ChatGPT"],
    ]);
    expect(projectSetupChecklist(ready).entries.every((x) => !x.optional)).toBe(
      true,
    );
  });
  for (const field of [
    "current",
    "signedIn",
    "hasWorkspaces",
    "workspacesVerified",
    "localConnectionCurrent",
    "externalAccessVerified",
    "computerReady",
  ] as const)
    it(`requires ${field}`, () => {
      expect(projectSetupChecklist({ ...ready, [field]: false }).ready).toBe(
        false,
      );
    });
  it("keeps workspace, local connection and ChatGPT evidence independent", () => {
    const p = projectSetupChecklist({
      ...ready,
      externalAccessVerified: false,
    });
    expect(p.entries.map((x) => x.state)).toEqual([
      "verified",
      "verified",
      "verified",
      "needed",
    ]);
    expect(p.ready).toBe(false);
  });
  it.each(["pending", "unknown"] as const)(
    "never accepts %s operations",
    (state) => {
      expect(
        projectSetupChecklist({ ...ready, computerActivity: state }).ready,
      ).toBe(false);
      expect(
        projectSetupChecklist({ ...ready, signInActivity: state }).ready,
      ).toBe(false);
    },
  );
  it("retains unknown effects even when current status disappears", () => {
    expect(
      projectSetupChecklist({
        ...ready,
        current: false,
        computerActivity: "unknown",
      })
        .entries.slice(1)
        .every((x) => x.state === "unknown"),
    ).toBe(true);
  });
  it("keeps legacy and invalid routes at welcome", () => {
    for (const step of ["finish", null, undefined, 17, {}, "invalid"]) {
      expect(visibleSetupSection(step)).toBe("overview");
      expect(adjacentSetupSection(step, 1)).toBe("signin");
    }
  });
  it("never mutates input", () => {
    expect(projectSetupChecklist(Object.freeze({ ...ready }))).toEqual(
      projectSetupChecklist(ready),
    );
  });
  it("checks the complete bounded evidence matrix", () => {
    for (let mask = 0; mask < 128; mask++)
      for (const signInActivity of ["settled", "pending", "unknown"] as const)
        for (const computerActivity of [
          "settled",
          "pending",
          "unknown",
        ] as const) {
          const bit = (n: number) => Boolean(mask & (1 << n));
          const x: SetupChecklistInput = {
            current: bit(0),
            signedIn: bit(1),
            hasWorkspaces: bit(2),
            workspacesVerified: bit(3),
            localConnectionCurrent: bit(4),
            externalAccessVerified: bit(5),
            computerReady: bit(6),
            signInActivity,
            computerActivity,
          };
          expect(projectSetupChecklist(x).ready).toBe(
            mask === 127 &&
              signInActivity === "settled" &&
              computerActivity === "settled",
          );
        }
  });
});
