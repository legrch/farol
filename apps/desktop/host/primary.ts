import type { Dialog } from "electron";
import type { DesktopEnvironment } from "../../../src/apps/desktop/desktop-environment";
import {
  startupNoticeAllowed,
  terminateDesktopStartup,
} from "../../../src/apps/desktop/desktop-startup-failure";
import {
  devReopenPrimaryRefused,
  type PrimaryStartup,
  type StartupStage,
} from "../../../src/apps/desktop/primary-startup";
import { secondInstanceResultPrefix, type createInstance } from "./instance";

// What happens once the single-instance lock is known: record which lock this
// launch got, then refuse a Dev reopen that won it, wait as a second launch, or
// run the primary's startup and settle its result. Main keeps the lock request
// at import time and passes its answer here, so the request still happens
// when main.ts loads, never from this function. The pure refusal predicate, the
// failure report and the notice gate are imported, not lent. Nothing here
// retries: a failed primary startup aborts the Go core once, reports once and
// exits with code 1, and a failed core cleanup replaces the original error with
// its own classified one. The primary's readiness is checked after startup,
// never assumed from it.

type Instance = ReturnType<typeof createInstance>;

export type PrimaryStartupPorts = Readonly<{
  /** The answer of the import-time `requestSingleInstanceLock`. */
  primaryInstanceLock: boolean;
  runtimeEnvironment: DesktopEnvironment;
  process: Pick<NodeJS.Process, "argv" | "env" | "stderr">;
  app: Readonly<{ exit: (code: number) => void }>;
  dialog: Pick<Dialog, "showErrorBox">;
  startupStage: (stage: StartupStage) => void;
  instance: () => Pick<
    Instance,
    "refuseDevReopen" | "settleSecondInstance" | "isPrimaryReady"
  >;
  /** Builds the quit signals and runs main's startup: called only by the primary. */
  initialize: () => Promise<void>;
  primaryStartup: Pick<PrimaryStartup, "begin">;
  /** Throws when the manual-install proof cannot be written. */
  publishInstallProof: () => void;
  closeStartupSplash: () => void;
  desktopGoCore: () => { abortStartup(): Promise<unknown> } | null | undefined;
}>;

export function runPrimaryStartup(ports: PrimaryStartupPorts): void {
  const { primaryInstanceLock, process, app } = ports;
  ports.startupStage(primaryInstanceLock ? "lock-primary" : "lock-secondary");
  if (
    devReopenPrimaryRefused(
      ports.runtimeEnvironment,
      process.argv,
      primaryInstanceLock,
    )
  ) {
    ports.instance().refuseDevReopen();
  } else if (!primaryInstanceLock) {
    ports.instance().settleSecondInstance();
  } else {
    const initialization = ports.initialize();
    const readiness = initialization.then(() => {
      if (!ports.instance().isPrimaryReady())
        throw new Error("PRIMARY_STARTUP_INCOMPLETE");
    });
    ports.primaryStartup.begin(readiness);
    void initialization
      .then(() => {
        if (ports.instance().isPrimaryReady()) {
          try {
            ports.publishInstallProof();
          } catch {
            process.stderr.write("INSTALL_STARTUP_PROOF_UNCONFIRMED\n");
          }
        }
        ports.closeStartupSplash();
        ports.startupStage("startup-complete");
        process.stderr.write(
          `${secondInstanceResultPrefix}${ports.instance().isPrimaryReady() ? "primary-started" : "reopen-failed"}\n`,
        );
      })
      .catch(async (error: unknown) => {
        ports.closeStartupSplash();
        try {
          await ports.desktopGoCore()?.abortStartup();
        } catch {
          error = new Error("GO_CORE_STARTUP_CLEANUP_UNCONFIRMED");
        }
        terminateDesktopStartup(error, ports.runtimeEnvironment, {
          write: (message) => process.stderr.write(message),
          exit: (code) => app.exit(code),
          // A recipient who just opened the app sees nothing else: this is the
          // only window-less surface Electron allows before ready. It is modal,
          // so a non-interactive launch never gets it and exits at once.
          ...(startupNoticeAllowed(process.env)
            ? {
                notify: (title: string, message: string) =>
                  ports.dialog.showErrorBox(title, message),
              }
            : {}),
        });
      });
  }
}
