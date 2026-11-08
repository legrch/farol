import { productName } from "./harness-identity.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const result = spawnSync(
  "/usr/bin/python3",
  [
    fileURLToPath(new URL("./vm-machine.py", import.meta.url)),
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...Object.fromEntries(
        ["HOME", "USER", "TMPDIR", "PATH"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      // Same config override as vm-entry: a private infrastructure config
      // selects the tool and data root for a given provisioning step.
      ...(process.env.FAROL_VM_CONFIG
        ? { FAROL_VM_CONFIG: process.env.FAROL_VM_CONFIG }
        : {}),
      FAROL_VM_TESTING_DIRECTORY: productName + " Testing",
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
