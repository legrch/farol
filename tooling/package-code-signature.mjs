import { spawnSync } from "node:child_process";

// This verifies the Mach-O's own signature only. It does not sign the outer
// application, establish a Developer ID identity, or assert notarization.
export function verifyPackagedExecutableSignature(file) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", file],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new Error("PACKAGE_EXECUTABLE_SIGNATURE_INVALID");
}
