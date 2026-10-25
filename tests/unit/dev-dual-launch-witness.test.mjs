// Pure witness/refusal cases, not native launch or admission proof.
import { expect, it } from "vitest";
import {
  savedDevAdmission,
  dualLaunchWitness,
  automaticHomeWitness,
} from "../e2e/lib/dev-dual-launch-witness.mjs";
const clean = { ok: true, receipt: { drained: true, unconfirmed: [] } };
it("does not upgrade an old run using a clean Quit or process/pending absence", () => {
  expect(savedDevAdmission({ status: "read" }, clean)).toEqual({
    eligible: false,
    code: "SAVED_DEV_RUN_UNCONFIRMED",
  });
  expect(savedDevAdmission({ status: "unreadable" }, clean).eligible).toBe(
    false,
  );
});
it.each([
  null,
  { ok: false },
  {
    ok: true,
    receipt: { drained: false, unconfirmed: ["connector", "go-core"] },
  },
])("refuses an unconfirmed saved Quit %j", (quit) => {
  expect(savedDevAdmission({ status: "absent" }, quit).eligible).toBe(false);
});
it("observes a closed profile without granting recovery", () => {
  expect(savedDevAdmission({ status: "absent" }, clean)).toEqual({
    eligible: true,
    code: "SAVED_DEV_CLOSED_OBSERVED",
  });
});
const expected = {
  buildId: "current-build",
  profileId: "profile",
  previousBackendGeneration: "old",
};
const current = {
  outcome: "primary-started",
  buildId: "current-build",
  profileId: "profile",
  backendGeneration: "new",
  runtimeState: "ready",
  rendererReady: true,
  route: "home",
  recovery: false,
};
it("accepts only a matching current renderer/route witness", () => {
  expect(dualLaunchWitness(expected, current).route).toBe("home");
});
it.each([
  { outcome: "primary-recovery" },
  { buildId: "old" },
  { profileId: "foreign" },
  { backendGeneration: "old" },
  { runtimeState: "starting" },
  { rendererReady: false },
  { route: null },
  { recovery: true },
])("refuses missing or mismatched startup evidence %j", (delta) => {
  expect(() => dualLaunchWitness(expected, { ...current, ...delta })).toThrow();
});

const automatic = {
  ...current,
  journeyDismissed: true,
  openAtLaunch: "home",
  startupRoute: "home",
  homeNavigationUsed: false,
};
it("requires a saved real Finish and automatic Home in the successor witness", () => {
  expect(automaticHomeWitness(expected, automatic).startupRoute).toBe("home");
});
it.each([
  { journeyDismissed: false },
  { openAtLaunch: "settings" },
  { startupRoute: "setup" },
  { homeNavigationUsed: true },
])(
  "does not substitute manually reached Home for automatic Home %j",
  (delta) => {
    expect(() =>
      automaticHomeWitness(expected, { ...automatic, ...delta }),
    ).toThrow();
  },
);
