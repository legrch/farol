import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AttestedCore,
  parseCoreArtifactDeclaration,
} from "../../apps/desktop/bridge/attested-core";
import { openNativeProfileStorage } from "../../apps/desktop/bridge/profile-storage";
import { qualifyProfileLaunch } from "../../apps/desktop/bridge/profile";
import { GoComputerAuthority } from "../../apps/desktop/go-computer-authority";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";

// Explicit disposable native E2E setup only. Uses the already qualified exact
// test build and original owners; no test setting enables an app capability.
// The first real backend exits without a module retirement; no file effect is
// interrupted, no outcome is replayed and no provider/browser/Shell is selected.
export async function seedRecoveryProfile(
  input: Readonly<{
    stateRoot: string;
    home: string;
    workspace: string;
    artifactRoot: string;
    core: unknown;
  }>,
) {
  await fs.mkdir(path.join(input.workspace, "folder"), {
    mode: 0o700,
    recursive: true,
  });
  await fs.writeFile(
    path.join(input.workspace, "note.md"),
    "Synthetic recovery fixture\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(input.workspace, "folder", "nested.txt"),
    "Synthetic nested fixture\n",
    { mode: 0o600 },
  );
  const physical = await fs.lstat(input.workspace, { bigint: true });
  const store = new ProductSettingsStore({ root: input.stateRoot });
  const service = new ProductConfigurationService(store, {
    homeDirectory: input.home,
  });
  await service.initialize();
  const added = await service.addReadonlyWorkspace({
    root: input.workspace,
    label: "Recovery fixture",
    rootIdentity: { device: String(physical.dev), inode: String(physical.ino) },
  });
  assert.ok(added.ok && added.snapshot.status === "ready");
  const settings = added.snapshot.settings;
  const storage = openNativeProfileStorage(
    input.stateRoot,
    settings.computer.computerId,
  );
  assert.equal(storage.storeMode, "create");
  const selected = qualifyProfileLaunch({
    profileId: storage.profileId,
    root: storage.root,
    home: input.home,
  });
  assert.equal(selected.state, "qualified");
  if (selected.state !== "qualified")
    throw Error("fixture profile qualification failed");
  const core = parseCoreArtifactDeclaration(input.core);
  const attested = new AttestedCore(core, {
    artifactRoot: input.artifactRoot,
    build: core.build,
    binary: core.binary,
    profileId: storage.profileId,
  });
  let handed = false,
    released = false;
  const profile = {
    beforeSpawn: () => {
      handed = true;
      return selected.profile.beforeSpawn();
    },
    close: () => {
      released = true;
      return selected.profile.close();
    },
  };
  let client;
  try {
    client = await attested.start(15_000, {
      profile,
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      storeMode: "create",
      settingsMutations: storage.settingsMutations,
      previousHostDrainConfirmed: true,
      hostLifetimeId: randomUUID(),
      childLaunchId: randomUUID(),
    });
  } catch (error) {
    if (!handed && !released) assert.equal(profile.close().state, "closed");
    throw error;
  }
  const generation = client.verifiedContext.backendGeneration;
  try {
    const authority = new GoComputerAuthority(client, client.verifiedContext);
    await (await authority.withdraw()).publish(settings);
  } finally {
    await client.close();
  }
  assert.equal(client.cleanupState, "confirmed");
  return {
    workspaceId: settings.computer.workspaces[0]!.workspaceId,
    profileId: storage.profileId,
    oldGeneration: generation,
    originalChildCleanup: client.cleanupState,
    originalLifecycle: client.lifecycleObservations,
    settingsRevision: settings.revision,
  };
}
