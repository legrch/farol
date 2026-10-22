import { writeSync } from "node:fs";

export function retiredJourneyReport(journey, reason) {
  if (typeof journey !== "string" || journey.trim().length === 0)
    throw new TypeError("journey must be a nonempty string");
  if (typeof reason !== "string" || reason.trim().length === 0)
    throw new TypeError("reason must be a nonempty string");
  return {
    schema: 1,
    status: "NOT_RUN",
    journey,
    reason,
    qualifying: false,
  };
}

export function reportRetiredJourney(
  journey,
  reason,
  write = writeRetirementLine,
) {
  const report = retiredJourneyReport(journey, reason);
  write(`${JSON.stringify(report)}\n`);
  return report;
}

// Entrypoints may exit immediately after reporting retirement. Deliver the
// entire UTF-8 record synchronously; a write failure must prevent exit(0).
function writeRetirementLine(line) {
  const bytes = Buffer.from(line, "utf8");
  let offset = 0;
  const deadline = Date.now() + 5_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (offset < bytes.length) {
    try {
      const written = writeSync(
        process.stdout.fd,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (written <= 0) throw new Error("RETIREMENT_REPORT_WRITE_FAILED");
      offset += written;
    } catch (error) {
      // EAGAIN writes no bytes. Retain the exact offset while the pipe's
      // reader drains; any other failure or deadline still prevents exit(0).
      if (error?.code !== "EAGAIN" || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}
