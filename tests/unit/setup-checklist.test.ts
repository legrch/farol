import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  adjacentSetupSection,
  projectSetupChecklist,
  setupSections,
  visibleSetupSection,
} from "../../src/ui/renderer/setup-checklist";
import type {
  SetupActivity,
  SetupChecklistInput,
} from "../../src/ui/renderer/setup-checklist";
const baseline: SetupChecklistInput = {
  current: true,
  signedIn: false,
  workspacesVerified: false,
  localConnectionCurrent: false,
  externalAccessVerified: false,
  computerReady: false,
  signInActivity: "settled",
  computerActivity: "settled",
};
const allReady: SetupChecklistInput = {
  ...baseline,
  signedIn: true,
  workspacesVerified: true,
  localConnectionCurrent: true,
  externalAccessVerified: true,
  computerReady: true,
};
describe("Setup checklist presentation", () => {
  it("has one reference order for sidebar and detail, with no Finish step", () => {
    assert.deepEqual(setupSections, [
      ["overview", "Overview"],
      ["signin", "Sign in"],
      ["connection", "Connection"],
      ["folders", "Workspaces"],
      ["attachment", "Check"],
    ]);
    assert.deepEqual(
      projectSetupChecklist(baseline).entries.map((x) => x.step),
      setupSections.slice(1).map((x) => x[0]),
    );
  });
  it("never marks the reference's sample green checks as real evidence", () => {
    assert.equal(projectSetupChecklist(baseline).ready, false);
    assert(
      projectSetupChecklist(baseline).entries.every(
        (x) => x.state === "needed" && x.action === "Set up",
      ),
    );
  });
  it("does not require optional embedded sign-in for externally verified Computer", () => {
    const p = projectSetupChecklist({ ...allReady, signedIn: false });
    assert.equal(p.ready, true);
    assert.equal(p.entries[0]!.state, "needed");
    assert.deepEqual(
      p.entries.filter((x) => x.optional).map((x) => x.step),
      ["signin"],
    );
  });
  it("does not replace final Computer readiness with three local checkmarks", () => {
    assert.equal(
      projectSetupChecklist({ ...allReady, computerReady: false }).ready,
      false,
    );
  });
  for (const field of [
    "workspacesVerified",
    "localConnectionCurrent",
    "externalAccessVerified",
  ] as const) {
    it(`requires ${field} even when another observer claims computerReady`, () => {
      assert.equal(
        projectSetupChecklist({ ...allReady, [field]: false }).ready,
        false,
      );
    });
  }
  for (const activity of ["pending", "unknown"] as const) {
    it(`keeps ${activity} Computer effects unverified`, () => {
      const p = projectSetupChecklist({
        ...allReady,
        computerActivity: activity,
      });
      assert.equal(p.ready, false);
      assert(
        p.entries
          .filter((x) => !x.optional)
          .every((x) => x.state === activity && x.action === "Review"),
      );
    });
    it(`does not let optional ${activity} sign-in gate unrelated external readiness`, () => {
      const p = projectSetupChecklist({
        ...allReady,
        signInActivity: activity,
      });
      assert.equal(p.entries[0]!.state, activity);
      assert.equal(p.ready, true);
    });
  }
  it("withdraws all green checks on unavailable observation", () => {
    const p = projectSetupChecklist({ ...allReady, current: false });
    assert.equal(p.ready, false);
    assert(p.entries.every((x) => x.state === "unavailable"));
  });
  it("does not erase original UNKNOWN when observation is unavailable", () => {
    const p = projectSetupChecklist({
      ...allReady,
      current: false,
      computerActivity: "unknown",
    });
    assert(
      p.entries.filter((x) => !x.optional).every((x) => x.state === "unknown"),
    );
  });
  it("retains independent workspace/local/external facts", () => {
    const p = projectSetupChecklist({
      ...baseline,
      workspacesVerified: true,
      localConnectionCurrent: true,
    });
    assert.deepEqual(
      p.entries.map((x) => x.state),
      ["needed", "verified", "verified", "needed"],
    );
    assert.equal(p.ready, false);
    assert.equal(
      p.entries.find((x) => x.step === "connection")?.status,
      "Local connection ready",
    );
    assert.equal(
      p.entries.find((x) => x.step === "attachment")?.status,
      "Not checked",
    );
    assert.equal(
      projectSetupChecklist(allReady).entries.find(
        (x) => x.step === "attachment",
      )?.status,
      "Verified from ChatGPT",
    );
  });
  it("is pure and does not mutate even frozen input", () => {
    const input = Object.freeze({ ...allReady });
    const before = JSON.stringify(input);
    assert.deepEqual(
      projectSetupChecklist(input),
      projectSetupChecklist(input),
    );
    assert.equal(JSON.stringify(input), before);
  });
  it("keeps original input facts separate from returned mutable caller copies", () => {
    const first = projectSetupChecklist(allReady);
    (first.entries[0] as { state: string }).state = "unknown";
    assert.equal(projectSetupChecklist(allReady).entries[0]!.state, "verified");
  });
  for (const [step] of setupSections) {
    it(`keeps ${step} navigation inside the single reference order`, () => {
      assert.equal(visibleSetupSection(step), step);
      const i = setupSections.findIndex(([x]) => x === step);
      assert.equal(
        adjacentSetupSection(step, -1),
        setupSections[i - 1]?.[0] ?? null,
      );
      assert.equal(
        adjacentSetupSection(step, 1),
        setupSections[i + 1]?.[0] ?? null,
      );
    });
  }
  for (const value of ["finish", undefined, null, "not-a-step", {}, 17]) {
    it(`maps legacy/invalid navigation ${String(value)} to Overview without effects`, () => {
      assert.equal(visibleSetupSection(value), "overview");
      assert.equal(adjacentSetupSection(value, -1), null);
      assert.equal(adjacentSetupSection(value, 1), "signin");
    });
  }
  it("checks every bounded Boolean/activity state combination", () => {
    let cases = 0;
    const activities: SetupActivity[] = ["settled", "pending", "unknown"];
    for (let mask = 0; mask < 64; mask++)
      for (const signInActivity of activities)
        for (const computerActivity of activities) {
          const bit = (i: number) => Boolean(mask & (1 << i));
          const x: SetupChecklistInput = {
            current: bit(0),
            signedIn: bit(1),
            workspacesVerified: bit(2),
            localConnectionCurrent: bit(3),
            externalAccessVerified: bit(4),
            computerReady: bit(5),
            signInActivity,
            computerActivity,
          };
          const p = projectSetupChecklist(x);
          assert.equal(
            p.ready,
            x.current &&
              x.computerReady &&
              x.workspacesVerified &&
              x.localConnectionCurrent &&
              x.externalAccessVerified &&
              computerActivity === "settled",
          );
          for (const e of p.entries) {
            if (e.state === "verified")
              assert(
                x.current &&
                  (e.optional ? signInActivity : computerActivity) ===
                    "settled",
              );
            assert(!/[0-9]/u.test(e.label));
          }
          cases++;
        }
    assert.equal(cases, 576);
  });
});
