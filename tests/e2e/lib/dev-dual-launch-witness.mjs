// CLI acceptance only. These checks grant no runtime or recovery authority.
import assert from "node:assert/strict";

export function savedDevAdmission(marker, quit) {
  if (marker.status !== "absent")
    return { eligible: false, code: "SAVED_DEV_RUN_UNCONFIRMED" };
  if (!quit?.ok || !quit.receipt.drained || quit.receipt.unconfirmed.length)
    return { eligible: false, code: "SAVED_DEV_QUIT_UNCONFIRMED" };
  return { eligible: true, code: "SAVED_DEV_CLOSED_OBSERVED" };
}

export function dualLaunchWitness(expected, actual) {
  assert.equal(
    actual.outcome,
    "primary-started",
    "DUAL_LAUNCH_NOT_PRIMARY_STARTED",
  );
  assert.equal(actual.buildId, expected.buildId, "DUAL_LAUNCH_BUILD_MISMATCH");
  assert.equal(
    actual.profileId,
    expected.profileId,
    "DUAL_LAUNCH_PROFILE_MISMATCH",
  );
  assert.equal(actual.runtimeState, "ready", "DUAL_LAUNCH_RUNTIME_NOT_READY");
  assert.equal(actual.rendererReady, true, "DUAL_LAUNCH_RENDERER_NOT_READY");
  assert.equal(actual.route, "home", "DUAL_LAUNCH_HOME_NOT_PROVEN");
  assert.equal(actual.recovery, false, "DUAL_LAUNCH_RECOVERY");
  assert.match(actual.backendGeneration, /^[A-Za-z0-9._:/-]{1,120}$/u);
  if (expected.previousBackendGeneration)
    assert.notEqual(
      actual.backendGeneration,
      expected.previousBackendGeneration,
      "DUAL_LAUNCH_BACKEND_REUSED",
    );
  return Object.freeze({ ...actual });
}

// A completed-fixture successor must select Home by persisted launch settings.
// Observing Home after a click cannot satisfy this stronger witness.
export function automaticHomeWitness(expected, actual) {
  assert.equal(actual.journeyDismissed, true, "AUTO_HOME_FINISH_NOT_SAVED");
  assert.equal(actual.openAtLaunch, "home", "AUTO_HOME_LAUNCH_SETTING");
  assert.equal(actual.startupRoute, "home", "AUTO_HOME_STARTUP_ROUTE");
  assert.equal(actual.homeNavigationUsed, false, "AUTO_HOME_MANUAL_NAVIGATION");
  return dualLaunchWitness(expected, actual);
}
