import { channels } from "../../../src/pkg/ipc/channels";
import type { resumeComputerConnector } from "../../../src/apps/desktop/connector-resume-policy";
import type { StartupStage } from "../../../src/apps/desktop/primary-startup";
import type { ProductConfigurationSnapshot } from "../../../src/pkg/product-settings/contract";
import type { DesktopAdmission } from "../host/admission";

// The connector resume that closes startup: restore only the local connection
// a previous run left ready, once, after the drifted-workspace check has
// settled. It runs last, so nothing that follows it can be skipped by it. Main
// keeps every owner; each `let` there is a late getter here, so a Quit that
// arrives while the resume waits is seen at the next check, and the one owner
// write, the startup-checking flag, is a setter port. Nothing retries: a
// refused or failed resume is staged and the transport watch starts anyway,
// and the flag is cleared whatever the outcome. ChatGPT verification sends are
// explicit owner actions, so this never sends one.

type Window = Readonly<{
  isDestroyed(): boolean;
  webContents: Readonly<{ send: (channel: string) => unknown }>;
}>;

type ResumeInput = Parameters<typeof resumeComputerConnector>[0];

export type ConnectorResumePorts = Readonly<{
  resume: typeof resumeComputerConnector;
  /** What the policy needs besides the snapshot, fixed for this launch. */
  launch: Omit<ResumeInput, "snapshot">;
  /** False when the drifted-workspace withdrawal did not settle: never resume. */
  driftSettled: boolean;
  snapshot: () => ProductConfigurationSnapshot;
  /** Set by Quit's claim: a launch-time resume must not start after Quit. */
  cancelled: () => boolean;
  desktopAdmission: Pick<DesktopAdmission, "closed" | "quitInProgress">;
  /** The normal command keeps authority reservation, physical-root and Go checks. */
  verifyWorkspace: (workspaceId: string) => Promise<{ ok: boolean }>;
  start: () => Promise<{ ok: boolean }>;
  startupStage: (stage: StartupStage) => void;
  window: () => Window | null;
  startConnectorTransportWatch: () => void;
  /** The owner write: the launch-time connection check is over. */
  finishConnectionCheck: () => void;
}>;

export function startConnectorResume(
  ports: ConnectorResumePorts,
): Promise<void> {
  const notifyConfigurationChanged = () => {
    const current = ports.window();
    if (
      !ports.desktopAdmission.quitInProgress &&
      current &&
      !current.isDestroyed()
    )
      current.webContents.send(channels.configurationChanged);
  };
  return ports
    .resume(
      { ...ports.launch, snapshot: ports.snapshot() },
      {
        current: () => ports.snapshot(),
        mayContinue: () =>
          ports.driftSettled &&
          !ports.cancelled() &&
          !ports.desktopAdmission.closed(),
        verifyWorkspace: (workspaceId) => ports.verifyWorkspace(workspaceId),
        start: () => ports.start(),
      },
    )
    .then(
      (status) => {
        ports.startupStage(
          status === "started"
            ? "connector-resumed"
            : status === "skipped"
              ? "connector-resume-skipped"
              : "connector-resume-refused",
        );
        notifyConfigurationChanged();
        ports.startConnectorTransportWatch();
      },
      () => {
        ports.startupStage("connector-resume-failed");
        ports.startConnectorTransportWatch();
      },
    )
    .finally(() => {
      ports.finishConnectionCheck();
      notifyConfigurationChanged();
    });
}
