export const SECOND_INSTANCE_RESULT_PREFIX = "FAROL_SECOND_INSTANCE_RESULT:";

const OUTCOMES = new Set([
  "primary-started",
  "primary-recovery",
  "reopened",
  "identity-mismatch",
  "reopen-failed",
  "startup-failed",
  "unverified",
]);

const MAX_PROTOCOL_LINE_BYTES = 256;

function parseMarker(line) {
  if (!line.startsWith(SECOND_INSTANCE_RESULT_PREFIX)) return null;
  const outcome = line.slice(SECOND_INSTANCE_RESULT_PREFIX.length);
  if (!OUTCOMES.has(outcome)) throw new Error("OWNER_LAUNCH_RESULT_INVALID");
  return outcome;
}

export function parseOwnerLaunchResult(output) {
  const markers = String(output)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(SECOND_INSTANCE_RESULT_PREFIX));
  if (markers.length === 0) return null;
  if (markers.length !== 1) throw new Error("OWNER_LAUNCH_RESULT_AMBIGUOUS");
  return parseMarker(markers[0]);
}

export function createOwnerLaunchResultCollector() {
  let line = "";
  let ignoringOversizedLine = false;
  const outcomes = [];

  const finishLine = () => {
    if (!ignoringOversizedLine) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      const outcome = parseMarker(normalized);
      if (outcome !== null) outcomes.push(outcome);
    }
    line = "";
    ignoringOversizedLine = false;
  };

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === 0x0a) {
          finishLine();
          continue;
        }
        if (ignoringOversizedLine) continue;
        if (line.length >= MAX_PROTOCOL_LINE_BYTES) {
          if (line.startsWith(SECOND_INSTANCE_RESULT_PREFIX)) {
            throw new Error("OWNER_LAUNCH_RESULT_INVALID");
          }
          line = "";
          ignoringOversizedLine = true;
          continue;
        }
        line += String.fromCharCode(byte);
      }
    },
    finish() {
      if (line.length > 0 || ignoringOversizedLine) finishLine();
      if (outcomes.length === 0) throw new Error("OWNER_LAUNCH_RESULT_MISSING");
      if (outcomes.length !== 1) {
        throw new Error("OWNER_LAUNCH_RESULT_AMBIGUOUS");
      }
      return outcomes[0];
    },
  };
}
