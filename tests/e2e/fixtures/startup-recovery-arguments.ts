import assert from "node:assert/strict";

// Parse before any build/profile/native action. One explicit fault per journey.
export function parseRecoveryArguments(args: readonly string[]) {
  const selected = Object.freeze({
    savedSettings: args.includes("--saved-settings"),
    storedReplies: args.includes("--stored-replies"),
    forceQuit: args.includes("--force-quit"),
    normalHostCrash: args.includes("--normal-host-crash"),
    backendCrash: args.includes("--backend-crash"),
  });
  const {
    savedSettings,
    storedReplies,
    forceQuit,
    normalHostCrash,
    backendCrash,
  } = selected;
  assert.ok(
    Number(forceQuit) + Number(normalHostCrash) + Number(backendCrash) <= 1,
    "SELECT_ONE_CRASH_JOURNEY",
  );
  assert.ok(
    !storedReplies || (savedSettings && !normalHostCrash),
    "SELECT_EXPLICIT_STORED_OBSERVATION_JOURNEY",
  );
  assert.ok(
    !backendCrash || (savedSettings && storedReplies),
    "SELECT_EXPLICIT_BACKEND_CRASH_JOURNEY",
  );
  assert.deepEqual(
    args,
    [
      "--run-native",
      ...(savedSettings
        ? [
            "--saved-settings",
            ...(storedReplies ? ["--stored-replies"] : []),
            ...(forceQuit
              ? ["--force-quit"]
              : normalHostCrash
                ? ["--normal-host-crash"]
                : backendCrash
                  ? ["--backend-crash"]
                  : []),
          ]
        : []),
    ],
    "EXPLICIT_NATIVE_RECOVERY_LANE_REQUIRED",
  );
  return selected;
}
