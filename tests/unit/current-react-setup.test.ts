import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Import only the observation helper. Never import a native journey, launch
// Electron, read a profile or treat this synthetic UI record as native proof.
const { assertSetupOverviewEvidence } = await import(
  new URL("../e2e/current-react-setup.mjs", import.meta.url).href
);
const expected = {
  ready: true,
  states: {
    signin: "needed",
    folders: "verified",
    connection: "verified",
    attachment: "verified",
  },
};
function readyEvidence() {
  return {
    steps: [
      "Overview",
      "Sign in",
      "Workspaces",
      "Connection",
      "Add to ChatGPT",
    ],
    currentSteps: ["Overview"],
    obsoleteCount: 0,
    rows: [
      {
        step: "signin",
        label: "Sign in",
        optional: true,
        state: "needed",
        status: "Not checked",
        navigationState: "needed",
        navigationStatus: "Not checked",
      },
      ...[
        ["folders", "Workspaces"],
        ["connection", "Connection"],
        ["attachment", "Add to ChatGPT"],
      ].map(([step, label]) => ({
        step,
        label,
        optional: false,
        state: "verified",
        status: "Verified",
        navigationState: "verified",
        navigationStatus: "Verified",
      })),
    ],
    openHome: { count: 1, visible: true, disabled: false },
  };
}
describe("native Setup overview observation guards (synthetic records only)", () => {
  it("accepts externally ready Computer with optional sign-in still unchecked", () => {
    assertSetupOverviewEvidence(readyEvidence(), expected);
  });
  it("excludes an explicitly unknown optional sign-in from Computer readiness", () => {
    const observed = readyEvidence();
    Object.assign(observed.rows[0]!, {
      state: "unknown",
      status: "Result needs review",
      navigationState: "unknown",
      navigationStatus: "Result needs review",
    });
    assertSetupOverviewEvidence(observed, {
      ...expected,
      states: { ...expected.states, signin: "unknown" },
    });
  });
  for (const state of ["needed", "pending", "unknown", "unavailable"]) {
    for (const step of ["folders", "connection", "attachment"]) {
      it(`rejects ${state} ${step} even if the caller claims Computer ready`, () => {
        const observed = readyEvidence();
        const status = {
          needed: "Not checked",
          pending: "Check in progress",
          unknown: "Result needs review",
          unavailable: "Status unavailable",
        }[state];
        Object.assign(
          observed.rows.find((row) => row.step === step)!,
          {
            state,
            status,
            navigationState: state,
            navigationStatus: status,
          },
        );
        assert.throws(
          () =>
            assertSetupOverviewEvidence(observed, {
              ...expected,
              states: { ...expected.states, [step]: state },
            }),
          /COMPUTER_NOT_READY/,
        );
      });
    }
  }
  it("rejects a missing row, missing expectation and missing readiness claim", () => {
    const observed = readyEvidence();
    observed.rows.pop();
    assert.throws(() => assertSetupOverviewEvidence(observed, expected));
    assert.throws(() =>
      assertSetupOverviewEvidence(readyEvidence(), {
        ready: true,
        states: {
          signin: "needed",
          folders: "verified",
          connection: "verified",
        },
      }),
    );
    assert.throws(() =>
      assertSetupOverviewEvidence(readyEvidence(), { states: expected.states }),
    );
  });
  it("rejects absent, hidden or disabled Open Home when ready, and any Open Home when not ready", () => {
    for (const openHome of [
      { count: 0, visible: false, disabled: false },
      { count: 1, visible: false, disabled: false },
      { count: 1, visible: true, disabled: true },
    ])
      assert.throws(() =>
        assertSetupOverviewEvidence({ ...readyEvidence(), openHome }, expected),
      );
    assert.throws(() =>
      assertSetupOverviewEvidence(readyEvidence(), {
        ...expected,
        ready: false,
      }),
    );
  });
  it("rejects phantom Finish, wrong ordering, wrong selection and contradictory sidebar status", () => {
    const observed = readyEvidence();
    for (const changed of [
      { ...observed, steps: [...observed.steps, "Finish"] },
      { ...observed, steps: [...observed.steps].reverse() },
      { ...observed, obsoleteCount: 1 },
      { ...observed, currentSteps: ["Connection"] },
    ])
      assert.throws(() => assertSetupOverviewEvidence(changed, expected));
    observed.rows[1]!.navigationState = "unknown";
    assert.throws(() => assertSetupOverviewEvidence(observed, expected));
  });
  it("accepts explicit unavailable evidence only with Open Home absent", () => {
    const observed = readyEvidence();
    for (const row of observed.rows)
      Object.assign(row, {
        state: "unavailable",
        status: "Status unavailable",
        navigationState: "unavailable",
        navigationStatus: "Status unavailable",
      });
    observed.openHome = { count: 0, visible: false, disabled: false };
    assertSetupOverviewEvidence(observed, {
      ready: false,
      states: {
        signin: "unavailable",
        folders: "unavailable",
        connection: "unavailable",
        attachment: "unavailable",
      },
    });
  });
});
