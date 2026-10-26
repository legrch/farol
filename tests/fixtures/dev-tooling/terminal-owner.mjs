// Disposable process-tree fixture. No Electron, profile, tunnel or provider.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchPreview } from "../../../tooling/dev.mjs";

await launchPreview(
  fileURLToPath(new URL("../../../", import.meta.url)),
  (executable, _args, options) =>
    spawn(
      executable,
      [fileURLToPath(new URL("./terminal-descendants.mjs", import.meta.url))],
      {
        ...options,
        env: {
          ...options.env,
          FAROL_TERMINAL_FIXTURE_DRAIN_MS:
            process.env.FAROL_TERMINAL_FIXTURE_DRAIN_MS ?? "50",
        },
      },
    ),
  false,
  false,
  undefined,
  {},
  async () => process.execPath,
);
