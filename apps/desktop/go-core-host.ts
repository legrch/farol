import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AttestedCore,
  parseCoreArtifactDeclaration,
} from "./bridge/attested-core.ts";
import { BridgeError, type Client } from "./bridge/client.ts";
import { ComputerBridge } from "./bridge/computer.ts";
import { qualifyProfileLaunch } from "./bridge/profile.ts";
import { openNativeProfileStorage } from "./bridge/profile-storage.ts";
import { GoComputerAuthority } from "./go-computer-authority.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

export type DesktopCoreSelection = Readonly<{
  // Compiled into this host by the exact production builder, not environment,
  // renderer data, a runtime file's own claim or a freshly measured binary hash.
  compiledArtifact: unknown;
  build: BuildIdentity;
  artifactRoot: string;
  stateRoot: string;
  home: string;
  settings: () => ProductSettings;
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
  private readonly sessionId = randomUUID();
  constructor(
    private readonly client: Client,
    private readonly settings: () => ProductSettings,
  ) {
    this.authority = new GoComputerAuthority(client, client.verifiedContext);
    this.computer = new ComputerBridge(client);
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
  // Exact child closure remains distinct from module/journal clean retirement.
  close(): Promise<void> {
    return this.client.close();
  }
}

export async function startDesktopGoCore(
  selection: DesktopCoreSelection,
): Promise<DesktopGoCore> {
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
  try {
    client = await new AttestedCore(artifact, {
      artifactRoot: selection.artifactRoot,
      build: expected.build,
      binary: expected.binary,
      profileId: storage.profileId,
    }).start(2000, {
      profile,
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      storeMode: storage.storeMode,
    });
  } catch (error) {
    if (!handedToClient && !released) {
      const closed = profile.close();
      if (closed.state !== "closed")
        throw new BridgeError(closed.state, closed.code);
    }
    throw error;
  }
  const host = new DesktopGoCore(client, selection.settings);
  try {
    await host.publishCurrent();
    return host;
  } catch (error) {
    await host.close();
    throw error;
  }
}
