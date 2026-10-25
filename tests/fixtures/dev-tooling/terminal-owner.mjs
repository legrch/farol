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
      options,
    ),
  false,
  false,
  undefined,
  {},
  async () => process.execPath,
);
