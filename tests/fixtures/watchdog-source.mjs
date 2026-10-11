// Export the exact retained resource; importing it does not execute the watchdog.
// Used only by the opt-in Go native transport tests, never by production boot.
import { createHash } from "node:crypto";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source.ts";

if (process.version !== "v24.20.0" && process.version !== "v26.7.0") {
  throw new Error("Watchdog transport fixture requires Node v24.20.0 or v26.7.0");
}
process.stdout.write(
  JSON.stringify({
    source: SHELL_WATCHDOG_SOURCE,
    sourceSHA256: createHash("sha256")
      .update(SHELL_WATCHDOG_SOURCE)
      .digest("hex"),
    nodeVersion: process.version,
  }),
);
