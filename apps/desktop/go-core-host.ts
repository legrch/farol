import path from "node:path";
import { randomUUID } from "node:crypto";
import { AttestedCore } from "./bridge/attested-core.ts";
import {
  desktopCoreExpectation,
  readDesktopCoreDeclaration,
} from "./bridge/desktop-artifact.ts";
import {
  BridgeError,
  copyNativeCodexReadLaunch,
  type BackendLifecycleObservation,
  type Client,
  type NativeCodexReadSelection,
} from "./bridge/client.ts";
import { ComputerBridge } from "./bridge/computer.ts";
import { ConnectorHostBridge } from "./bridge/connector-host.ts";
import { BrowserPump, type BrowserDriver } from "./bridge/browser.ts";
import { ChatBridge } from "./bridge/chat.ts";
import { ChatHistoryBridge } from "./bridge/chat-history.ts";
import { RecoveryArchiveReader } from "./recovery/archive.ts";
import { ChatComputerBridge } from "./bridge/chat-computer.ts";
import { ChatCallerBridge } from "./bridge/chat-caller.ts";
import { ReadIntentBridge } from "./bridge/read-intent.ts";
import { SettingsDeliveryBridge } from "./bridge/settings-delivery.ts";
import { TaskModelPolicyBridge } from "./bridge/task-model-policy.ts";
import { TaskModelCatalogueBridge } from "./bridge/task-model-catalogue.ts";
import { TaskCurrentSettingsBridge } from "./bridge/task-current-settings.ts";
import type { TaskSelectionRequest } from "../../src/pkg/owner-config/contract";
import {
  SettingsStorePump,
  type SettingsStoreDriver,
} from "./bridge/settings-store.ts";
import {
  validate,
  type Context,
  type CoreRetirementPrepared,
  type CoreRetirementAcknowledged,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatReadIntentResolve,
  type ChatReadIntentAccountApprove,
  type ChatReadIntentAccountRevoke,
  type SettingsStorePending,
  type ComputerConnectorBinding,
} from "./bridge/wire.ts";
import { qualifyProfileLaunch } from "./bridge/profile.ts";
import { openNativeProfileStorage } from "./bridge/profile-storage.ts";
import {
  CORE_QUALIFICATION_BUDGET_MS,
  verifyCoreResources,
} from "./bridge/core-resources.ts";
import { bindShellSupportDeclaration } from "./bridge/shell-support.ts";
import { attestShellRuntime } from "./bridge/shell-runtime.ts";
import type { QualificationObserver } from "./bridge/qualification-metrics.ts";
import { encodeShellLaunch } from "./bridge/shell-launch.ts";
import { GoComputerAuthority } from "./go-computer-authority.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Cold startup validates the selected runtime and opens retained journals before
// answering the first handshake. Ordinary RPC deadlines stay unchanged.
export const DESKTOP_CORE_STARTUP_TIMEOUT_MS = 15_000;

export type DesktopBrowserConnection = Readonly<{
  driver: BrowserDriver;
  // Synchronously revoke the exact host assignments before closing the pipe.
  // Revocation does not claim provider cancellation or clean module retirement.
  withdraw: () => void;
}>;

export type DesktopCoreSelection = Readonly<{
  // Trusted opt-in only. Ordinary Electron startup leaves this unselected;
  // saved source metadata is not native/provider qualification.
  codexRead?: NativeCodexReadSelection;
  // Compiled into this host by the exact production builder, not environment,
  // renderer data, a runtime file's own claim or a freshly measured binary hash.
  compiledArtifact: unknown;
  compiledResources?: unknown;
  // Optional, independently qualified builder input. A runtime file, renderer
  // value, or successful measurement cannot supply this release selection.
  compiledShell?:
    | Readonly<{
        support: unknown;
        watchdogSource: Uint8Array;
      }>
    | undefined;
  // Captured before the new host writes its run marker. Only the exact prior
  // host's confirmed drain can clear that marker; Go terminal bytes cannot.
  previousHostDrainConfirmed: boolean;
  startupPurpose?: "fresh";
  withInactiveMcp?<T>(start: () => Promise<T>): Promise<T>;
  build: BuildIdentity;
  artifactRoot: string;
  stateRoot: string;
  home: string;
  settings: () => ProductSettings;
  browser: (context: Readonly<Context>) => DesktopBrowserConnection;
  onLifecycleObservation?: (observation: BackendLifecycleObservation) => void;
  onQualificationObservation?: QualificationObserver;
}>;

// One normal Electron-owned backend lifetime. This class only composes the real
// Go authorities and typed adapters; it cannot grant permission or restart work.
export class DesktopGoCore {
  private readonly authority: GoComputerAuthority;
  private readonly computer: ComputerBridge;
  private readonly connector: ConnectorHostBridge | undefined;
  private readonly readIntent: ReadIntentBridge;
  private readonly historyBridge: ChatHistoryBridge;
  private readonly retiredArchiveReader: RecoveryArchiveReader;
  private readonly settingsDelivery: SettingsDeliveryBridge;
  private readonly taskModelPolicy: TaskModelPolicyBridge;
  private readonly taskModelCatalogue: TaskModelCatalogueBridge;
  private readonly taskCurrentSettings: TaskCurrentSettingsBridge;
  private settingsStorePump: SettingsStorePump | undefined;
  private readonly sessionId = randomUUID();
  private browser: DesktopBrowserConnection | undefined;
  private pump: BrowserPump | undefined;
  private chatBridge: ChatBridge | undefined;
  private chatComputerBridge: ChatComputerBridge | undefined;
  private chatCallerBridge: ChatCallerBridge | undefined;
  private closeResult: Promise<void> | undefined;
  private browserConnected = false;
  constructor(
    private readonly client: Client,
    private readonly settings: () => ProductSettings,
    private readonly completeRetirement?: (
      ack: CoreRetirementAcknowledged,
    ) => Promise<void>,
    private readonly hasMutationStorage = false,
    buildId?: string,
    private readonly qualifiedShell = false,
    private readonly freshSession = false,
  ) {
    this.authority = new GoComputerAuthority(client, client.verifiedContext);
    this.computer = new ComputerBridge(client);
    this.connector =
      buildId === undefined
        ? undefined
        : new ConnectorHostBridge(client, client.verifiedContext, buildId);
    this.readIntent = new ReadIntentBridge(client);
    this.historyBridge = new ChatHistoryBridge(client);
    this.retiredArchiveReader = new RecoveryArchiveReader(
      client,
      client.verifiedContext,
      "chat.retired",
    );
    this.settingsDelivery = new SettingsDeliveryBridge(client);
    this.taskModelPolicy = new TaskModelPolicyBridge(client);
    this.taskModelCatalogue = new TaskModelCatalogueBridge(client);
    this.taskCurrentSettings = new TaskCurrentSettingsBridge(client);
  }
  connectSettingsStore(
    driver: (profileId: string) => SettingsStoreDriver,
  ): void {
    if (this.closeResult || this.settingsStorePump)
      throw new BridgeError("refused", "host_settings_store_unavailable");
    if (!this.hasMutationStorage) return;
    this.settingsStorePump = new SettingsStorePump(
      this.client,
      driver(this.client.verifiedContext.profileId),
    );
    this.settingsStorePump.start();
  }
  connectBrowser(connection: DesktopBrowserConnection): void {
    if (this.browser || this.closeResult)
      throw new BridgeError("refused", "host_browser_already_selected");
    this.browser = connection;
    this.pump = new BrowserPump(this.client, connection.driver, (failure) => {
      console.warn(`FAROL_BROWSER_FAILURE ${JSON.stringify(failure)}`);
    });
    this.chatBridge = new ChatBridge(this.client);
    this.chatComputerBridge = new ChatComputerBridge(this.client);
    this.chatCallerBridge = new ChatCallerBridge(this.client);
    this.pump.start();
    this.browserConnected = true;
  }
  get independentSession(): boolean {
    return this.freshSession;
  }
  get limitedSession(): boolean {
    return this.freshSession && !this.hasMutationStorage;
  }
  get chat(): ChatBridge {
    if (!this.chatBridge || this.closeResult || this.pump?.state !== "running")
      throw new BridgeError("unavailable", "host_chat_unavailable");
    return this.chatBridge;
  }
  get historyContext(): Readonly<Context> | null {
    if (this.closeResult) return null;
    try {
      return this.client.verifiedContext;
    } catch {
      return null;
    }
  }
  get history(): ChatHistoryBridge {
    if (!this.historyContext)
      throw new BridgeError("unavailable", "host_history_unavailable");
    return this.historyBridge;
  }
  get retiredReplies(): RecoveryArchiveReader {
    if (!this.historyContext)
      throw new BridgeError("unavailable", "host_retired_replies_unavailable");
    return this.retiredArchiveReader;
  }
  get chatComputer(): ChatComputerBridge {
    if (
      !this.chatComputerBridge ||
      this.closeResult ||
      this.pump?.state !== "running"
    )
      throw new BridgeError("unavailable", "host_chat_unavailable");
    return this.chatComputerBridge;
  }
  get chatCaller(): ChatCallerBridge {
    if (
      !this.chatCallerBridge ||
      this.closeResult ||
      this.pump?.state !== "running"
    )
      throw new BridgeError("unavailable", "host_chat_unavailable");
    return this.chatCallerBridge;
  }
  withdraw() {
    return this.authority.withdraw();
  }
  async publishCurrent(): Promise<void> {
    const publication = await this.withdraw();
    // Re-read only after withdrawal. A settings mutation withdraws the same
    // fence before its durable save; racing old publication cannot activate it.
    await publication.publish(this.settings());
  }
  async readForIntent(
    operationId: string,
    workspaceId: string,
    relativePath: string,
  ) {
    await this.publishCurrent();
    const admission = await this.authority.admitRead({
      sessionId: this.sessionId,
      taskId: operationId,
      turnId: randomUUID(),
      workspaceIds: [workspaceId],
    });
    const result = await this.computer.read(
      {
        ownerId: admission.ownerId,
        sessionId: admission.sessionId,
        taskId: admission.taskId,
        taskEpoch: admission.taskEpoch,
        participantId: admission.participantId,
        turnId: admission.turnId,
        generation: admission.generation,
        callId: randomUUID(),
        workspaceId,
        relativePath,
      },
      { requestId: randomUUID(), context: this.client.verifiedContext },
    );
    return { admission, result };
  }
  inspectSettingsWorkspace(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_computer_unavailable");
    return this.authority.inspectSettings(
      computerGeneration,
      workspaceId,
      relativePath,
    );
  }
  listSettingsWorkspace(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_computer_unavailable");
    return this.authority.listSettings(
      computerGeneration,
      workspaceId,
      relativePath,
    );
  }
  searchSettingsWorkspace(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
    pattern: string,
  ) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_computer_unavailable");
    return this.authority.searchSettings(
      computerGeneration,
      workspaceId,
      relativePath,
      pattern,
    );
  }
  resolveTaskModel(
    revision: number,
    config: unknown,
    selection: TaskSelectionRequest,
  ) {
    if (this.closeResult)
      throw new BridgeError(
        "unavailable",
        "host_task_model_policy_unavailable",
      );
    return this.taskModelPolicy.resolve(revision, config, selection);
  }
  describeTaskModels(
    revision: number,
    config: unknown,
    harness: string,
    catalogue: unknown,
  ) {
    if (this.closeResult)
      throw new BridgeError(
        "unavailable",
        "host_task_model_catalogue_unavailable",
      );
    return this.taskModelCatalogue.describe(
      revision,
      config,
      harness,
      catalogue,
    );
  }
  compareTaskSettings(before: ProductSettings, candidate: ProductSettings) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_task_settings_unavailable");
    return this.taskCurrentSettings.compare(before, candidate);
  }
  openComputerConnector(
    runtimeId: string,
    launchDigest: string,
    challengeSha256: string,
    lifecycleRoot: string,
    recoveryFrom?: ComputerConnectorBinding,
  ) {
    if (this.closeResult || !this.connector)
      throw new BridgeError("unavailable", "host_connector_unavailable");
    const settings = this.settings();
    return this.connector.open({
      publication: this.authority.settingsMutationPublication(
        settings.computer.generation,
      ),
      runtimeId,
      connectorGeneration: String(settings.connectors.secureMcp.generation),
      launchDigest,
      challengeSha256,
      lifecycleRoot,
      ...(recoveryFrom ? { recoveryFrom } : {}),
    });
  }
  currentComputerConnectorBinding() {
    return this.connector?.currentBinding;
  }
  // Launch qualification only; workspace/task grants still decide each command.
  get shellAvailable(): boolean {
    return this.backendAvailable && this.qualifiedShell;
  }
  get backendAvailable(): boolean {
    if (this.closeResult) return false;
    try {
      // This is the original verified pipe's liveness, not a new handshake or
      // a claim that its pending operations completed or may be replayed.
      void this.client.verifiedContext;
      return true;
    } catch {
      return false;
    }
  }
  computerConnectorClosureReceipt() {
    return this.connector?.closureReceipt;
  }
  computerConnectorOwnerStoppedReceipt() {
    return this.backendAvailable
      ? this.connector?.ownerStoppedReceipt
      : undefined;
  }
  closeComputerConnector(reason?: "owner_stop"): Promise<void> {
    return this.connector?.close(reason) ?? Promise.resolve();
  }
  observeComputerConnectorOwnerStoppedHealth(
    receipt: import("./bridge/connector-host.ts").ConnectorClosureReceipt,
  ) {
    if (!this.backendAvailable || !this.connector)
      throw new BridgeError("unavailable", "host_connector_unavailable");
    return this.connector.observeOwnerStoppedHealth(receipt);
  }
  observeComputerConnectorHealth(
    expectedInstanceId: string,
    snapshot?: import("./bridge/wire.ts").ComputerConnectorHealthSnapshot,
  ) {
    if (this.closeResult || !this.connector)
      throw new BridgeError("unavailable", "host_connector_unavailable");
    return this.connector.observeHealth(expectedInstanceId, snapshot);
  }
  observeComputerConnectorPolling(
    samples: import("./bridge/wire.ts").ComputerConnectorPollingSamples,
  ) {
    if (this.closeResult || !this.connector)
      throw new BridgeError("unavailable", "host_connector_unavailable");
    return this.connector.observePolling(samples);
  }
  observeComputerConnectorVerification() {
    if (this.closeResult || !this.connector)
      throw new BridgeError("unavailable", "host_connector_unavailable");
    return this.connector.verification();
  }
  snapshotSettingsWorkspace(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_computer_unavailable");
    return this.authority.snapshotSettings(
      computerGeneration,
      workspaceId,
      relativePath,
    );
  }

  settingsMutationProfile(): string {
    if (
      this.closeResult ||
      !this.hasMutationStorage ||
      this.settingsStorePump?.state !== "running"
    )
      throw new BridgeError("unavailable", "host_mutation_storage_unavailable");
    return this.client.verifiedContext.profileId;
  }
  editSettingsWorkspace(
    operationId: string,
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
    expectedSHA256: string,
    oldText: string,
    newText: string,
  ) {
    this.settingsMutationProfile();
    return this.settingsDelivery.apply(operationId, {
      publication:
        this.authority.settingsMutationPublication(computerGeneration),
      workspaceId,
      relativePath,
      expectedSHA256,
      edits: [{ oldText, newText }],
    });
  }
  observeSettingsMutation(input: SettingsStorePending) {
    if (this.settingsMutationProfile() !== input.profileId)
      throw new BridgeError("refused", "host_mutation_profile_crossed");
    return this.settingsDelivery.observe(input);
  }
  acknowledgeSettingsMutation(operationId: string) {
    this.settingsMutationProfile();
    return this.settingsDelivery.acknowledge(operationId);
  }
  promoteReadIntent(input: ChatReadIntentPromote) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.promote(input);
  }
  resolveReadIntent(input: ChatReadIntentResolve) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.resolve(input);
  }
  approveReadAccount(input: ChatReadIntentAccountApprove) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.approveAccount(input);
  }
  revokeReadAccount(input: ChatReadIntentAccountRevoke) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.revokeAccount(input);
  }
  withdrawReadIntent(admission: ChatComputerAdmissionResponse) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.withdraw(admission);
  }
  // Exact child closure remains distinct from module/journal clean retirement.
  close(): Promise<void> {
    if (!this.closeResult) this.closeResult = this.closeOnce(true);
    return this.closeResult;
  }
  // Electron can still fail after this backend connects. Startup failure only
  // cleans the original resources; it must not mint a retirement or recorder.
  abortStartup(): Promise<void> {
    if (!this.closeResult) this.closeResult = this.closeOnce(false);
    return this.closeResult;
  }
  private async closeOnce(retire: boolean): Promise<void> {
    let retirementError: unknown;
    try {
      await this.connector?.close();
    } catch (error) {
      retirementError = error;
    }
    if (
      retirementError === undefined &&
      retire &&
      this.completeRetirement &&
      this.browserConnected &&
      !this.freshSession
    ) {
      try {
        const handoffId = randomUUID();
        const prepared = await this.client.request(
          "core.retirement.prepare",
          { handoffId },
          { operationId: randomUUID(), timeoutMs: 16000 },
        );
        if (
          prepared.status !== "ok" ||
          !validate("CoreRetirementPrepared", prepared.data)
        )
          throw new BridgeError(
            "unknown",
            "core_retirement_prepare_unconfirmed",
          );
        const publication = prepared.data as unknown as CoreRetirementPrepared;
        if (
          publication.handoffId !== handoffId ||
          !/^[a-f0-9]{64}$/u.test(publication.receiptDigest)
        )
          throw new BridgeError(
            "unknown",
            "core_retirement_publication_crossed",
          );
        // Go has stopped idle polls after actual owner retirement. Preserve the
        // pipe for explicit ACK; do not use transport loss to stop this pump.
        await this.pump?.stop();
        if (this.pump && this.pump.state !== "stopped")
          throw new BridgeError(
            "unknown",
            "core_retirement_browser_unconfirmed",
          );
        await this.settingsStorePump?.stop();
        if (
          this.settingsStorePump &&
          this.settingsStorePump.state !== "stopped"
        )
          throw new BridgeError(
            "unknown",
            "core_retirement_settings_unconfirmed",
          );
        const acknowledged = await this.client.request(
          "core.retirement.ack",
          {
            handoffId: publication.handoffId,
            receiptDigest: publication.receiptDigest,
          },
          { operationId: randomUUID(), timeoutMs: 1000 },
        );
        if (
          acknowledged.status !== "ok" ||
          !validate("CoreRetirementAcknowledged", acknowledged.data)
        )
          throw new BridgeError("unknown", "core_retirement_ack_unconfirmed");
        const ack = acknowledged.data as unknown as CoreRetirementAcknowledged;
        if (
          ack.handoffId !== publication.handoffId ||
          ack.receiptDigest !== publication.receiptDigest ||
          !/^[a-f0-9]{64}$/u.test(ack.ackDigest)
        )
          throw new BridgeError("unknown", "core_retirement_ack_crossed");
        await this.completeRetirement(ack);
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError === undefined && retire && this.freshSession) {
      try {
        const result = await this.client.request(
          "core.fresh.close",
          {},
          { operationId: randomUUID(), timeoutMs: 16000 },
        );
        const data = result.data as { drained?: unknown } | undefined;
        if (
          result.status !== "ok" ||
          !validate("CoreFreshClosed", result.data) ||
          data?.drained !== true
        )
          throw new BridgeError("unknown", "fresh_session_drain_unconfirmed");
        // Native quiescence wakes reciprocal reads without losing their replies.
        // Join both pumps before EOF can cancel a still-writing Go poll worker.
        await Promise.all([this.pump?.stop(), this.settingsStorePump?.stop()]);
        if (
          (this.pump && this.pump.state !== "stopped") ||
          (this.settingsStorePump && this.settingsStorePump.state !== "stopped")
        )
          throw new BridgeError("unknown", "fresh_session_drain_unconfirmed");
      } catch (error) {
        retirementError = error;
      }
    }
    let withdrawalError: unknown;
    try {
      this.browser?.withdraw();
    } catch (error) {
      withdrawalError = error;
    }
    // Closing the same Client releases the outstanding bounded browser poll.
    // Do not wait up to its deadline before starting exact child cleanup.
    const results = await Promise.allSettled([
      this.pump?.stop(),
      this.settingsStorePump?.stop(),
      this.freshSession
        ? this.client.closeAndObserve().then((terminal) => {
            if (
              terminal.exitCode !== 0 ||
              terminal.signal !== null ||
              terminal.forced
            )
              throw new BridgeError(
                "unknown",
                "fresh_session_terminal_unconfirmed",
              );
          })
        : this.client.close(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    if (retirementError !== undefined) throw retirementError;
    if (withdrawalError !== undefined) throw withdrawalError;
  }
}

export async function startDesktopGoCore(
  selection: DesktopCoreSelection,
): Promise<DesktopGoCore> {
  if (selection.startupPurpose === "fresh") {
    if (selection.previousHostDrainConfirmed)
      throw new BridgeError("refused", "invalid_fresh_launch");
    if (typeof selection.withInactiveMcp !== "function")
      throw new BridgeError("refused", "fresh_mcp_owner_unconfirmed");
    return selection.withInactiveMcp(() =>
      startSelectedDesktopGoCore(selection),
    );
  }
  return startSelectedDesktopGoCore(selection);
}

async function startSelectedDesktopGoCore(
  selection: DesktopCoreSelection,
): Promise<DesktopGoCore> {
  const codexRead = copyNativeCodexReadLaunch(selection);
  const fresh = selection.startupPurpose === "fresh";
  if (fresh && selection.previousHostDrainConfirmed)
    throw new BridgeError("refused", "invalid_fresh_launch");
  if (
    selection.startupPurpose !== "fresh" &&
    selection.previousHostDrainConfirmed !== true
  )
    throw new BridgeError("refused", "previous_host_drain_unconfirmed");
  const expected = desktopCoreExpectation(selection);
  const settings = selection.settings();
  const artifact = readDesktopCoreDeclaration(selection.artifactRoot, expected);
  // Capture trusted inputs before yielding to resource IO. The support parser
  // freezes its copy; the source copy cannot be changed by the caller later.
  const selectedShell = selection.compiledShell;
  if (
    selectedShell &&
    (!(selectedShell.watchdogSource instanceof Uint8Array) ||
      selectedShell.watchdogSource.byteLength === 0 ||
      selectedShell.watchdogSource.byteLength > 64 * 1024)
  )
    throw new BridgeError("refused", "invalid_shell_launch_metadata");
  const shell = selectedShell
    ? {
        support: bindShellSupportDeclaration(
          selectedShell.support,
          selectedShell.support,
          expected,
        ),
        source: Buffer.from(selectedShell.watchdogSource),
      }
    : undefined;
  if (
    shell &&
    (selection.compiledResources === undefined ||
      selection.compiledResources === null)
  )
    throw new BridgeError("refused", "shell_host_resources_missing");
  const qualificationDeadline =
    performance.now() + CORE_QUALIFICATION_BUDGET_MS;
  // New builds carry this independent closure. Older fixture/host selections
  // remain compatible; Shell activation must require the completed closure.
  if (
    selection.compiledResources !== undefined &&
    selection.compiledResources !== null
  )
    await verifyCoreResources(
      selection.artifactRoot,
      selection.compiledResources,
      expected,
      qualificationDeadline,
      selection.onQualificationObservation,
    );
  let shellBundle: Awaited<ReturnType<typeof attestShellRuntime>> | undefined;
  if (shell) {
    const appRoot = path.resolve(selection.artifactRoot, "../../..");
    if (path.join(appRoot, "Contents/Resources/app") !== selection.artifactRoot)
      throw new BridgeError("refused", "shell_host_layout_mismatch");
    shellBundle = await attestShellRuntime(
      appRoot,
      shell.support,
      qualificationDeadline,
      selection.onQualificationObservation,
    );
    if (shellBundle.path !== appRoot)
      throw new BridgeError("refused", "shell_host_layout_mismatch");
  }
  const storage = openNativeProfileStorage(
    selection.stateRoot,
    settings.computer.computerId,
  );
  const qualified = qualifyProfileLaunch({
    profileId: storage.profileId,
    root: storage.root,
    home: selection.home,
  });
  if (qualified.state !== "qualified")
    throw new BridgeError(qualified.state, qualified.code);
  let handedToClient = false;
  let released = false;
  const profile = {
    beforeSpawn: () => {
      handedToClient = true;
      return qualified.profile.beforeSpawn();
    },
    close: () => {
      released = true;
      return qualified.profile.close();
    },
  };
  let client: Client;
  let qualifiedShell = false;
  const attested = new AttestedCore(artifact, {
    artifactRoot: selection.artifactRoot,
    build: expected.build,
    binary: expected.binary,
    profileId: storage.profileId,
  });
  try {
    const hostLifetimeId = randomUUID();
    const childLaunchId = randomUUID();
    // Version-1 profiles retain their read-only Go route. Package attestation
    // still ran above; optional Shell cannot add storage or force a migration.
    const shellMetadata =
      shell && shellBundle && storage.settingsMutations
        ? encodeShellLaunch(shell.support, shell.support, expected, {
            profileId: storage.profileId,
            hostLifetimeId,
            childLaunchId,
            appRoot: shellBundle,
            watchdogSource: shell.source,
          })
        : undefined;
    qualifiedShell = shellMetadata !== undefined;
    client = await attested.start(DESKTOP_CORE_STARTUP_TIMEOUT_MS, {
      profile,
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      storeMode: storage.storeMode,
      settingsMutations: storage.settingsMutations,
      ...(fresh ? { startupMode: "fresh" as const } : {}),
      previousHostDrainConfirmed: selection.previousHostDrainConfirmed,
      hostLifetimeId,
      childLaunchId,
      ...(codexRead ? { codexRead } : {}),
      ...(shellMetadata ? { shellMetadata } : {}),
      ...(selection.onLifecycleObservation
        ? { onLifecycleObservation: selection.onLifecycleObservation }
        : {}),
    });
  } catch (error) {
    if (!handedToClient && !released) {
      const closed = profile.close();
      if (closed.state !== "closed")
        throw new BridgeError(closed.state, closed.code);
    }
    throw error;
  }
  const host = new DesktopGoCore(
    client,
    selection.settings,
    (ack) => attested.completeRetirement(ack),
    storage.settingsMutations,
    selection.build.buildId,
    qualifiedShell,
    fresh,
  );
  try {
    await host.publishCurrent();
    host.connectBrowser(selection.browser(client.verifiedContext));
    return host;
  } catch (error) {
    await host.abortStartup();
    throw error;
  }
}
