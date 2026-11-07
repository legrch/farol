import { desktopIdentity } from "./harness-identity.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const identity = desktopIdentity("preview", "/");
const result = spawnSync(
  "/usr/bin/python3",
  [
    fileURLToPath(new URL("./vm-smoke.py", import.meta.url)),
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...Object.fromEntries(
        ["HOME", "USER", "TMPDIR", "PATH", "FAROL_VM_CONFIG"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      FAROL_VM_PRODUCT_IDENTITY: JSON.stringify({
        name: identity.applicationName,
        bundleId: identity.applicationId,
        dataLeaf: identity.userData.slice(1),
        devDataLeaf: desktopIdentity("dev", "/").userData.slice(1),
      }),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
