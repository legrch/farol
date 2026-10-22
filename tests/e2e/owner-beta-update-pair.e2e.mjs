// Root-operated only. --check admits source without allocating a native home.
import {
  executePacket,
  parseArguments,
} from "./lib/owner-beta-update-pair.mjs";

try {
  const result = await executePacket(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
} catch (error) {
  // Never print native output, profile contents, auth or raw error transcripts.
  const reason = /^OWNER_BETA_[A-Z_]+$/u.test(error.message)
    ? error.message
    : "OWNER_BETA_PREFLIGHT_REFUSED";
  console.error(
    JSON.stringify({
      status: error.nativeEffects ? "outcome_unknown" : "refused",
      reason,
      native: error.nativeEffects
        ? "UNCONFIRMED: retain original native attempt"
        : "NOT RUN",
      ...(error.nativeEffects ? { profileRoot: error.profileRoot } : {}),
    }),
  );
  process.exitCode = 1;
}
