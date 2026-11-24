import { randomUUID } from "node:crypto";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  journalUnderPromotionLease,
  type PromotionLeaseRegistry,
} from "../../../src/apps/desktop/chatgpt-journal-lease";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import {
  PrivateChatGptTaskJournal,
  type ChatGptTaskJournalRecord,
} from "../../../src/apps/desktop/chatgpt-task-journal";
import {
  ChatGptTaskJournalOperationIdSchema,
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
  MAX_DEEP_TEST_HISTORY_BYTES,
  MAX_DEEP_TEST_HISTORY_RECORDS,
  MAX_DEEP_TEST_OUTSTANDING,
} from "../../../src/apps/desktop/chatgpt-task-journal-record";
import type { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import type { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import type { selectedConnectorApp } from "../../../src/pkg/product-settings/connector-app-selection";
import type { currentConnectorAttachment } from "../../../src/apps/desktop/connector-app-receipt-wait";
import { readFlatDeepTestRecords } from "../../../src/apps/desktop/legacy-activation-obligations";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type {
  computerConnectorAdmission,
  SummaryFenceRecovery,
} from "../../../src/apps/desktop/summary-fence-recovery";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";

type DeepRoute = Pick<
  ChatGptRoute,
  "captureManualTaskTarget" | "runReadonlyTask"
>;

// The binding the check proves its attachment against. Main's own helper
// (`connectorAppBindingCurrent`) declares the same closed shape.
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

// Main owns the mutable state and the helper definitions. Everything here is a
// late getter, setter or callback, bound to its real receiver at call time; the
// module copies no state and constructs no owner of its own. `selectedTaskId`,
// `section` and `shellOverlay` are read afresh on every use, including each
// iteration of the layout wait, so a change made while a check waits is seen.
// `liveTaskRoutes` and `liveTaskRegistry` are `const` in main and are shared by
// reference.
export type ConfigurationDeepPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  desktopGoCore: () => Pick<
    DesktopGoCore,
    "backendAvailable" | "currentComputerConnectorBinding"
  > | null;
  secureMcpConnectorRuntime: () => Pick<
    SecureMcpConnectorRuntime,
    "isRunning" | "getTunnelObservation" | "hasUnresolvedEffect"
  > | null;
  chatGptRoute: () => DeepRoute | null;
  liveTaskRoutes: ReadonlyMap<string, DeepRoute>;
  selectedTaskId: () => string;
  section: () => string;
  shellOverlay: () => string;
  browserHomeSurfaceOpen: () => boolean;
  setBrowserHomeSurfaceOpen: (value: boolean) => void;
  deepTestRecoveryReady: () => boolean;
  setDeepTestRecoveryReady: (value: boolean) => void;
  recoverableDeepTests: () => readonly ChatGptTaskJournalRecord[];
  setRecoverableDeepTests: (value: readonly ChatGptTaskJournalRecord[]) => void;
  pendingChatGptReadonlyTask: () => object | null;
  pendingChatGptAttachmentTask: () => object | null;
  recoverableChatGptTask: () => object | null;
  connectorStartInFlight: () => Promise<void> | null;
  summaryFenceRecovery: () => SummaryFenceRecovery | null;
  desktopAdmission: Pick<
    DesktopAdmission,
    "closed" | "occupied" | "reserveAdmitted"
  >;
  liveTaskRegistry: PromotionLeaseRegistry;
  buildIdentity: Readonly<{ buildId: string }>;
  statePaths: () => Readonly<{ state: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  chatGptConversationAdmissionFailure: () => ProductConfigurationResult | null;
  currentSurfaceLayout: () => Readonly<{ pageVisible: boolean }> | null;
  connectorRuntimeUncertain: typeof connectorRuntimeUncertain;
  computerConnectorAdmission: typeof computerConnectorAdmission;
  currentConnectorAttachment: typeof currentConnectorAttachment;
  selectedConnectorApp: typeof selectedConnectorApp;
  connectorWorkspaceSelection: typeof connectorWorkspaceSelection;
  connectorAppBindingCurrent: (
    settings: ProductSettings,
    expected: ConnectorAppVerificationBinding,
  ) => boolean;
}>;

export function createConfigurationDeep(ports: ConfigurationDeepPorts) {
  const {
    configuration,
    desktopGoCore,
    secureMcpConnectorRuntime,
    chatGptRoute,
    liveTaskRoutes,
    selectedTaskId,
    section,
    shellOverlay,
    browserHomeSurfaceOpen,
    setBrowserHomeSurfaceOpen,
    deepTestRecoveryReady,
    setDeepTestRecoveryReady,
    recoverableDeepTests,
    setRecoverableDeepTests,
    pendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask,
    recoverableChatGptTask,
    connectorStartInFlight,
    summaryFenceRecovery,
    desktopAdmission,
    liveTaskRegistry,
    buildIdentity,
    statePaths,
    configurationFailure,
    chatGptConversationAdmissionFailure,
    currentSurfaceLayout,
    connectorRuntimeUncertain,
    computerConnectorAdmission,
    currentConnectorAttachment,
    selectedConnectorApp,
    connectorWorkspaceSelection,
    connectorAppBindingCurrent,
  } = ports;

  async function runManualDeepTest(
    operationId: string,
    expectedTaskId: string,
    test: "connection" | "deep" = "deep",
  ): Promise<ProductConfigurationResult> {
    if (!ChatGptTaskJournalOperationIdSchema.safeParse(operationId).success)
      return configurationFailure("SETTINGS_INPUT_INVALID");
    const owner = configuration();
    const core = desktopGoCore();
    const connector = secureMcpConnectorRuntime();
    const snapshot = owner?.snapshot();
    const originalRoute =
      expectedTaskId === ""
        ? chatGptRoute()
        : liveTaskRoutes.get(expectedTaskId);
    const targetCurrent = originalRoute?.captureManualTaskTarget();
    // The ChatGPT home document can already be on screen without the open-browser
    // flag. Treat that loaded page as the home surface instead of reporting a
    // phantom in-progress task.
    if (expectedTaskId === "" && targetCurrent) setBrowserHomeSurfaceOpen(true);
    if (selectedTaskId() !== expectedTaskId || !originalRoute || !targetCurrent)
      return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
    const deadline = performance.now() + 1500;
    while (
      shellOverlay() === "task-menu" &&
      selectedTaskId() === expectedTaskId &&
      section() === "browser" &&
      !desktopAdmission.closed() &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const routeTaskId = selectedTaskId();
    const route =
      routeTaskId === "" ? chatGptRoute() : liveTaskRoutes.get(routeTaskId);
    const binding = core?.currentComputerConnectorBinding();
    if (
      routeTaskId !== expectedTaskId ||
      !owner ||
      !core ||
      !core.backendAvailable ||
      !connector ||
      !route ||
      route !== originalRoute ||
      !targetCurrent() ||
      !binding ||
      snapshot?.status !== "ready" ||
      !deepTestRecoveryReady() ||
      desktopAdmission.closed() ||
      desktopAdmission.occupied("chatgpt-task") ||
      desktopAdmission.occupied("connector-task") ||
      pendingChatGptReadonlyTask() !== null ||
      pendingChatGptAttachmentTask() !== null ||
      recoverableChatGptTask() !== null ||
      connectorStartInFlight() !== null ||
      !connector.isRunning() ||
      connector.getTunnelObservation() !== null ||
      connector.hasUnresolvedEffect() ||
      !currentSurfaceLayout()?.pageVisible ||
      section() !== "browser" ||
      shellOverlay() !== "none" ||
      (routeTaskId === "" && !browserHomeSurfaceOpen())
    ) {
      console.error(
        `FAROL_DEEP_TEST_REFUSED chatgpt=${desktopAdmission.occupied("chatgpt-task")} connector=${desktopAdmission.occupied("connector-task")} running=${connector?.isRunning() ?? false} page=${currentSurfaceLayout()?.pageVisible === true} section=${section()} overlay=${shellOverlay()} home=${browserHomeSurfaceOpen()} task=${routeTaskId}`,
      );
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    }
    const conversationFailure = chatGptConversationAdmissionFailure();
    if (conversationFailure) return conversationFailure;
    const settings = snapshot.settings;
    if (
      settings.computer.pendingEdit ||
      settings.setup.computer.outcomeUnknown ||
      connectorRuntimeUncertain(settings) ||
      !computerConnectorAdmission(summaryFenceRecovery()).admissible
    )
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    const selected = settings.connectors.secureMcp;
    const attachment = currentConnectorAttachment(
      settings,
      buildIdentity.buildId,
    );
    const appName = selectedConnectorApp(selected);
    const runtime = selected.runtime;
    // Full check must send when the tunnel/runtime are live. A consumed
    // attachment is preferred; otherwise use (or mint) the same one-time
    // challenge Ping already uses. Missing attachment alone is not "not ready".
    let challenge = selected.challenge;
    const challengeCurrent =
      challenge != null &&
      runtime?.state === "ready" &&
      challenge.buildId === runtime.buildId &&
      challenge.runtimeGeneration === runtime.runtimeGeneration &&
      challenge.computerGeneration === runtime.computerGeneration;
    if (
      !appName ||
      !runtime ||
      runtime.state !== "ready" ||
      !selected.tunnelId ||
      selected.appVerificationPending === true ||
      binding.buildId !== buildIdentity.buildId ||
      binding.connectorGeneration !== String(selected.generation) ||
      (!attachment && !challengeCurrent)
    ) {
      if (
        !appName ||
        !runtime ||
        runtime.state !== "ready" ||
        !selected.tunnelId ||
        selected.appVerificationPending === true ||
        binding.buildId !== buildIdentity.buildId ||
        binding.connectorGeneration !== String(selected.generation)
      )
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
      const issued = await owner.recordSecureMcpChallenge({
        challenge: randomUUID(),
        runtimeGeneration: runtime.runtimeGeneration,
        computerGeneration: runtime.computerGeneration,
        buildId: runtime.buildId,
      });
      if (!issued.ok || issued.snapshot.status !== "ready")
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
      challenge = issued.snapshot.settings.connectors.secureMcp.challenge;
      if (
        !challenge ||
        challenge.buildId !== runtime.buildId ||
        challenge.runtimeGeneration !== runtime.runtimeGeneration ||
        challenge.computerGeneration !== runtime.computerGeneration
      )
        return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    }
    if (!appName || !runtime || runtime.state !== "ready" || !selected.tunnelId)
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    let workspaceId =
      attachment?.workspaceId ?? connectorWorkspaceSelection(settings);
    if (workspaceId === undefined) {
      const verifiedId = settings.setup.computer.verified?.workspaceId;
      workspaceId =
        verifiedId &&
        settings.computer.workspaces.some(
          (item) => item.workspaceId === verifiedId,
        )
          ? verifiedId
          : (settings.computer.workspaces[0]?.workspaceId ?? null);
    }
    const challengeSha256 =
      attachment?.challengeSha256 ?? challenge?.challengeSha256;
    if (!challengeSha256)
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    const expected: ConnectorAppVerificationBinding = {
      tunnelId: selected.tunnelId,
      connectorGeneration: selected.generation,
      computerGeneration: settings.computer.generation,
      runtimeGeneration: runtime.runtimeGeneration,
      challengeSha256,
      buildId: buildIdentity.buildId,
      workspaceId,
      appName,
    };
    const isCurrent = () => {
      const latest = owner.snapshot();
      // connectorAppBindingCurrent already accepts live challenge or attachment.
      return (
        configuration() === owner &&
        desktopGoCore() === core &&
        core.backendAvailable &&
        secureMcpConnectorRuntime() === connector &&
        connector.isRunning() &&
        connector.getTunnelObservation() === null &&
        targetCurrent() &&
        !connector.hasUnresolvedEffect() &&
        core.currentComputerConnectorBinding() === binding &&
        !desktopAdmission.closed() &&
        selectedTaskId() === routeTaskId &&
        (routeTaskId === ""
          ? chatGptRoute() === route && browserHomeSurfaceOpen()
          : liveTaskRoutes.get(routeTaskId) === route) &&
        section() === "browser" &&
        shellOverlay() === "none" &&
        currentSurfaceLayout()?.pageVisible === true &&
        latest.status === "ready" &&
        !latest.settings.computer.pendingEdit &&
        !latest.settings.setup.computer.outcomeUnknown &&
        !connectorRuntimeUncertain(latest.settings) &&
        computerConnectorAdmission(summaryFenceRecovery()).admissible &&
        !latest.settings.setup.chatgpt.outcomeUnknown &&
        latest.settings.connectors.secureMcp.appVerificationPending !== true &&
        connectorAppBindingCurrent(latest.settings, expected)
      );
    };
    const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
    const connectorAdmission = desktopAdmission.reserveAdmitted(
      "connector-task",
      "manual-diagnostic",
    );
    let prepared = false;
    let intent = false;
    try {
      const journal = new PrivateChatGptTaskJournal({
        root: statePaths().state,
        deepTestOperationId: operationId,
      });
      await journalUnderPromotionLease(liveTaskRegistry, async () => {
        if (!isCurrent()) throw new Error("DEEP_TEST_CHANGED");
        const scan = await readFlatDeepTestRecords(statePaths().state);
        if (
          scan.status === "unreadable" ||
          (scan.status === "read" &&
            (scan.value.length >= MAX_DEEP_TEST_HISTORY_RECORDS ||
              scan.totalBytes +
                MAX_CHATGPT_TASK_JOURNAL_BYTES *
                  (MAX_DEEP_TEST_OUTSTANDING + 1) >
                MAX_DEEP_TEST_HISTORY_BYTES ||
              scan.value.filter(
                (record) => record.phase !== "delivery_acknowledged",
              ).length >= MAX_DEEP_TEST_OUTSTANDING)) ||
          !isCurrent()
        )
          throw new Error("DEEP_TEST_UNAVAILABLE");
        await journal.prepare({ operationId, kind: "readonly" });
        prepared = true;
      });
      const prompt =
        test === "connection"
          ? `Use the selected ${appName} app to call computer_connection_status once. Report the observed result briefly; do not read or change files.`
          : `Run a manual Deep test using the selected ${appName} app. List approved workspaces and choose the first available yourself; if none is available, stop. Exercise connection status and bounded file listing and reading without opening secrets or unrelated personal data. Where the existing grant permits, create only the new uniquely named root-level file farol-deep-test-${operationId}.txt with computer_workspace_write and expectedSha256: null (create-only). Do not list or read that nonexistent test path before creating it, and do not create a directory. If creation is refused, stop without changing the operation ID. After confirmed creation, read only this new file and test edit with its returned exact SHA-256. For shell smoke, where granted, run only bounded pwd and printf checks in the selected workspace. Treat cleanup as a separate case: only if this run's create and edit outcomes are known, the exact file path and current contents are confirmed, no external writer is expected, and the current write grant allows it, you may use Shell with write:true and pinned /bin/rm on that one exact path. Use a separate operation ID and observe its original result; do not use globs or recursive removal. After known success, verify the target is absent and any test canary is preserved. A pre-removal check is not an atomic compare-and-delete against external writers. If these conditions are not met, leave the file and report cleanup NOT RUN. Never modify or delete pre-existing items, bypass permissions or confirmations, or retry a refused or uncertain effect. Never clean up after an unknown effect. Stop on any unknown outcome. Report shell smoke and cleanup separately as PASS, FAIL, or NOT RUN, and report each other capability with observed evidence and limitations; do not claim full success when a case was not run.`;
      const result = await route.runReadonlyTask(
        prompt,
        [],
        {
          manualDeepTest: true,
          manualSubmissionOnly: true,
          beforeSend: isCurrent,
          onDispatchIntent: async () => {
            if (!isCurrent()) throw new Error("DEEP_TEST_CHANGED");
            if (!intent) {
              await journalUnderPromotionLease(liveTaskRegistry, () =>
                journal.markDispatchIntent(operationId),
              );
              intent = true;
            }
            if (!isCurrent()) throw new Error("DEEP_TEST_CHANGED");
          },
        },
        "ordinary",
        { name: appName },
      );
      const journalResult = {
        state: result.state,
        code: result.code,
        deltaCount: result.deltaCount,
        observedCharacters: result.observedCharacters,
      };
      if (intent) await journal.retainResult(operationId, journalResult);
      else await journal.retainPreDispatchResult(operationId, journalResult);
      const retained = await journal.load();
      if (!retained) throw new Error("DEEP_TEST_RESULT_MISSING");
      setRecoverableDeepTests([...recoverableDeepTests(), retained]);
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: owner.snapshot(),
        evidence: {
          kind: "chatgpt.deep-test-result",
          operationId,
          state: result.state,
          code: result.code,
        },
      });
    } catch {
      if (prepared) setDeepTestRecoveryReady(false);
      return configurationFailure(
        prepared
          ? "CHATGPT_CONVERSATION_UNCONFIRMED"
          : "CHATGPT_TASK_JOURNAL_FAILED",
      );
    } finally {
      chatAdmission.release();
      connectorAdmission.release();
    }
  }

  function deepTestStatus(): ProductConfigurationResult {
    const owner = configuration();
    if (!owner || !deepTestRecoveryReady())
      return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: owner.snapshot(),
      evidence: {
        kind: "chatgpt.deep-test-status",
        attempts: recoverableDeepTests()
          .filter(
            (record) =>
              record.phase === "result_retained" && record.result !== null,
          )
          .map((record) => ({
            operationId: record.operationId,
            state: record.result!.state,
            code: record.result!.code,
          })),
      },
    });
  }

  async function acknowledgeDeepTest(
    operationId: string,
  ): Promise<ProductConfigurationResult> {
    if (
      desktopAdmission.occupied("chatgpt-task") ||
      desktopAdmission.occupied("connector-task") ||
      !deepTestRecoveryReady()
    )
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    const record = recoverableDeepTests().find(
      (item) =>
        item.operationId === operationId &&
        item.phase === "result_retained" &&
        item.result !== null,
    );
    if (!record) return configurationFailure("CHATGPT_TASK_RESULT_NOT_FOUND");
    const journal = new PrivateChatGptTaskJournal({
      root: statePaths().state,
      deepTestOperationId: record.operationId,
    });
    try {
      await journalUnderPromotionLease(liveTaskRegistry, () =>
        journal.acknowledgeDelivery(record.operationId),
      );
      setRecoverableDeepTests(
        recoverableDeepTests().filter((item) => item !== record),
      );
      return deepTestStatus();
    } catch {
      setDeepTestRecoveryReady(false);
      return configurationFailure("CHATGPT_CONVERSATION_UNCONFIRMED");
    }
  }

  return Object.freeze({
    runManualDeepTest,
    deepTestStatus,
    acknowledgeDeepTest,
  });
}
