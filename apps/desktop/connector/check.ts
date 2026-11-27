import type { BrowserWindow } from "electron";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import { currentConnectorAttachment } from "../../../src/apps/desktop/connector-app-receipt-wait";
import type { connectorAppVerificationAttemptExists } from "../../../src/apps/desktop/connector-app-verification-attempt";
import type { connectorVerificationProof as connectorVerificationProofReader } from "../../../src/apps/desktop/connector-verification-proof";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import { selectedConnectorApp } from "../../../src/pkg/product-settings/connector-app-selection";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  ConnectionCheckRefusal,
  type ConnectionCheckCode,
  connectionCheckDigest,
  connectionCheckRuntimeReady,
  connectionCheckRuntimeRefusal,
  runExplicitConnectionCheck,
  type ConnectionCheckCommandResult,
  type ExplicitConnectionCheck,
} from "../connection-check-command";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";
import type { connectorSupervisor } from "./supervisor";

// Checking the attached connector: the attachment proof that publishes the
// Setup result and the explicit connection check around Go's one claim. Main
// keeps every owner; each `let` there is a late getter here, read afresh across
// every await, and the admission reservations are the owner's own object. A
// check whose reply is lost is observed again from its original receipt and is
// never sent or published a second time.

type Supervisor = ReturnType<typeof connectorSupervisor>;

export type ConnectorAppVerificationBinding = Readonly<{
  tunnelId: string;
  connectorGeneration: number;
  computerGeneration: number;
  runtimeGeneration: string;
  challengeSha256: string;
  buildId: string;
  workspaceId: string | null;
  appName?: string;
}>;

// The explicit connection check must not be blocked by stale folder access, so
// it tolerates configured folders with no current verification: the current
// selection, else the saved verification target while it is still configured,
// else the first configured folder, else the empty selection. Capturing the
// binding and re-checking it use this one choice.
//
// The verified-id branch deliberately ignores `computer.generation` staleness
// that the strict selection enforces. That is safe because the fallback only
// scopes the tunnel check (the Go selection and the retained-proof comparison,
// which stay on the folder an earlier check verified); nothing is ever recorded
// for it. The attachment is published only when the strict selection exists.
export function connectorCheckWorkspace(
  settings: ProductSettings,
): string | null {
  const selection = connectorWorkspaceSelection(settings);
  if (selection !== undefined) return selection;
  const verifiedId = settings.setup.computer.verified?.workspaceId;
  return verifiedId &&
    settings.computer.workspaces.some((item) => item.workspaceId === verifiedId)
    ? verifiedId
    : (settings.computer.workspaces[0]?.workspaceId ?? null);
}

// `workspaceOf` defaults to the strict selection every other caller relies on;
// only the explicit connection check passes its own fallback.
export function connectorAppBindingCurrent(
  settings: ProductSettings,
  expected: ConnectorAppVerificationBinding,
  workspaceOf: (
    settings: ProductSettings,
  ) => string | null | undefined = connectorWorkspaceSelection,
): boolean {
  const connector = settings.connectors.secureMcp;
  return (
    settings.computer.generation === expected.computerGeneration &&
    workspaceOf(settings) === expected.workspaceId &&
    connector.tunnelId === expected.tunnelId &&
    connector.generation === expected.connectorGeneration &&
    connector.runtime?.runtimeGeneration === expected.runtimeGeneration &&
    connector.runtime?.buildId === expected.buildId &&
    (connector.challenge?.challengeSha256 ??
      currentConnectorAttachment(
        settings,
        expected.buildId,
        expected.workspaceId,
      )?.challengeSha256) === expected.challengeSha256 &&
    (expected.appName === undefined ||
      selectedConnectorApp(connector) === expected.appName)
  );
}

export type ConnectorCheckPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  desktopGoCore: () => DesktopGoCore | null;
  chatGptRoute: () => ChatGptRoute | null;
  window: () => Pick<BrowserWindow, "isDestroyed"> | null;
  selectedTaskId: () => string;
  liveTaskRoutes: Pick<Map<string, ChatGptRoute>, "get">;
  desktopAdmission: Pick<
    DesktopAdmission,
    | "occupied"
    | "closed"
    | "reserveAdmitted"
    | "quitInProgress"
    | "installedUpdateAdmission"
  >;
  buildIdentity: Readonly<{ buildId: string }>;
  randomUUID: () => string;
  connectorVerificationProof: typeof connectorVerificationProofReader;
  statePaths: () => Readonly<{ secureMcpLaunch: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  embeddedBrowserEnabled: () => boolean;
  connectorAppVerificationAttemptExists: typeof connectorAppVerificationAttemptExists;
  connectorConnection: Pick<Supervisor["connectorConnection"], "sample">;
  currentConnectionStatus: Supervisor["currentConnectionStatus"];
}>;

export function createConnectorCheck(ports: ConnectorCheckPorts) {
  const {
    configuration,
    secureMcpConnectorRuntime,
    desktopGoCore,
    chatGptRoute,
    window,
    selectedTaskId,
    liveTaskRoutes,
    desktopAdmission,
    buildIdentity,
    randomUUID,
    connectorVerificationProof,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    connectorAppVerificationAttemptExists,
    connectorConnection,
    currentConnectionStatus,
  } = ports;

  async function checkSecureMcpAttachment(
    expectedWorkspaceId?: string | null,
    expectedBinding?: ConnectorAppVerificationBinding,
  ): Promise<ProductConfigurationResult> {
    if (!configuration() || !secureMcpConnectorRuntime()) {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    if (desktopAdmission.occupied("connector-task")) {
      return configurationFailure("CONNECTOR_ALREADY_RUNNING");
    }
    const connectorAdmission =
      desktopAdmission.reserveAdmitted("connector-task");
    try {
      const snapshot = configuration()!.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (
        expectedBinding &&
        !connectorAppBindingCurrent(snapshot.settings, expectedBinding)
      ) {
        return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      }
      const connector = snapshot.settings.connectors.secureMcp;
      const runtime = connector.runtime;
      const challenge = connector.challenge;
      const existing = currentConnectorAttachment(
        snapshot.settings,
        buildIdentity.buildId,
        expectedWorkspaceId,
      );
      if (existing) {
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot,
          evidence: {
            kind: "connector.attachment",
            runtimeGeneration: existing.runtimeGeneration,
            computerGeneration: existing.computerGeneration,
            workspaceId: existing.workspaceId,
            challengeSha256: existing.challengeSha256,
            receiptSha256: existing.receiptSha256,
          },
        });
      }
      if (
        expectedWorkspaceId !== undefined &&
        connectorWorkspaceSelection(snapshot.settings) !== expectedWorkspaceId
      ) {
        return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
      }
      if (
        runtime?.state !== "ready" ||
        challenge === null ||
        !secureMcpConnectorRuntime()!.isRunning()
      ) {
        return configurationFailure("CONNECTOR_CHALLENGE_UNAVAILABLE");
      }
      const core = desktopGoCore();
      if (!core) return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
      let observed;
      try {
        observed = await core.observeComputerConnectorVerification();
      } catch {
        return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
      }
      const proof = connectorVerificationProof(observed);
      if (!proof) return configurationFailure("CONNECTOR_ATTACHMENT_NOT_FOUND");
      const { receipt, workspaceId } = proof;
      if (
        !observed.receiptSha256 ||
        receipt.challengeSha256 !== challenge.challengeSha256 ||
        receipt.binding.buildId !== buildIdentity.buildId ||
        receipt.binding.connectorGeneration !== String(connector.generation) ||
        (expectedWorkspaceId !== undefined &&
          workspaceId !== expectedWorkspaceId) ||
        connectorWorkspaceSelection(snapshot.settings) !== workspaceId
      )
        return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
      const latest = configuration()!.snapshot();
      if (
        latest.status !== "ready" ||
        desktopGoCore() !== core ||
        latest.settings.computer.generation !==
          snapshot.settings.computer.generation ||
        latest.settings.connectors.secureMcp.generation !==
          connector.generation ||
        latest.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
          runtime.runtimeGeneration ||
        latest.settings.connectors.secureMcp.challenge?.challengeSha256 !==
          challenge.challengeSha256 ||
        (expectedBinding &&
          !connectorAppBindingCurrent(latest.settings, expectedBinding))
      )
        return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      const receiptSha256 = observed.receiptSha256;
      const attached = await configuration()!.recordSecureMcpAttachment({
        workspaceId,
        runtimeGeneration: runtime.runtimeGeneration,
        computerGeneration: runtime.computerGeneration,
        buildId: runtime.buildId,
        challengeSha256: receipt.challengeSha256,
        receiptSha256,
      });
      if (!attached.ok) return ProductConfigurationResultSchema.parse(attached);
      return ProductConfigurationResultSchema.parse({
        ...attached,
        evidence: {
          kind: "connector.attachment",
          runtimeGeneration: runtime.runtimeGeneration,
          computerGeneration: runtime.computerGeneration,
          workspaceId,
          challengeSha256: receipt.challengeSha256,
          receiptSha256,
        },
      });
    } finally {
      connectorAdmission.release();
    }
  }

  // Explicit connection checks and already-attached Setup verification share the
  // Go-owned dispatch/receipt contract. Startup, Deep Test and separate-app
  // recovery never invoke it.
  async function testConnectionCommand(
    command: ExplicitConnectionCheck,
    origin: "selected-task" | "setup" = "selected-task",
  ): Promise<ProductConfigurationResult> {
    const core = desktopGoCore();
    const config = configuration();
    if (!core || !config)
      return configurationFailure("CONNECTION_CHECK_HOST_NOT_READY");
    // Go's first claim supersedes every unsettled earlier attempt as unknown.
    // Admission is therefore checked and reserved synchronously BEFORE that
    // claim: a second check while one is live (for example after a renderer
    // reload) is refused here and never reaches Go to settle the live one.
    if (
      desktopAdmission.occupied("chatgpt-task") ||
      desktopAdmission.occupied("connector-task")
    )
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
    const connectorAdmission = desktopAdmission.reserveAdmitted(
      "connector-task",
      origin !== "setup" ? "manual-diagnostic" : null,
    );
    // An owner's own toolbar check is a manual diagnostic: it must not
    // flip the sidebar to "Checking connection…". Setup keeps its state.
    let expected: ConnectorAppVerificationBinding | null = null;
    let workspace: string | null | undefined;
    // True when the check ran on connectorCheckWorkspace's fallback because no
    // folder is currently verified: a tunnel check that records no attachment.
    let fallbackWorkspace = false;
    let outcome: ConnectionCheckCommandResult;
    try {
      outcome = await runExplicitConnectionCheck(
        command,
        {
          claim: (input) => core.claimConnectionCheck(input),
          prepare: (input) => core.prepareConnectionCheck(input),
          advance: (input) => core.advanceConnectionCheck(input),
          observe: (id) => core.observeConnectionCheck(id),
        },
        async () => {
          // This callback is reached only after FIRST durable admission. A replay
          // observes its original Go result without rebinding to today's page.
          // Desktop admission is already reserved for this command above.
          // A saved sign-in checkpoint is not the page. Ping sends from the
          // live ChatGPT document; prepareConnectorCheckDocument still requires
          // that document to read as signed in.
          function refusePrerequisites(
            reason: string,
            code: ConnectionCheckCode = "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
          ): never {
            console.error(`FAROL_CONNECTION_CHECK_REFUSED ${reason}`);
            throw new ConnectionCheckRefusal(code);
          }
          if (
            !embeddedBrowserEnabled() ||
            desktopAdmission.closed() ||
            desktopGoCore() !== core ||
            configuration() !== config ||
            (selectedTaskId() ?? "") !== command.taskId
          ) {
            return refusePrerequisites(
              `host embedded=${embeddedBrowserEnabled()} quit=${desktopAdmission.quitInProgress} update=${desktopAdmission.installedUpdateAdmission} core=${desktopGoCore() === core} config=${configuration() === config} task=${selectedTaskId() ?? ""}/${command.taskId}`,
              "CONNECTION_CHECK_HOST_NOT_READY",
            );
          }
          const route =
            origin !== "setup" && command.taskId
              ? liveTaskRoutes.get(command.taskId)
              : chatGptRoute();
          const owner = window();
          if (!route || !owner || owner.isDestroyed()) {
            return refusePrerequisites(
              `document route=${Boolean(route)} owner=${Boolean(owner)} destroyed=${owner?.isDestroyed() ?? true}`,
            );
          }
          const snapshot = config.snapshot();
          if (snapshot.status !== "ready") {
            return refusePrerequisites(
              `settings status=${snapshot.status}`,
              "CONNECTION_CHECK_HOST_NOT_READY",
            );
          }
          let settings = snapshot.settings;
          const connector = settings.connectors.secureMcp;
          const runtime = connector.runtime;
          const appName = selectedConnectorApp(connector);
          // Stale folder access must not block a tunnel ping: see
          // connectorCheckWorkspace. The currency check below uses it too.
          workspace = connectorCheckWorkspace(settings);
          fallbackWorkspace =
            connectorWorkspaceSelection(settings) === undefined;
          if (
            appName === null ||
            workspace === undefined ||
            connector.tunnelId === null ||
            runtime?.state !== "ready" ||
            runtime.buildId !== buildIdentity.buildId ||
            runtime.computerGeneration !== settings.computer.generation ||
            runtime.connectorGeneration !== connector.generation ||
            !connectionCheckRuntimeReady(secureMcpConnectorRuntime())
          ) {
            const live = secureMcpConnectorRuntime();
            return refusePrerequisites(
              `runtime app=${appName !== null} workspace=${workspace !== undefined} tunnel=${connector.tunnelId !== null} state=${runtime?.state ?? "missing"} build=${runtime?.buildId === buildIdentity.buildId} computer=${runtime?.computerGeneration === settings.computer.generation} connector=${runtime?.connectorGeneration === connector.generation} running=${live?.isRunning() ?? "missing"} unresolved=${live?.hasUnresolvedEffect() ?? "missing"}`,
              connectionCheckRuntimeRefusal({
                appSelected: appName !== null,
                workspaceKnown: workspace !== undefined,
                tunnelPresent: connector.tunnelId !== null,
                runtimeState: runtime?.state ?? "missing",
                buildCurrent: runtime?.buildId === buildIdentity.buildId,
                generationsCurrent:
                  runtime?.computerGeneration ===
                    settings.computer.generation &&
                  runtime?.connectorGeneration === connector.generation,
                running: live?.isRunning() ?? false,
                unresolvedEffect: live?.hasUnresolvedEffect() ?? false,
              }),
            );
          }
          // A persistent Setup uncertainty, not a check that is still running:
          // it never clears by pinging again, so it has its own code.
          if (
            settings.setup.connect.outcomeUnknown ||
            connector.appVerificationPending
          )
            throw new ConnectionCheckRefusal(
              "CONNECTION_CHECK_SETUP_UNRESOLVED",
            );
          const observed = await core.observeComputerConnectorVerification();
          const proof = connectorVerificationProof(observed);
          if (proof && proof.workspaceId !== workspace)
            throw new ConnectionCheckRefusal("CONNECTION_CHECK_OWNER_CHANGED");
          let challenge = connector.challenge;
          const challengeCurrent =
            challenge &&
            challenge.buildId === runtime.buildId &&
            challenge.runtimeGeneration === runtime.runtimeGeneration &&
            challenge.computerGeneration === runtime.computerGeneration;
          // Toolbar/setup ping is the @Farol challenge send. When the previous
          // one-time challenge was consumed and Go has no retained proof yet,
          // mint a fresh challenge against the live ready runtime instead of
          // refusing Send.
          if (!proof && !challengeCurrent) {
            const issued = await config.recordSecureMcpChallenge({
              challenge: randomUUID(),
              runtimeGeneration: runtime.runtimeGeneration,
              computerGeneration: runtime.computerGeneration,
              buildId: runtime.buildId,
            });
            if (!issued.ok || issued.snapshot.status !== "ready") {
              return refusePrerequisites("challenge-mint");
            }
            settings = issued.snapshot.settings;
            challenge = settings.connectors.secureMcp.challenge;
            if (
              !challenge ||
              challenge.buildId !== runtime.buildId ||
              challenge.runtimeGeneration !== runtime.runtimeGeneration ||
              challenge.computerGeneration !== runtime.computerGeneration
            ) {
              return refusePrerequisites("challenge-stale");
            }
          }
          const challengeSha256 =
            proof?.receipt.challengeSha256 ?? challenge!.challengeSha256;
          const binding: ConnectorAppVerificationBinding = {
            tunnelId: connector.tunnelId,
            connectorGeneration: connector.generation,
            computerGeneration: settings.computer.generation,
            runtimeGeneration: runtime.runtimeGeneration,
            buildId: runtime.buildId,
            challengeSha256,
            workspaceId: workspace,
            appName,
          };
          expected = binding;
          // Read legacy custody, never delete, renew or claim it in TS. Go performs
          // the exclusive schema-3 publication immediately before dispatch intent.
          if (
            !proof &&
            (await connectorAppVerificationAttemptExists(
              statePaths().secureMcpLaunch,
              challengeSha256,
            ))
          )
            throw new ConnectionCheckRefusal(
              "CONNECTION_CHECK_ALREADY_ATTEMPTED",
            );
          return {
            selection: {
              mode: proof ? ("status" as const) : ("bootstrap" as const),
              appName,
              model: "temporary-instant" as const,
              tunnelId: connector.tunnelId,
              computerGeneration: String(settings.computer.generation),
              ...(workspace === null ? {} : { workspaceId: workspace }),
              challengeDigest: challengeSha256,
              ...(proof ? {} : { challenge: challenge!.value }),
            },
            // Ping binds no document. Opening a fresh Temporary chat is a best
            // effort that leaves the owner's draft in the old document; when it
            // fails the check goes on in whatever chat is current, and a draft
            // that is still in the composer is the one thing that stops it.
            prepareDocument: async () => {
              // Never navigate away from an unsent draft or attachment: the
              // owner's text would be lost. Nothing is sent and nothing is
              // cleared; only an empty composer leads to a fresh chat.
              if (await route.composerHoldsContent(appName))
                throw new ConnectionCheckRefusal(
                  "CHATGPT_COMPOSER_DRAFT_PRESENT",
                );
              try {
                await route.openTemporaryChat();
              } catch {
                // The current chat is used.
              }
              return {
                documentDigest: connectionCheckDigest(
                  route.captureConnectionCheckDocument()?.identity ??
                    "current-chat",
                ),
              };
            },
            send: (prompt, observer) =>
              route.runReadonlyTask(prompt, [], observer, "temporary-instant", {
                name: appName,
              }),
          };
        },
      );
    } finally {
      chatAdmission.release();
      connectorAdmission.release();
      void connectorConnection
        .sample()
        .then(currentConnectionStatus)
        .catch(() => undefined);
    }
    if (outcome.state !== "verified") return configurationFailure(outcome.code);
    if (!outcome.retained) {
      if (
        !expected ||
        workspace === undefined ||
        desktopGoCore() !== core ||
        configuration() !== config
      )
        return configurationFailure("CONNECTION_CHECK_OUTCOME_UNKNOWN");
      if (fallbackWorkspace) {
        const latest = config.snapshot();
        // Still the same fallback owner: the strict selection stayed undefined
        // and every other binding field is unchanged. Anything else (including
        // a verification that now selects a folder) is not this check's owner.
        if (
          latest.status !== "ready" ||
          connectorWorkspaceSelection(latest.settings) !== undefined ||
          !connectorAppBindingCurrent(
            latest.settings,
            expected,
            connectorCheckWorkspace,
          )
        )
          return configurationFailure("CONNECTION_CHECK_OUTCOME_UNKNOWN");
        // The tunnel check succeeded, but the attachment is recorded only for
        // the strict selection, never for a fallback folder.
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: latest,
          evidence: {
            kind: "connector.connection-check",
            operationId: command.operationId,
            receiptSha256: outcome.receiptDigest,
            retained: false,
            attachmentRecorded: false,
            ...(outcome.steps ? { steps: outcome.steps } : {}),
          },
        });
      }
      // Only the existing sole Settings writer publishes attachment/setup state.
      // A historical replay never repeats this possibly unacknowledged write.
      const published = await checkSecureMcpAttachment(workspace, expected);
      if (!published.ok)
        return configurationFailure(
          published.error === "SETTINGS_WRITE_FAILED"
            ? "SETTINGS_WRITE_FAILED"
            : "CONNECTION_CHECK_OUTCOME_UNKNOWN",
        );
    }
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: config.snapshot(),
      evidence: {
        kind: "connector.connection-check",
        operationId: command.operationId,
        receiptSha256: outcome.receiptDigest,
        retained: outcome.retained,
        ...(outcome.steps ? { steps: outcome.steps } : {}),
      },
    });
  }

  return { checkSecureMcpAttachment, testConnectionCommand };
}
