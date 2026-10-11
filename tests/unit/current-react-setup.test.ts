import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Import only the observation helper. Never import a native journey, launch
// Electron, read a profile or treat this synthetic UI record as native proof.
const { assertSetupOverviewEvidence } = await import(
  new URL("../e2e/current-react-setup.mjs", import.meta.url).href
);
const expected = {
  ready: true,
  signIn: "unknown",
  states: {
    signin: "unknown",
    folders: "verified",
    connection: "verified",
    attachment: "verified",
  },
};
function readyEvidence() {
  return {
    steps: ["Overview", "Sign in", "Connection", "Workspaces", "Check"],
    currentSteps: ["Overview"],
    obsoleteCount: 0,
    rows: [
      {
        step: "signin",
        label: "Sign in",
        optional: true,
        state: "unknown",
        status: "Current sign-in is unknown",
        navigationState: "unknown",
        navigationStatus: "Current sign-in is unknown",
      },
      ...[
        ["connection", "Connection"],
        ["folders", "Workspaces"],
        ["attachment", "Check"],
      ].map(([step, label]) => ({
        step,
        label,
        optional: false,
        state: "verified",
        status:
          step === "connection"
            ? "Local connection ready"
            : step === "attachment"
              ? "Verified from ChatGPT"
              : "Verified",
        navigationState: "verified",
        navigationStatus:
          step === "connection"
            ? "Local connection ready"
            : step === "attachment"
              ? "Verified from ChatGPT"
              : "Verified",
      })),
    ],
    openHome: { count: 1, visible: true, disabled: false },
  };
}
describe("native Setup overview observation guards (synthetic records only)", () => {
  it("accepts externally ready Computer with optional sign-in currently unknown", () => {
    assertSetupOverviewEvidence(readyEvidence(), expected);
  });
  it("distinguishes original operation UNKNOWN from unknown current sign-in", () => {
    const observed = readyEvidence();
    Object.assign(observed.rows[0]!, {
      state: "unknown",
      status: "Outcome unknown",
      navigationState: "unknown",
      navigationStatus: "Outcome unknown",
    });
    assertSetupOverviewEvidence(observed, {
      ...expected,
      signIn: "outcome_unknown",
      states: { ...expected.states, signin: "unknown" },
    });
  });
  it.each([
    ["authenticated", "verified", "Signed in"],
    ["signed_out", "needed", "Signed out"],
    ["pending", "pending", "Checking sign-in…"],
    ["unknown", "unknown", "Current sign-in is unknown"],
    ["outcome_unknown", "unknown", "Outcome unknown"],
  ])(
    "requires the exact %s Sign in state and caption",
    (signIn, state, status) => {
      const observed = readyEvidence();
      Object.assign(observed.rows[0]!, {
        state,
        status,
        navigationState: state,
        navigationStatus: status,
      });
      assertSetupOverviewEvidence(observed, {
        ...expected,
        signIn,
        states: { ...expected.states, signin: state },
      });
      observed.rows[0]!.navigationStatus = "Not checked";
      assert.throws(
        () =>
          assertSetupOverviewEvidence(observed, {
            ...expected,
            signIn,
            states: { ...expected.states, signin: state },
          }),
        /SETUP_OVERVIEW_EVIDENCE_MISMATCH/,
      );
    },
  );
  it("rejects missing, invalid or contradictory Sign in expectations", () => {
    assert.throws(
      () =>
        assertSetupOverviewEvidence(readyEvidence(), {
          ready: true,
          states: expected.states,
        }),
      /SETUP_SIGNIN_STATUS_MISSING/,
    );
    for (const signIn of ["unchecked", "__proto__", "any"])
      assert.throws(
        () =>
          assertSetupOverviewEvidence(readyEvidence(), {
            ...expected,
            signIn,
          }),
        /SETUP_SIGNIN_STATUS_INVALID/,
      );
    assert.throws(
      () =>
        assertSetupOverviewEvidence(readyEvidence(), {
          ...expected,
          states: { ...expected.states, signin: "needed" },
        }),
      /SETUP_SIGNIN_STATE_MISMATCH/,
    );
  });
  it("rejects generic captions and an authenticated claim for unknown optional evidence", () => {
    for (const status of [
      "Not checked",
      "Result needs review",
      "Status unavailable",
      "Signed in",
    ]) {
      const observed = readyEvidence();
      Object.assign(observed.rows[0]!, { status, navigationStatus: status });
      assert.throws(
        () => assertSetupOverviewEvidence(observed, expected),
        /SETUP_OVERVIEW_EVIDENCE_MISMATCH/,
      );
    }
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
        signIn: expected.signIn,
        states: {
          signin: "unknown",
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
    for (const row of observed.rows.filter((item) => item.step !== "signin"))
      Object.assign(row, {
        state: "unavailable",
        status: "Status unavailable",
        navigationState: "unavailable",
        navigationStatus: "Status unavailable",
      });
    observed.openHome = { count: 0, visible: false, disabled: false };
    assertSetupOverviewEvidence(observed, {
      ready: false,
      signIn: "unknown",
      states: {
        signin: "unknown",
        folders: "unavailable",
        connection: "unavailable",
        attachment: "unavailable",
      },
    });
  });
});
