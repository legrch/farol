import assert from "node:assert/strict";

// Parse before any build/profile/native action. One explicit fault per journey.
export function parseRecoveryArguments(args: readonly string[]) {
  const selected = Object.freeze({
    savedSettings: args.includes("--saved-settings"),
    storedReplies: args.includes("--stored-replies"),
    forceQuit: args.includes("--force-quit"),
    normalHostCrash: args.includes("--normal-host-crash"),
    backendCrash: args.includes("--backend-crash"),
    computerStoreRefusal: args.includes("--computer-store-refusal"),
  });
  const {
    savedSettings,
    storedReplies,
    forceQuit,
    normalHostCrash,
    backendCrash,
    computerStoreRefusal,
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
  assert.ok(
    !computerStoreRefusal || (!forceQuit && !normalHostCrash && !backendCrash),
    "SELECT_ONE_RECOVERY_FAULT",
  );
  assert.ok(
    !computerStoreRefusal || (savedSettings && storedReplies),
    "SELECT_EXPLICIT_COMPUTER_STORE_REFUSAL_JOURNEY",
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
                  : computerStoreRefusal
                    ? ["--computer-store-refusal"]
                    : []),
          ]
        : []),
    ],
    "EXPLICIT_NATIVE_RECOVERY_LANE_REQUIRED",
  );
  return selected;
}
