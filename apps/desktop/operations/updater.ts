import type { InstalledUpdaterPorts } from "../../../src/modules/release/app/installed-updater";
import type { OperationsRecorder } from "../renderer/operations-contract";
import { observeOperation } from "./observe";

/** Records actual port calls, including automatic checks and normal-Quit apply.
 * A helper acceptance is pending, never an invented installed/apply success. */
export function recordedUpdaterPorts(
  recorder: OperationsRecorder | undefined,
  ports: InstalledUpdaterPorts,
): InstalledUpdaterPorts {
  if (!recorder) return ports;
  const run = <T>(kind: string, action: () => Promise<T>) =>
    observeOperation(recorder, { source: "Updater", kind, target: {} }, action);
  return {
    ...ports,
    recover: () => run("update.recovery-check", () => ports.recover()),
    discover: () => run("update.check", () => ports.discover()),
    download: (progress) =>
      run("update.download", () => ports.download(progress)),
    restart: (update, confirmation) =>
      run("update.apply", () => ports.restart(update, confirmation)),
    ...(ports.applyOnQuit
      ? {
          applyOnQuit: (update, context) =>
            run("update.apply-on-quit", () =>
              ports.applyOnQuit!(update, context),
            ),
        }
      : {}),
    restore: (action) => run(`update.${action}`, () => ports.restore(action)),
  };
}
