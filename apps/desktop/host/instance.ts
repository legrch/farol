import {
  acknowledgementFailureCode,
  decideSecondInstance,
  sameLaunchIdentity,
  secondInstanceRefusalMessage,
  type foreignAcknowledgementCount,
  type InstanceRequest,
  type LaunchIdentity,
  type waitForInstanceAcknowledgement,
  type writeInstanceAcknowledgement,
} from "../../../src/apps/desktop/single-instance";
import { containWindowOpenFailure } from "../../../src/apps/desktop/lifecycle-policy";
import {
  primaryStartupReady,
  type PrimaryStartup,
} from "../../../src/apps/desktop/primary-startup";
import type { DesktopAdmission } from "./admission";

// The single-instance host: what the primary does when a second launch reaches
// it, what a second launch does while it waits to be acknowledged, and what
// counts as a primary that is ready to be reopened. Main keeps every owner and
// the one import-time lock request; each `let` there is a late getter here, so a
// Quit, an update Apply or a recovery window that appears while a launch waits
// is seen at the next read. The pure decision, the readiness predicate and the
// refusal text are imported, not lent, so no caller can swap them. Nothing here
// retries: a launch is acknowledged once with its classified status, and a
// failed acknowledgement is reported, never repeated.

/** Written on stderr, one line per launch, for the launcher that started it. */
export const secondInstanceResultPrefix = "FAROL_SECOND_INSTANCE_RESULT:";
/** Written on stderr when the acknowledgement could not be published or found. */
export const secondInstanceAcknowledgementPrefix =
  "FAROL_SECOND_INSTANCE_ACK_FAILED:";

export type InstanceApp = Readonly<{
  getPath: (name: "userData") => string;
  on: (
    event: "second-instance",
    listener: (
      event: unknown,
      commandLine: string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void,
  ) => unknown;
  releaseSingleInstanceLock: () => void;
  quit: () => void;
  exit: (code: number) => void;
}>;

export type InstancePorts = Readonly<{
  app: InstanceApp;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  desktopAdmission: Pick<
    DesktopAdmission,
    "quitInProgress" | "installedUpdateAdmission"
  >;
  launchIdentity: LaunchIdentity;
  instanceRequest: InstanceRequest;
  primaryStartup: Pick<PrimaryStartup, "whenReady">;
  runtimeStopping: () => boolean;
  runtimeState: () => "starting" | "ready" | "offline" | "failed";
  window: () => Readonly<{ isDestroyed: () => boolean }> | null;
  taskViewKinds: Pick<Map<string, "runtime" | "chatgpt">, "values">;
  expectedTasks: Readonly<{ length: number }>;
  ensureWindow: () => Promise<void>;
  recoverWindowOpenFailure: () => void;
  writeInstanceAcknowledgement: typeof writeInstanceAcknowledgement;
  waitForInstanceAcknowledgement: typeof waitForInstanceAcknowledgement;
  foreignAcknowledgementCount: typeof foreignAcknowledgementCount;
}>;

export function createInstance(ports: InstancePorts) {
  const {
    app,
    stderr,
    desktopAdmission,
    launchIdentity,
    instanceRequest,
    primaryStartup,
    runtimeStopping,
    runtimeState,
    window,
    taskViewKinds,
    expectedTasks,
    ensureWindow,
    recoverWindowOpenFailure,
    writeInstanceAcknowledgement,
    waitForInstanceAcknowledgement,
    foreignAcknowledgementCount,
  } = ports;

  function isPrimaryReady(): boolean {
    const current = window();
    return primaryStartupReady({
      stopping:
        desktopAdmission.quitInProgress ||
        runtimeStopping() ||
        desktopAdmission.installedUpdateAdmission,
      runtimeState: runtimeState(),
      windowReady: current !== null && !current.isDestroyed(),
      taskViewCount: [...taskViewKinds.values()].filter(
        (kind) => kind === "runtime",
      ).length,
      expectedTaskViewCount: expectedTasks.length,
    });
  }

  async function handleSecondInstance(candidate: unknown): Promise<void> {
    const decision = decideSecondInstance(launchIdentity, candidate);
    if (!decision) return;
    let status = decision.status;
    if (
      status === "reopened" &&
      (desktopAdmission.quitInProgress ||
        runtimeStopping() ||
        desktopAdmission.installedUpdateAdmission)
    ) {
      // Quit/update owns admission: acknowledge that it cannot take this launch
      // instead of reopening a window that is about to close.
      status = "reopen-failed";
    }
    if (status === "reopened") {
      try {
        await primaryStartup.whenReady();
        // Quit/update may have begun while this launch waited for startup: check
        // again before opening a window that is about to close.
        if (
          desktopAdmission.quitInProgress ||
          runtimeStopping() ||
          desktopAdmission.installedUpdateAdmission
        ) {
          status = "reopen-failed";
        } else {
          const outcome = await containWindowOpenFailure(
            ensureWindow,
            recoverWindowOpenFailure,
          );
          if (outcome === "failed" || !isPrimaryReady()) {
            status = "reopen-failed";
          }
        }
      } catch {
        status = "reopen-failed";
      }
    }
    try {
      await writeInstanceAcknowledgement(
        app.getPath("userData"),
        candidate,
        status,
        launchIdentity,
      );
    } catch (error) {
      // The secondary process fails closed if this bounded acknowledgement is
      // unavailable. Never reopen a mismatched build merely to make it exit 0.
      // Say that it happened, though: without this line the secondary waits its
      // whole deadline and reports "unverified" for a reason nothing on the
      // primary's side ever recorded. The token is content-free by contract.
      stderr.write(
        `${secondInstanceAcknowledgementPrefix}${acknowledgementFailureCode(error)}\n`,
      );
    }
  }

  // Registered by the primary, from inside its startup, at the one place main
  // always registered it.
  function listenForSecondInstance(): void {
    app.on(
      "second-instance",
      (_event, _commandLine, _workingDirectory, candidate) => {
        void handleSecondInstance(candidate);
      },
    );
  }

  // A launcher that only reopens an existing Dev lost the race for the lock:
  // give the lock back and say so, instead of starting writable primary startup.
  function refuseDevReopen(): void {
    app.releaseSingleInstanceLock();
    stderr.write(`${secondInstanceResultPrefix}reopen-failed\n`);
    app.exit(1);
  }

  // A launch that did not get the lock waits for the primary's acknowledgement
  // and exits with what it learned.
  function settleSecondInstance(): void {
    void waitForInstanceAcknowledgement(
      app.getPath("userData"),
      instanceRequest,
    )
      .then(async (acknowledgement) => {
        const accepted =
          acknowledgement?.status === "reopened" &&
          sameLaunchIdentity(launchIdentity, acknowledgement);
        if (!accepted) {
          const outcome =
            acknowledgement?.status === "identity-mismatch" ||
            acknowledgement?.status === "reopen-failed"
              ? acknowledgement.status
              : "unverified";
          stderr.write(
            `${secondInstanceRefusalMessage(instanceRequest, acknowledgement)}\n`,
          );
          stderr.write(`${secondInstanceResultPrefix}${outcome}\n`);
          if (acknowledgement === null) {
            // Nothing arrived within the deadline. Say whether the primary
            // published nothing at all, or published for a launch that is not
            // this one — the second is a disagreement no wait can resolve.
            const foreign = await foreignAcknowledgementCount(
              app.getPath("userData"),
              instanceRequest,
            ).catch(() => -1);
            stderr.write(
              `${secondInstanceAcknowledgementPrefix}${foreign === 0 ? "absent" : `foreign:${foreign}`}\n`,
            );
          }
          app.quit();
          return;
        }
        // Match Electron's graceful secondary-instance shutdown. A hard exit of
        // the second macOS application process can hide the primary window that
        // was just reopened.
        stderr.write(`${secondInstanceResultPrefix}reopened\n`);
        app.quit();
      })
      .catch(() => {
        stderr.write(`${secondInstanceResultPrefix}unverified\n`);
        app.quit();
      });
  }

  return {
    isPrimaryReady,
    handleSecondInstance,
    listenForSecondInstance,
    refuseDevReopen,
    settleSecondInstance,
  };
}
