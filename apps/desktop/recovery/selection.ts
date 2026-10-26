import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { closedRecoveryHostMechanics as host } from "../../../src/apps/desktop/closed-empty-chat-recovery";
import { MAX_RUN_MARKER_BYTES } from "../../../src/apps/desktop/run-marker";
import { MAX_QUIT_RECEIPT_BYTES } from "../../../src/apps/desktop/quit-receipt";
import {
  ownerCompletedInputs,
  projectStartupRetainedRecords,
} from "./retained-records";
import { openExistingNativeProfileStorage } from "../bridge/profile-storage";
import type { ProfileLaunchBinding } from "../bridge/profile";
import type {
  ExactPreservedRecoverySelection,
  PreservedRecoverySelectionInput,
} from "../bridge/preserved-recovery-child";
import {
  selectStartupLegacyPreparation,
  type StartupLegacyPreparation,
} from "./legacy-preparation";

export type StartupPreservedSelection = Readonly<{
  profile: ProfileLaunchBinding;
  exact: ExactPreservedRecoverySelection;
  selectionInput: PreservedRecoverySelectionInput;
  expectedRunSha256: string;
  expectedConfigSha256: string;
  expectedQuitSha256?: string;
  legacyPreparation?: StartupLegacyPreparation;
  // Only before preparation: a successful recovery deliberately moves Chat
  // and original markers. This snapshot supplies no post-effect authority.
  recheck(): Promise<void>;
}>;

function refused(): never {
  throw Error("STARTUP_PRESERVED_SELECTION_INVALID");
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Trusted startup input only. This read-only collector never provisions a
// profile, launches a child, derives the old generation, classifies an effect,
// repairs a journal or grants recovery. The caller retains its original lease.
export async function selectStartupPreservedRecovery(
  input: Readonly<{
    userData: string;
    home: string;
    computerId: string;
    buildId: string;
    assertCurrent(): Promise<void>;
  }>,
): Promise<StartupPreservedSelection> {
  const { userData, home, computerId, buildId, assertCurrent } = input;
  if (
    ![userData, home].every(
      (p) =>
        path.isAbsolute(p) && path.normalize(p) === p && !/[\0\r\n]/u.test(p),
    ) ||
    !/^[a-f0-9]{64}$/u.test(buildId)
  )
    refused();
  await assertCurrent();
  const state = path.join(userData, "farol-state");
  const storage = openExistingNativeProfileStorage(state, computerId);
  const computer = path.join(storage.root, "computer");
  const mutations = path.join(computer, "mutations");
  const roots = await Promise.all(
    [
      userData,
      state,
      storage.root,
      computer,
      mutations,
      path.join(storage.root, "chat"),
      path.join(storage.root, "task"),
    ].map(
      async (directory) =>
        [directory, await host.privateRoot(directory)] as const,
    ),
  );
  const physical = (value: { dev: number; ino: number }) => {
    if (![value.dev, value.ino].every((n) => Number.isSafeInteger(n) && n > 0))
      refused();
    return {
      Device: value.dev,
      Inode: value.ino,
      OwnerUID: process.geteuid!(),
    };
  };
  const parent = roots[2]![1],
    chat = roots[5]![1];
  const profile: ProfileLaunchBinding = {
    profileId: storage.profileId,
    root: storage.root,
    home,
    device: String(parent.dev),
    inode: String(parent.ino),
  };
  const pending = path.join(state, "go-core.empty-recovery.pending");
  await host.absent(pending);
  const files = new Map<string, Awaited<ReturnType<typeof host.snapshot>>>();
  const capture = async (file: string, maximum: number) => {
    const captured = await host.snapshot(file, maximum);
    files.set(file, captured);
    return captured;
  };
  const run = await capture(
    path.join(state, "running.json"),
    MAX_RUN_MARKER_BYTES,
  );
  const config = await capture(path.join(state, "config.json"), 1024 * 1024);
  await capture(path.join(storage.root, "profile.json"), 4096);
  const access = await capture(
    path.join(computer, "computer-access.json"),
    1024 * 1024,
  );
  const quitPath = path.join(state, "last-quit.json");
  let quitPresent = true;
  try {
    await fs.lstat(quitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    quitPresent = false;
  }
  const quit = quitPresent
    ? await capture(quitPath, MAX_QUIT_RECEIPT_BYTES)
    : undefined;
  const names = (await fs.readdir(mutations)).sort();
  if (
    names.length > 128 ||
    names.some((name) => !/^[a-f0-9]{64}\.json$/u.test(name))
  )
    refused();
  const retained: { key: string; bytes: Buffer }[] = [];
  for (const name of names) {
    const captured = await capture(path.join(mutations, name), 65536);
    retained.push({ key: name, bytes: captured.bytes });
  }
  const selected = ownerCompletedInputs(
    projectStartupRetainedRecords(retained, {
      ownerId: "owner-desktop",
      profileId: storage.profileId,
      computerId,
    }),
  );
  const exact: ExactPreservedRecoverySelection = {
    buildId,
    operationId: randomUUID(),
    hostLifetimeId: randomUUID(),
    childLaunchId: randomUUID(),
    backendGeneration: randomUUID(),
    current: {
      Scope: { ProfileID: storage.profileId, BackendGeneration: "" },
      ParentRoot: physical(parent),
      ChatRoot: physical(chat),
    },
  };
  const selectionInput: PreservedRecoverySelectionInput = {
    Selection: {
      OperationID: exact.operationId,
      Current: structuredClone(exact.current),
      HandoffDigest: Array<number>(32).fill(0),
      LifecycleDigest: Array<number>(32).fill(0),
      ResultsDigest: Array<number>(32).fill(0),
      Next: {
        ProfileID: profile.profileId,
        BackendGeneration: exact.backendGeneration,
      },
      BuildID: buildId,
      HostLifetimeID: exact.hostLifetimeId,
      ChildLaunchID: exact.childLaunchId,
    },
    OwnerID: "owner-desktop",
    ComputerID: computerId,
    AccessDigest: Array.from(
      createHash("sha256").update(access.bytes).digest(),
    ),
    Mutations: selected,
  };
  const legacyPreparation = await selectStartupLegacyPreparation(
    userData,
    assertCurrent,
  );
  const recheck = async () => {
    await assertCurrent();
    for (const [directory, original] of roots)
      if (!isDeepStrictEqual(await host.privateRoot(directory), original))
        throw Error("STARTUP_PRESERVED_SELECTION_CHANGED");
    if (!isDeepStrictEqual((await fs.readdir(mutations)).sort(), names))
      throw Error("STARTUP_PRESERVED_SELECTION_CHANGED");
    for (const [file, original] of files) await host.unchanged(file, original);
    if (quit === undefined) await host.absent(quitPath);
    await legacyPreparation?.verify();
    await host.absent(pending);
    await assertCurrent();
  };
  await recheck();
  return immutable({
    profile,
    exact,
    selectionInput,
    expectedRunSha256: hash(run.bytes),
    expectedConfigSha256: hash(config.bytes),
    ...(quit === undefined ? {} : { expectedQuitSha256: hash(quit.bytes) }),
    ...(legacyPreparation === null ? {} : { legacyPreparation }),
    recheck,
  });
}
