import { RecoveryArchiveReader } from "./archive";
import type { ChatArchivePage, ChatArchiveReply } from "../bridge/wire";
import { randomUUID } from "node:crypto";
import { AttestedCore } from "../bridge/attested-core.ts";
import {
  BridgeError,
  type Client,
  type BackendLifecycleObservation,
} from "../bridge/client.ts";
import {
  desktopCoreExpectation,
  readDesktopCoreDeclaration,
} from "../bridge/desktop-artifact.ts";
import { verifyCoreResources } from "../bridge/core-resources.ts";
import { qualifyProfileLaunch } from "../bridge/profile.ts";
import { openExistingNativeProfileStorage } from "../bridge/profile-storage.ts";
import { GoComputerAuthority } from "../go-computer-authority.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";

export type RecoveryCoreSelection = Readonly<{
  compiledArtifact: unknown;
  compiledResources: unknown;
  build: BuildIdentity;
  artifactRoot: string;
  stateRoot: string;
  home: string;
  settings: ProductSettings;
  onLifecycleObservation?: (observation: BackendLifecycleObservation) => void;
}>;

export type StartupRecoveryCore = Readonly<{
  folderReadsAvailable: boolean;
  archiveList(after: string): Promise<ChatArchivePage>;
  archiveRead(key: string, digest: string): Promise<ChatArchiveReply>;
  list(
    workspaceId: string,
    relativePath: string,
  ): ReturnType<GoComputerAuthority["listSettings"]>;
  search(
    workspaceId: string,
    relativePath: string,
    pattern: string,
  ): ReturnType<GoComputerAuthority["searchSettings"]>;
  snapshot(
    workspaceId: string,
    relativePath: string,
  ): ReturnType<GoComputerAuthority["snapshotSettings"]>;
  close(): Promise<void>;
}>;

// The caller retains its original startup exclusion and predecessor run marker.
// Exactly one attested child is selected before launch. This owner composes no
// normal DesktopGoCore, Browser, connector, Task, Shell, writer pump or retirement
// recorder; even successful Close conveys no old operation/process settlement.
export async function startDesktopGoRecovery(
  selection: RecoveryCoreSelection,
): Promise<StartupRecoveryCore> {
  const expected = desktopCoreExpectation(selection);
  const settings = ProductSettingsSchema.parse(
    structuredClone(selection.settings),
  );
  const artifact = readDesktopCoreDeclaration(selection.artifactRoot, expected);
  if (
    selection.compiledResources === undefined ||
    selection.compiledResources === null
  )
    throw new BridgeError("refused", "core_host_resources_missing");
  await verifyCoreResources(
    selection.artifactRoot,
    selection.compiledResources,
    expected,
    performance.now() + 2000,
  );
  const storage = openExistingNativeProfileStorage(
    selection.stateRoot,
    settings.computer.computerId,
  );
  if (storage.storeMode !== "open" || storage.settingsMutations !== false)
    throw new BridgeError("refused", "invalid_recovery_storage");
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
  const attested = new AttestedCore(artifact, {
    artifactRoot: selection.artifactRoot,
    build: expected.build,
    binary: expected.binary,
    profileId: storage.profileId,
  });
  let client: Client;
  try {
    client = await attested.start(15_000, {
      profile,
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      storeMode: "open",
      startupMode: "recovery",
      hostLifetimeId: randomUUID(),
      childLaunchId: randomUUID(),
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
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) closing = client.close();
    return closing;
  };
  const available = () => {
    if (closing)
      throw new BridgeError("unavailable", "recovery_computer_closed");
  };
  const query = async <T>(perform: () => Promise<T>): Promise<T> => {
    available();
    const result = await perform();
    available();
    return result;
  };
  let authority: GoComputerAuthority;
  let archive: RecoveryArchiveReader;
  let folderReadsAvailable = false;
  try {
    authority = new GoComputerAuthority(
      client,
      client.verifiedContext,
      Date.now,
      "computer",
    );
    const withdrawn = await authority.withdraw();
    await withdrawn.publish(settings);
    // A known inactive folder publication must not veto independent private
    // archive reads. Unknown/pending publication still closes this exact child.
    folderReadsAvailable =
      authority.settingsReadState(settings.computer.generation) === "available";
    archive = new RecoveryArchiveReader(client, client.verifiedContext);
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "recovery_startup_and_cleanup_unconfirmed",
      );
    }
    throw error;
  }
  const generation = settings.computer.generation;
  return Object.freeze({
    folderReadsAvailable,
    archiveList: (after: string) => query(() => archive.list(after)),
    archiveRead: (key: string, digest: string) =>
      query(() => archive.read(key, digest)),
    list: (workspaceId: string, relativePath: string) =>
      query(() =>
        authority.listSettings(generation, workspaceId, relativePath),
      ),
    search: (workspaceId: string, relativePath: string, pattern: string) =>
      query(() =>
        authority.searchSettings(
          generation,
          workspaceId,
          relativePath,
          pattern,
        ),
      ),
    snapshot: (workspaceId: string, relativePath: string) =>
      query(() =>
        authority.snapshotSettings(generation, workspaceId, relativePath),
      ),
    close,
  });
}
