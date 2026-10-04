import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AttestedCore,
  parseCoreArtifactDeclaration,
} from "./bridge/attested-core.ts";
import { BridgeError, type Client } from "./bridge/client.ts";
import { ComputerBridge } from "./bridge/computer.ts";
import { BrowserPump, type BrowserDriver } from "./bridge/browser.ts";
import { ChatBridge } from "./bridge/chat.ts";
import { ChatComputerBridge } from "./bridge/chat-computer.ts";
import { ChatCallerBridge } from "./bridge/chat-caller.ts";
import { ReadIntentBridge } from "./bridge/read-intent.ts";
import {
  validate,
  type Context,
  type CoreRetirementPrepared,
  type CoreRetirementAcknowledged,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatReadIntentAccountApprove,
  type ChatReadIntentAccountRevoke,
} from "./bridge/wire.ts";
import { qualifyProfileLaunch } from "./bridge/profile.ts";
import { openNativeProfileStorage } from "./bridge/profile-storage.ts";
import { GoComputerAuthority } from "./go-computer-authority.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

export type DesktopBrowserConnection = Readonly<{
  driver: BrowserDriver;
  // Synchronously revoke the exact host assignments before closing the pipe.
  // Revocation does not claim provider cancellation or clean module retirement.
  withdraw: () => void;
}>;

export type DesktopCoreSelection = Readonly<{
  // Compiled into this host by the exact production builder, not environment,
  // renderer data, a runtime file's own claim or a freshly measured binary hash.
  compiledArtifact: unknown;
  // Captured before the new host writes its run marker. Only the exact prior
  // host's confirmed drain can clear that marker; Go terminal bytes cannot.
  previousHostDrainConfirmed: boolean;
  build: BuildIdentity;
  artifactRoot: string;
  stateRoot: string;
  home: string;
  settings: () => ProductSettings;
  browser: (context: Readonly<Context>) => DesktopBrowserConnection;
}>;
function readDeclaration(root: string): unknown {
  const fd = fs.openSync(
    path.join(root, "core-artifact.json"),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8192n)
      throw new BridgeError("refused", "invalid_core_artifact");
    const bytes = Buffer.alloc(8193);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.nlink !== after.nlink
    )
      throw new BridgeError("refused", "core_artifact_changed");
    return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

// One normal Electron-owned backend lifetime. This class only composes the real
// Go authorities and typed adapters; it cannot grant permission or restart work.
export class DesktopGoCore {
  private readonly authority: GoComputerAuthority;
  private readonly computer: ComputerBridge;
  private readonly readIntent: ReadIntentBridge;
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
  ) {
    this.authority = new GoComputerAuthority(client, client.verifiedContext);
    this.computer = new ComputerBridge(client);
    this.readIntent = new ReadIntentBridge(client);
  }
  connectBrowser(connection: DesktopBrowserConnection): void {
    if (this.browser || this.closeResult)
      throw new BridgeError("refused", "host_browser_already_selected");
    this.browser = connection;
    this.pump = new BrowserPump(this.client, connection.driver);
    this.chatBridge = new ChatBridge(this.client);
    this.chatComputerBridge = new ChatComputerBridge(this.client);
    this.chatCallerBridge = new ChatCallerBridge(this.client);
    this.pump.start();
    this.browserConnected = true;
  }
  get chat(): ChatBridge {
    if (!this.chatBridge || this.closeResult || this.pump?.state !== "running")
      throw new BridgeError("unavailable", "host_chat_unavailable");
    return this.chatBridge;
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
  promoteReadIntent(input: ChatReadIntentPromote) {
    if (this.closeResult)
      throw new BridgeError("unavailable", "host_read_intent_unavailable");
    return this.readIntent.promote(input);
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
    if (retire && this.completeRetirement && this.browserConnected) {
      try {
        const handoffId = randomUUID();
        const prepared = await this.client.request(
          "core.retirement.prepare",
          { handoffId },
          { operationId: randomUUID(), timeoutMs: 1000 },
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
      this.client.close(),
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
  if (selection.previousHostDrainConfirmed !== true)
    throw new BridgeError("refused", "previous_host_drain_unconfirmed");
  const expected = parseCoreArtifactDeclaration(selection.compiledArtifact);
  if (
    selection.build.sourceDirty ||
    expected.build.buildId !== selection.build.buildId ||
    expected.build.sourceSHA !== selection.build.sourceCommit ||
    expected.build.sourceTreeDigest !== selection.build.sourceTreeDigest ||
    expected.build.platform.goos !== process.platform ||
    expected.build.platform.goarch !== process.arch
  ) {
    // Node names x64 differently from Go. This first normal host slice selects
    // the currently packaged darwin/arm64 runtime only.
    throw new BridgeError("refused", "core_host_build_mismatch");
  }
  const settings = selection.settings();
  const artifact = parseCoreArtifactDeclaration(
    readDeclaration(selection.artifactRoot),
  );
  if (JSON.stringify(artifact) !== JSON.stringify(expected))
    throw new BridgeError("refused", "core_host_artifact_mismatch");
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
  const attested = new AttestedCore(artifact, {
    artifactRoot: selection.artifactRoot,
    build: expected.build,
    binary: expected.binary,
    profileId: storage.profileId,
  });
  try {
    client = await attested.start(2000, {
      profile,
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      storeMode: storage.storeMode,
      previousHostDrainConfirmed: selection.previousHostDrainConfirmed,
      hostLifetimeId: randomUUID(),
      childLaunchId: randomUUID(),
    });
  } catch (error) {
    if (!handedToClient && !released) {
      const closed = profile.close();
      if (closed.state !== "closed")
        throw new BridgeError(closed.state, closed.code);
    }
    throw error;
  }
  const host = new DesktopGoCore(client, selection.settings, (ack) =>
    attested.completeRetirement(ack),
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
