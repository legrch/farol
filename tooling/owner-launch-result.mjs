export const SECOND_INSTANCE_RESULT_PREFIX =
  "FAROL_NEXT_SECOND_INSTANCE_RESULT:";

const OUTCOMES = new Set([
  "reopened",
  "identity-mismatch",
  "reopen-failed",
  "unverified",
]);

export function parseOwnerLaunchResult(output) {
  const markers = String(output)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(SECOND_INSTANCE_RESULT_PREFIX));
  if (markers.length === 0) return null;
  if (markers.length !== 1) throw new Error("OWNER_LAUNCH_RESULT_AMBIGUOUS");
  const outcome = markers[0].slice(SECOND_INSTANCE_RESULT_PREFIX.length);
  if (!OUTCOMES.has(outcome)) throw new Error("OWNER_LAUNCH_RESULT_INVALID");
  return outcome;
}
