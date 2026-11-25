import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import {
  currentConnectorAttachment,
  type waitForConnectorAppReceipt,
} from "../../../src/apps/desktop/connector-app-receipt-wait";
import type {
  confirmSeparateAppVerificationAttempt,
  connectorAppVerificationAttemptExists,
  prepareConnectorAppVerificationAttempt,
  SeparateAppVerification,
} from "../../../src/apps/desktop/connector-app-verification-attempt";
import type { connectorVerificationProof } from "../../../src/apps/desktop/connector-verification-proof";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import { channels } from "../../../src/pkg/ipc/channels";
import { selectedConnectorApp } from "../../../src/pkg/product-settings/connector-app-selection";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import type {
  ProductConfigurationResult,
  SeparateAppVerificationScope,
} from "../../../src/pkg/product-settings/contract";
import { separateAppVerificationScopeCurrent } from "../../../src/pkg/product-settings/separate-app-verification";
import type { prepareConnectorCheckDocument } from "../bridge/connector-check-readiness";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";
import type { MaintenanceObservation } from "../recovery/diagnostics";
import {
  connectorAppBindingCurrent,
  type ConnectorAppVerificationBinding,
  type createConnectorCheck,
} from "./check";
import type { connectorSupervisor } from "./supervisor";

// Verifying the ChatGPT app or connector attachment for the one Secure MCP
// connector, and reporting a startup maintenance observation. Main keeps every
// owner; each `let` there is a late getter here, read afresh after every await
// at the same place the original read it. A check that is already attached is
// handed to the connection check; a first verification reserves both task
// routes before its first await, claims Go's one verification before it sends,
// and sends at most one ChatGPT message. A refusal before that claim sends
// nothing, and a lost reply is observed again from its original receipt, never
// sent a second time.

type Supervisor = ReturnType<typeof connectorSupervisor>;
type Check = ReturnType<typeof createConnectorCheck>;

export type ConnectorVerifyPorts = Readonly<{
  configuration: () => Pick<
    ProductConfigurationService,
    | "snapshot"
    | "recordSecureMcpAppPending"
    | "clearSecureMcpAppPendingBeforeSubmit"
  > | null;
  chatGptRoute: () => ChatGptRoute | null;
  secureMcpConnectorRuntime: () => Pick<
    SecureMcpConnectorRuntime,
    "isRunning"
  > | null;
  desktopGoCore: () => Pick<
    DesktopGoCore,
    "observeComputerConnectorVerification"
  > | null;
  window: () => BrowserWindow | null;
  selectedTaskId: () => string;
  desktopAdmission: Pick<
    DesktopAdmission,
    "occupied" | "closed" | "reserveAdmitted"
  >;
  buildIdentity: Readonly<{ buildId: string }>;
  runtimeEnvironment: string;
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  writeStderr: (text: string) => void;
  randomUUID: () => string;
  statePaths: () => Readonly<{ secureMcpLaunch: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  embeddedBrowserEnabled: () => boolean;
  chatGptTaskAdmissionReady: () => boolean;
  showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<Readonly<{ response: number }>>;
  connectorCheck: () => Pick<
    Check,
    "testConnectionCommand" | "checkSecureMcpAttachment"
  >;
  connectorConnection: Pick<Supervisor["connectorConnection"], "sample">;
  currentConnectionStatus: Supervisor["currentConnectionStatus"];
  connectorVerificationProof: typeof connectorVerificationProof;
  connectorAppVerificationAttemptExists: typeof connectorAppVerificationAttemptExists;
  confirmSeparateAppVerificationAttempt: typeof confirmSeparateAppVerificationAttempt;
  prepareConnectorAppVerificationAttempt: typeof prepareConnectorAppVerificationAttempt;
  prepareConnectorCheckDocument: typeof prepareConnectorCheckDocument;
  waitForConnectorAppReceipt: typeof waitForConnectorAppReceipt;
}>;

export function createConnectorVerify(ports: ConnectorVerifyPorts) {
  const {
    configuration,
    chatGptRoute,
    secureMcpConnectorRuntime,
    desktopGoCore,
    window,
    selectedTaskId,
    desktopAdmission,
    buildIdentity,
    runtimeEnvironment,
    env,
    pid,
    writeStderr,
    randomUUID,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    chatGptTaskAdmissionReady,
    showMessageBox,
    connectorCheck,
    connectorConnection,
    currentConnectionStatus,
    connectorVerificationProof,
    connectorAppVerificationAttemptExists,
    confirmSeparateAppVerificationAttempt,
    prepareConnectorAppVerificationAttempt,
    prepareConnectorCheckDocument,
    waitForConnectorAppReceipt,
  } = ports;

  function reportMaintenanceObservation(
    observation: MaintenanceObservation,
  ): void {
    if (runtimeEnvironment !== "dev" && env.FAROL_E2E !== "1") return;
    try {
      writeStderr(
        "FAROL_STARTUP_MAINTENANCE:" +
          JSON.stringify({
            schema: 1,
            buildId: buildIdentity.buildId,
            pid,
            ...observation,
          }) +
          "\n",
      );
    } catch {
      /* Diagnostics never grant recovery or retry. */
    }
  }

  // Bootstrap and separate-app recovery retain their existing challenge workflow.
  // Already-attached Setup checks use the same Go owner as the explicit toolbar.
  async function verifySecureMcpApp(
    separate?: SeparateAppVerificationScope,
  ): Promise<ProductConfigurationResult> {
    if (!embeddedBrowserEnabled()) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_UNAVAILABLE");
    }
    if (!configuration() || !chatGptRoute() || !secureMcpConnectorRuntime()) {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    if (
      desktopAdmission.occupied("chatgpt-task") ||
      desktopAdmission.occupied("connector-task")
    ) {
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    }
    const verificationCore = desktopGoCore();
    if (!verificationCore)
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    const initial = configuration()!.snapshot();
    if (!separate && initial.status === "ready") {
      const workspaceId = connectorWorkspaceSelection(initial.settings);
      if (
        workspaceId !== undefined &&
        currentConnectorAttachment(
          initial.settings,
          buildIdentity.buildId,
          workspaceId,
        )
      )
        return connectorCheck().testConnectionCommand(
          {
            kind: "connector.test-connection",
            operationId: randomUUID(),
            taskId: selectedTaskId() ?? "",
          },
          "setup",
        );
    }
    // Reserve both routes before the first await so concurrent IPC calls cannot
    // both pass the check and race to claim or release the same verification.
    const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
    const connectorAdmission =
      desktopAdmission.reserveAdmitted("connector-task");
    let requestedWorkspaceId: string | null | undefined;
    let receiptPending = false;
    let expectedBinding: ConnectorAppVerificationBinding | null = null;
    let verificationRoute: ChatGptRoute | null = null;
    try {
      const snapshot = configuration()!.snapshot();
      if (snapshot.status !== "ready")
        return configurationFailure("SETTINGS_UNAVAILABLE");
      const settings = snapshot.settings;
      const connector = settings.connectors.secureMcp;
      const runtime = connector.runtime;
      const challenge = connector.challenge;
      const appName = selectedConnectorApp(connector);
      if (appName === null)
        return configurationFailure("CONNECTOR_APP_TARGET_REQUIRED");
      const workspaceId = connectorWorkspaceSelection(settings);
      const proofScope = challenge;
      if (
        !chatGptTaskAdmissionReady() ||
        desktopAdmission.closed() ||
        !secureMcpConnectorRuntime()!.isRunning() ||
        connector.tunnelId === null ||
        runtime?.state !== "ready" ||
        runtime.buildId !== buildIdentity.buildId ||
        runtime.computerGeneration !== settings.computer.generation ||
        runtime.connectorGeneration !== connector.generation ||
        proofScope === null ||
        proofScope.buildId !== runtime.buildId ||
        proofScope.computerGeneration !== runtime.computerGeneration ||
        proofScope.runtimeGeneration !== runtime.runtimeGeneration ||
        workspaceId === undefined
      ) {
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
      }
      if (connector.tunnelId === null) {
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
      }
      requestedWorkspaceId = workspaceId;
      expectedBinding = {
        tunnelId: connector.tunnelId,
        connectorGeneration: connector.generation,
        computerGeneration: settings.computer.generation,
        runtimeGeneration: runtime.runtimeGeneration,
        challengeSha256: proofScope.challengeSha256,
        buildId: runtime.buildId,
        workspaceId,
        appName,
      };
      let separateAttempt: SeparateAppVerification | undefined;
      if (separate) {
        if (
          !separateAppVerificationScopeCurrent(
            settings,
            separate,
            buildIdentity.buildId,
          )
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
          );
        try {
          // Positive current-Go observation is distinct from absence of an old
          // disk claim. No receipt or unsettled Go verification may be replayed.
          const observed =
            await verificationCore.observeComputerConnectorVerification();
          if (
            observed.receipt !== undefined ||
            observed.catalogueReceipt !== undefined ||
            observed.receiptSha256 !== undefined
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
            );
          const current = configuration()!.snapshot();
          if (
            desktopGoCore() !== verificationCore ||
            current.status !== "ready" ||
            !separateAppVerificationScopeCurrent(
              current.settings,
              separate,
              buildIdentity.buildId,
            )
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          const owner = window();
          if (!owner || owner.isDestroyed())
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
            );
          separateAttempt = await confirmSeparateAppVerificationAttempt(
            { expected: separate, binding: observed.binding },
            {
              current: (attempt) => {
                const latest = configuration()!.snapshot();
                return (
                  window() === owner &&
                  !owner.isDestroyed() &&
                  desktopGoCore() === verificationCore &&
                  latest.status === "ready" &&
                  separateAppVerificationScopeCurrent(
                    latest.settings,
                    attempt.expected,
                    buildIdentity.buildId,
                  )
                );
              },
              confirm: async () => {
                const answer = await showMessageBox(owner, {
                  type: "question",
                  buttons: ["Cancel", "Test in ChatGPT"],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true,
                  message: "Test this connection in ChatGPT?",
                  detail: `Send one test message using ${appName}. Earlier unconfirmed tests stay in Activity and will not be repeated.`,
                });
                return answer.response === 1;
              },
            },
          );
          // A native prompt can remain open while the runtime changes. Owner
          // consent cannot carry a stale Go binding into a later dispatch.
          const afterConsent =
            await verificationCore.observeComputerConnectorVerification();
          if (
            desktopGoCore() !== verificationCore ||
            Object.entries(separateAttempt.binding).some(
              ([key, value]) =>
                afterConsent.binding[
                  key as keyof typeof afterConsent.binding
                ] !== value,
            )
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          if (
            afterConsent.receipt !== undefined ||
            afterConsent.catalogueReceipt !== undefined ||
            afterConsent.receiptSha256 !== undefined
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
            );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message ===
              "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED" ||
              error.message === "CONNECTOR_APP_VERIFICATION_STATE_CHANGED")
          )
            return configurationFailure(error.message);
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
          );
        }
      } else if (settings.setup.connect.outcomeUnknown) {
        return configurationFailure(
          "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
        );
      }
      const stateRoot = statePaths().secureMcpLaunch;
      try {
        if (
          await connectorAppVerificationAttemptExists(
            stateRoot,
            proofScope.challengeSha256,
          )
        ) {
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
          );
        }
      } catch {
        return configurationFailure(
          "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
        );
      }
      // Use the retained browser as a browser. A new temporary document keeps
      // Chromium history, without a second window or a parallel conversation.
      verificationRoute = chatGptRoute()!;
      const preparedDocument = await prepareConnectorCheckDocument(
        verificationRoute,
        () => {
          const latest = configuration()!.snapshot();
          return (
            !desktopAdmission.closed() &&
            desktopGoCore() === verificationCore &&
            latest.status === "ready" &&
            expectedBinding !== null &&
            connectorAppBindingCurrent(latest.settings, expectedBinding)
          );
        },
      );
      if (!preparedDocument.ready) {
        console.warn(
          `FAROL_CONNECTOR_CHECK_PREFLIGHT:${JSON.stringify({ schema: 1, stage: preparedDocument.stage })}`,
        );
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
      }
      const prompt =
        workspaceId === null
          ? `Use the selected ${appName} app to call farol_connector_verify_catalogue once with challenge "${challenge!.value}". No workspace is configured. Do not read files or run commands. Reply briefly with the result.`
          : `Use the selected ${appName} app to call farol_connector_verify once with challenge "${challenge!.value}" and workspaceId "${workspaceId}". Do not read file contents. Reply briefly with the result.`;
      let claimed = false;
      const timingId = runtimeEnvironment === "dev" ? randomUUID() : null;
      const result = await verificationRoute.runReadonlyTask(
        prompt,
        [],
        {
          ...(timingId === null
            ? {}
            : {
                onConnectorTiming: (event) => {
                  console.warn(
                    `FAROL_CONNECTOR_CHECK_TIMING:${JSON.stringify({ schema: 1, id: timingId, ...event })}`,
                  );
                },
              }),
          readConnectorReceipt: async () => {
            const current = configuration()!.snapshot();
            if (
              !claimed ||
              current.status !== "ready" ||
              expectedBinding === null ||
              !connectorAppBindingCurrent(current.settings, expectedBinding)
            )
              return false;
            const observed =
              await verificationCore.observeComputerConnectorVerification();
            const proof = connectorVerificationProof(observed);
            if (!proof || desktopGoCore() !== verificationCore) return false;
            const { receipt, workspaceId } = proof;
            const afterRead = configuration()!.snapshot();
            if (
              afterRead.status !== "ready" ||
              !connectorAppBindingCurrent(afterRead.settings, expectedBinding)
            )
              return false;
            return (
              receipt.challengeSha256 === expectedBinding.challengeSha256 &&
              workspaceId === expectedBinding.workspaceId &&
              receipt.binding.buildId === expectedBinding.buildId &&
              receipt.binding.connectorGeneration ===
                String(expectedBinding.connectorGeneration)
            );
          },
          onDispatchIntent: async () => {
            if (claimed) return;
            const admitted = configuration()!.snapshot();
            if (
              desktopAdmission.closed() ||
              desktopGoCore() !== verificationCore ||
              admitted.status !== "ready" ||
              expectedBinding === null ||
              (separateAttempt &&
                !separateAppVerificationScopeCurrent(
                  admitted.settings,
                  separateAttempt.expected,
                  buildIdentity.buildId,
                )) ||
              !connectorAppBindingCurrent(admitted.settings, expectedBinding)
            )
              throw new Error("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
            await prepareConnectorAppVerificationAttempt(
              stateRoot,
              proofScope.challengeSha256,
              async () =>
                (
                  await configuration()!.recordSecureMcpAppPending(
                    runtime.runtimeGeneration,
                  )
                ).ok,
              separateAttempt,
            );
            claimed = true;
          },
        },
        "temporary-instant",
        { name: appName },
      );
      if (
        result.state === "failed_before_submit" ||
        result.state === "not_authenticated"
      ) {
        const beforeSubmit = configuration()!.snapshot();
        if (
          beforeSubmit.status !== "ready" ||
          !connectorAppBindingCurrent(beforeSubmit.settings, expectedBinding)
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
          );
        if (
          !separateAttempt &&
          beforeSubmit.settings.setup.connect.outcomeUnknown
        ) {
          const cleared =
            await configuration()!.clearSecureMcpAppPendingBeforeSubmit(
              expectedBinding,
            );
          if (!cleared.ok)
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
            );
        }
        const preSubmitCode = result.code;
        return configurationFailure(
          preSubmitCode === "CHATGPT_APP_SELECTION_MISSING" ||
            preSubmitCode === "CHATGPT_APP_SELECTION_AMBIGUOUS" ||
            preSubmitCode === "CHATGPT_APP_SELECTION_CONFLICT" ||
            preSubmitCode === "CHATGPT_APP_SELECTION_LOST" ||
            preSubmitCode === "CHATGPT_COMPOSER_DRAFT_PRESENT" ||
            preSubmitCode === "CHATGPT_TEMPORARY_CHAT_REQUIRED" ||
            preSubmitCode === "CHATGPT_INSTANT_MODEL_REQUIRED"
            ? preSubmitCode
            : "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
        );
      }
      if (!claimed) {
        return configurationFailure(
          result.state === "outcome_unknown"
            ? "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
            : "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
        );
      }
      receiptPending = true;
      const current = configuration()!.snapshot();
      if (
        current.status !== "ready" ||
        expectedBinding === null ||
        !connectorAppBindingCurrent(current.settings, expectedBinding)
      ) {
        return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      }
    } finally {
      chatAdmission.release();
      connectorAdmission.release();
      // Join any observation started before the fence ended, then take a fresh
      // passive sample. The observer owns identity, expiry and shutdown checks.
      void connectorConnection
        .sample()
        .then(() => connectorConnection.sample())
        .then(currentConnectionStatus)
        .catch(() => undefined);
      // The managed task can temporarily suppress pure page observations. Ask
      // the renderer to read the retained document again after that fence ends.
      try {
        const routeWindow = window();
        if (
          verificationRoute &&
          routeWindow &&
          !routeWindow.isDestroyed() &&
          routeWindow.webContents &&
          !routeWindow.webContents.isDestroyed()
        )
          routeWindow.webContents.send(channels.browserRouteState, {
            state: verificationRoute.loadState(),
          });
      } catch {
        // A closing renderer cannot change the original check result.
      }
    }
    if (requestedWorkspaceId === undefined || expectedBinding === null) {
      return configurationFailure(
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
      );
    }
    if (!receiptPending) {
      return configurationFailure(
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
      );
    }
    type ReceiptProbe = Readonly<
      | { state: "changed" }
      | {
          state: "receipt";
          challengeSha256: string;
          workspaceId: string | null;
        }
    >;
    let observed: ReceiptProbe | null;
    try {
      observed = await waitForConnectorAppReceipt<ReceiptProbe>(
        async () => {
          const current = configuration()?.snapshot();
          if (
            current?.status !== "ready" ||
            !connectorAppBindingCurrent(current.settings, expectedBinding)
          ) {
            return { state: "changed" };
          }
          if (desktopGoCore() !== verificationCore) return { state: "changed" };
          const state =
            await verificationCore.observeComputerConnectorVerification();
          const proof = connectorVerificationProof(state);
          if (!proof) return null;
          return {
            state: "receipt",
            challengeSha256: proof.receipt.challengeSha256,
            workspaceId: proof.workspaceId,
          };
        },
        (probe) =>
          probe.state === "changed" ||
          (probe.challengeSha256 === expectedBinding.challengeSha256 &&
            probe.workspaceId === requestedWorkspaceId),
      );
    } catch {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
    }
    if (observed === null) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
    }
    if (observed.state === "changed") {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    }
    return connectorCheck().checkSecureMcpAttachment(
      requestedWorkspaceId,
      expectedBinding,
    );
  }
  return { reportMaintenanceObservation, verifySecureMcpApp };
}
