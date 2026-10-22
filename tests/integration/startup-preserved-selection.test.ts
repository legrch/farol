import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openExistingNativeProfileStorage } from "../../apps/desktop/bridge/profile-storage";
import { selectStartupPreservedRecovery } from "../../apps/desktop/recovery/selection";
import { assertStartupLegacyPreparation } from "../../apps/desktop/recovery/legacy-preparation";

// Actual file selection/readback, existing profile storage and immutable DTOs
// on a real disposable macOS filesystem; no filesystem/profile/collector mocks.
// Opaque fixture bytes do not qualify Go validation, actual authority, leases,
// processes, Electron or recovery. Go owns phase/schema/receipt/key policy and
// closure. Retain every fixture, including failures and displaced originals.
const PROFILE_ID = "fixture-profile";
const COMPUTER_ID = "fixture-computer";
const BUILD_ID = "ab".repeat(32);
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const mutationKey = (index: number) =>
  `${index.toString(16).padStart(64, "0")}.json`;

type Missing = "profile-root" | "profile" | "mutations" | "task";
async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
}
async function privateFile(file: string, bytes: Buffer | string) {
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function fixture(options: { missing?: Missing; quit?: boolean } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-startup-selection-")),
  );
  console.info("Retained startup selection fixture:", root);
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const retained = path.join(root, "retained-originals");
  const userData = path.join(root, "Farol Dev");
  const state = path.join(userData, "farol-state");
  const core = path.join(state, "go-core");
  const computer = path.join(core, "computer");
  const mutations = path.join(computer, "mutations");
  const chat = path.join(core, "chat");
  const task = path.join(core, "task");
  const profile = path.join(core, "profile.json");
  const access = path.join(computer, "computer-access.json");
  const run = path.join(state, "running.json");
  const config = path.join(state, "config.json");
  const quit = path.join(state, "last-quit.json");
  const pending = path.join(state, "go-core.empty-recovery.pending");
  for (const directory of [home, retained, userData, state])
    await privateDirectory(directory);
  if (options.missing !== "profile-root") {
    for (const directory of [core, computer, chat])
      await privateDirectory(directory);
    if (options.missing !== "mutations") await privateDirectory(mutations);
    if (options.missing !== "task") await privateDirectory(task);
    if (options.missing !== "profile")
      await privateFile(
        profile,
        json({
          schema: "farol-native-profile/2",
          profileId: PROFILE_ID,
          computerId: COMPUTER_ID,
        }),
      );
    // Deliberately raw bytes: selection hashes access; it grants no authority.
    await privateFile(access, Buffer.from([0x00, 0xff, 0x31, 0x0a, 0x41]));
  }
  await privateFile(run, "opaque original running fixture\n");
  await privateFile(config, "opaque retained configuration fixture\n");
  if (options.quit) await privateFile(quit, "opaque previous Quit fixture\n");
  return {
    root,
    home,
    retained,
    userData,
    state,
    core,
    computer,
    mutations,
    chat,
    task,
    profile,
    access,
    run,
    config,
    quit,
    pending,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inputFor(f: Fixture) {
  return {
    userData: f.userData,
    home: f.home,
    computerId: COMPUTER_ID,
    buildId: BUILD_ID,
    assertCurrent: async () => {},
  };
}

// Ignore access times, which reads can update. Pin bytes, namespace, ownership,
// modes, links, physical identity and modification/change times independently
// of the collector; do not follow fixture symlinks when comparing the tree.
async function inventory(root: string) {
  const entries: {
    path: string;
    metadata: bigint[];
    contents?: string;
    target?: string;
  }[] = [];
  async function visit(file: string): Promise<void> {
    const s = await fs.lstat(file, { bigint: true });
    const entry = {
      path: path.relative(root, file) || ".",
      metadata: [
        s.dev,
        s.ino,
        s.uid,
        s.gid,
        s.mode,
        s.nlink,
        s.size,
        s.mtimeNs,
        s.ctimeNs,
      ],
    };
    if (s.isSymbolicLink())
      entries.push({ ...entry, target: await fs.readlink(file) });
    else if (s.isFile())
      entries.push({
        ...entry,
        contents: (await fs.readFile(file)).toString("hex"),
      });
    else entries.push(entry);
    if (s.isDirectory())
      for (const name of (await fs.readdir(file)).sort())
        await visit(path.join(file, name));
  }
  await visit(root);
  return entries;
}
async function refusesUnchanged(
  f: Fixture,
  action: () => Promise<unknown>,
  message?: string | RegExp,
) {
  const before = await inventory(f.root);
  if (message === undefined) await expect(action()).rejects.toThrow();
  else await expect(action()).rejects.toThrow(message);
  expect(await inventory(f.root)).toEqual(before);
}
function mutationValue(index: number, phase: string) {
  return {
    // Not a canonical journal fixture: only the immutable projection is tested.
    schema: "fixture-opaque-mutation/1",
    record: {
      identity: {
        operationId: `fixture-operation-${index}`,
        ownerId: "owner-desktop",
        profileId: PROFILE_ID,
        computerId: COMPUTER_ID,
        scope: "owner",
      },
      computerGeneration: index,
      workspaceId: `fixture-workspace-${index}`,
      relativePath: `settings/fixture-${index}.json`,
      requestDigest: index.toString(16).padStart(64, "0"),
      phase,
      opaqueRetainedEvidence: {
        originalPhase: phase,
        receipt: "not-qualified",
      },
    },
  };
}
async function writeMutation(
  f: Fixture,
  index: number,
  phase = "completed",
  computerGeneration = index,
) {
  const value = mutationValue(index, phase);
  value.record.computerGeneration = computerGeneration;
  const key = mutationKey(index);
  const file = path.join(f.mutations, key);
  const bytes = json(value);
  await privateFile(file, bytes);
  return { key, file, value, bytes };
}
type Mutation = Awaited<ReturnType<typeof writeMutation>>;
function projectedMutation(mutation: Mutation) {
  const { record } = mutation.value;
  return {
    Key: mutation.key,
    SHA256: sum(mutation.bytes),
    Binding: {
      Identity: {
        OperationID: record.identity.operationId,
        OwnerID: record.identity.ownerId,
        ProfileID: record.identity.profileId,
        ComputerID: record.identity.computerId,
        Scope: record.identity.scope,
        SessionID: "",
        TaskID: "",
        TaskEpoch: 0,
        ParticipantID: "",
      },
      ComputerGeneration: record.computerGeneration,
      WorkspaceID: record.workspaceId,
      RelativePath: record.relativePath,
      RequestDigest: record.requestDigest,
      Connector: {
        BuildID: "",
        BackendGeneration: "",
        RuntimeID: "",
        ConnectorGeneration: 0,
        SessionID: "",
        TaskID: "",
        ParticipantID: "",
        TurnID: "",
        CallID: "",
        TaskEpoch: 0,
        Generation: 0,
        Operation: "",
      },
    },
  };
}
function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

const malformedMutations = [
  {
    name: "malformed JSON",
    bytes: () => Buffer.from('{"record":'),
  },
  {
    name: "duplicate immutable owner key",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      Buffer.from(
        JSON.stringify(value).replace(
          '"ownerId":',
          '"ownerId":"shadow-owner","ownerId":',
        ),
      ),
  },
  {
    name: "escaped duplicate immutable owner key",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      Buffer.from(
        JSON.stringify(value).replace(
          '"ownerId":',
          '"\\u006fwnerId":"shadow-owner","ownerId":',
        ),
      ),
  },
  {
    name: "invalid UTF-8",
    bytes: () =>
      Buffer.concat([
        Buffer.from('{"record":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]),
  },
  {
    name: "missing immutable identity",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      json({ ...value, record: { ...value.record, identity: null } }),
  },
  {
    name: "non-string immutable binding field",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      json({ ...value, record: { ...value.record, requestDigest: {} } }),
  },
  {
    name: "unsafe computer generation",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      json({
        ...value,
        record: {
          ...value.record,
          computerGeneration: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
  },
  {
    name: "negative computer generation",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      json({ ...value, record: { ...value.record, computerGeneration: -1 } }),
  },
  {
    name: "fractional computer generation",
    bytes: (value: ReturnType<typeof mutationValue>) =>
      json({ ...value, record: { ...value.record, computerGeneration: 0.5 } }),
  },
];

describe.skipIf(process.platform !== "darwin")(
  "startup preserved recovery selection on retained real files",
  () => {
    it("retains the factory pin through immutable selection and refuses a replaced legacy inode", async () => {
      const f = await fixture();
      const legacyRoot = path.join(f.state, "chatgpt-task-journal");
      const file = path.join(legacyRoot, "chatgpt-task-journal.json");
      await privateDirectory(legacyRoot);
      const bytes = json({
        schema: 1,
        operationId: "98628534-270c-4d55-bc02-20624596c418",
        kind: "readonly",
        phase: "prepared",
        result: null,
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
      await privateFile(file, bytes);
      const before = await inventory(f.root);
      const selected = await selectStartupPreservedRecovery(inputFor(f));
      expect(selected.legacyPreparation).toBeDefined();
      expect(() =>
        assertStartupLegacyPreparation(selected.legacyPreparation!, f.userData),
      ).not.toThrow();
      await selected.recheck();
      expect(await inventory(f.root)).toEqual(before);
      const displaced = path.join(
        f.retained,
        "original-legacy-preparation.json",
      );
      await fs.rename(file, displaced);
      await privateFile(file, bytes);
      await expect(selected.recheck()).rejects.toThrow();
      expect(await fs.readFile(displaced)).toEqual(bytes);
      expect(await fs.readFile(file)).toEqual(bytes);
    });

    it.each([false, true])(
      "selects an empty namespace and exact native roots (Quit present: %s)",
      async (quitPresent) => {
        const f = await fixture({ quit: quitPresent });
        const before = await inventory(f.root);
        const storage = openExistingNativeProfileStorage(f.state, COMPUTER_ID);
        expect(storage).toEqual({
          profileId: PROFILE_ID,
          root: f.core,
          storeMode: "open",
          settingsMutations: false,
        });
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        const parent = await fs.lstat(f.core);
        const chat = await fs.lstat(f.chat);
        const current = {
          Scope: { ProfileID: PROFILE_ID, BackendGeneration: "" },
          ParentRoot: {
            Device: parent.dev,
            Inode: parent.ino,
            OwnerUID: process.geteuid!(),
          },
          ChatRoot: {
            Device: chat.dev,
            Inode: chat.ino,
            OwnerUID: process.geteuid!(),
          },
        };
        expect(selected.profile).toEqual({
          profileId: PROFILE_ID,
          root: f.core,
          home: f.home,
          device: String(parent.dev),
          inode: String(parent.ino),
        });
        expect(selected.exact.current).toEqual(current);
        expect(selected.selectionInput).toEqual({
          Selection: {
            OperationID: selected.exact.operationId,
            Current: current,
            HandoffDigest: Array<number>(32).fill(0),
            LifecycleDigest: Array<number>(32).fill(0),
            ResultsDigest: Array<number>(32).fill(0),
            Next: {
              ProfileID: PROFILE_ID,
              BackendGeneration: selected.exact.backendGeneration,
            },
            BuildID: BUILD_ID,
            HostLifetimeID: selected.exact.hostLifetimeId,
            ChildLaunchID: selected.exact.childLaunchId,
          },
          OwnerID: "owner-desktop",
          ComputerID: COMPUTER_ID,
          AccessDigest: Array.from(
            createHash("sha256")
              .update(await fs.readFile(f.access))
              .digest(),
          ),
          Mutations: [],
        });
        expect(selected.exact.buildId).toBe(BUILD_ID);
        expect(selected.expectedRunSha256).toBe(sum(await fs.readFile(f.run)));
        expect(selected.expectedConfigSha256).toBe(
          sum(await fs.readFile(f.config)),
        );
        expect(Object.hasOwn(selected, "expectedQuitSha256")).toBe(quitPresent);
        if (quitPresent)
          expect(selected.expectedQuitSha256).toBe(
            sum(await fs.readFile(f.quit)),
          );
        await selected.recheck();
        expect(await inventory(f.root)).toEqual(before);
      },
    );

    it("selects every phase in filename order with complete binding and full-byte digest", async () => {
      const f = await fixture({ quit: true });
      const completed = await writeMutation(
        f,
        127,
        "completed",
        Number.MAX_SAFE_INTEGER,
      );
      const prepared = await writeMutation(f, 0, "prepared");
      const unknown = await writeMutation(f, 64, "outcome_unknown");
      const before = await inventory(f.root);
      const selected = await selectStartupPreservedRecovery(inputFor(f));
      // These phases remain opaque and selected for later canonical Go refusal.
      // No assertion grants settlement, recovery or connector authority.
      expect(selected.selectionInput.Mutations).toEqual(
        [prepared, unknown, completed].map(projectedMutation),
      );
      await selected.recheck();
      expect(await inventory(f.root)).toEqual(before);
    });

    it("deep-freezes all returned data and selects distinct future identities", async () => {
      const f = await fixture();
      await writeMutation(f, 1, "outcome_unknown");
      const before = await inventory(f.root);
      const first = await selectStartupPreservedRecovery(inputFor(f));
      const second = await selectStartupPreservedRecovery(inputFor(f));
      for (const selected of [first, second]) expectDeepFrozen(selected);
      const ids = [first, second].flatMap(({ exact }) => [
        exact.operationId,
        exact.hostLifetimeId,
        exact.childLaunchId,
        exact.backendGeneration,
      ]);
      expect(new Set(ids).size).toBe(8);
      for (const id of ids)
        expect(id).toMatch(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
        );
      const original = JSON.stringify(first);
      const mutation = first.selectionInput.Mutations[0] as ReturnType<
        typeof projectedMutation
      >;
      expect(Reflect.set(first, "expectedRunSha256", "0".repeat(64))).toBe(
        false,
      );
      expect(Reflect.set(first.profile, "root", f.home)).toBe(false);
      expect(
        Reflect.set(first.exact.current.Scope, "BackendGeneration", "old"),
      ).toBe(false);
      expect(Reflect.set(mutation.Binding.Identity, "OwnerID", "changed")).toBe(
        false,
      );
      expect(Reflect.set(mutation.Binding.Connector, "BuildID", BUILD_ID)).toBe(
        false,
      );
      expect(
        Reflect.set(first.selectionInput.Selection.HandoffDigest, "0", 1),
      ).toBe(false);
      expect(Reflect.set(first.selectionInput.Mutations, "length", 0)).toBe(
        false,
      );
      expect(JSON.stringify(first)).toBe(original);
      await first.recheck();
      await second.recheck();
      expect(await inventory(f.root)).toEqual(before);
    });

    it.each([128, 129])(
      "keeps the namespace count bound exact at %s entries",
      async (count) => {
        const f = await fixture();
        for (let index = count - 1; index >= 0; index--)
          await writeMutation(f, index, "prepared");
        if (count === 129) {
          await refusesUnchanged(
            f,
            () => selectStartupPreservedRecovery(inputFor(f)),
            "STARTUP_PRESERVED_SELECTION_INVALID",
          );
        } else {
          const before = await inventory(f.root);
          const selected = await selectStartupPreservedRecovery(inputFor(f));
          const expected = Array.from({ length: count }, (_, index) => {
            const value = mutationValue(index, "prepared");
            return projectedMutation({
              key: mutationKey(index),
              file: path.join(f.mutations, mutationKey(index)),
              value,
              bytes: json(value),
            });
          });
          expect(selected.selectionInput.Mutations).toEqual(expected);
          expect(await inventory(f.root)).toEqual(before);
        }
      },
    );

    it.each([
      "profile-root",
      "profile",
      "mutations",
      "task",
      "read-only-state",
    ] as const)(
      "never provisions or repairs invalid existing storage: %s",
      async (kind) => {
        const f = await fixture(
          kind === "read-only-state" ? {} : { missing: kind },
        );
        if (kind === "read-only-state") await fs.chmod(f.state, 0o500);
        await refusesUnchanged(f, () =>
          selectStartupPreservedRecovery(inputFor(f)),
        );
      },
    );

    it("refuses an existing pending intent without altering the intent or any originals", async () => {
      const f = await fixture({ quit: true });
      await writeMutation(f, 1, "outcome_unknown");
      await privateFile(f.pending, "opaque pending intent; outcome unknown\n");
      await refusesUnchanged(
        f,
        () => selectStartupPreservedRecovery(inputFor(f)),
        "EMPTY_CHAT_RECOVERY_STATE_PRESENT",
      );
    });

    it.each([
      "symlink-mutation",
      "hardlink-access",
      "insecure-config",
      "oversized-mutation",
      "symlink-chat",
    ] as const)(
      "refuses a representative unsafe filesystem boundary: %s",
      async (kind) => {
        const f = await fixture();
        const mutation = await writeMutation(f, 1);
        if (kind === "symlink-mutation") {
          const original = path.join(f.retained, mutation.key);
          await fs.rename(mutation.file, original);
          await fs.symlink(original, mutation.file);
        } else if (kind === "hardlink-access") {
          await fs.link(
            f.access,
            path.join(f.retained, "access-hardlink.json"),
          );
        } else if (kind === "insecure-config") {
          await fs.chmod(f.config, 0o644);
        } else if (kind === "oversized-mutation") {
          await fs.appendFile(
            mutation.file,
            Buffer.alloc(65537 - mutation.bytes.length, 0x20),
          );
        } else {
          const original = path.join(f.retained, "chat-original");
          await fs.rename(f.chat, original);
          await fs.symlink(original, f.chat);
        }
        await refusesUnchanged(f, () =>
          selectStartupPreservedRecovery(inputFor(f)),
        );
      },
    );

    it.each(["unexpected.json", `${"A".repeat(64)}.json`])(
      "refuses the whole selection rather than filtering namespace entry %s",
      async (name) => {
        const f = await fixture();
        await writeMutation(f, 0);
        await privateFile(
          path.join(f.mutations, name),
          json(mutationValue(1, "prepared")),
        );
        await refusesUnchanged(
          f,
          () => selectStartupPreservedRecovery(inputFor(f)),
          "STARTUP_PRESERVED_SELECTION_INVALID",
        );
      },
    );

    it.each(malformedMutations)(
      "refuses $name without returning a filtered partial selection",
      async ({ bytes }) => {
        const f = await fixture();
        await writeMutation(f, 0, "completed");
        await privateFile(
          path.join(f.mutations, mutationKey(1)),
          bytes(mutationValue(1, "prepared")),
        );
        await writeMutation(f, 2, "outcome_unknown");
        await refusesUnchanged(f, () =>
          selectStartupPreservedRecovery(inputFor(f)),
        );
      },
    );

    it.each(["addition", "removal"] as const)(
      "recheck detects mutation namespace %s",
      async (kind) => {
        const f = await fixture();
        const mutation = await writeMutation(f, 1);
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        if (kind === "addition") await writeMutation(f, 2, "prepared");
        else
          await fs.rename(mutation.file, path.join(f.retained, mutation.key));
        await refusesUnchanged(
          f,
          selected.recheck,
          "STARTUP_PRESERVED_SELECTION_CHANGED",
        );
      },
    );

    it.each(["run", "mutation"] as const)(
      "recheck detects same-byte inode replacement: %s",
      async (kind) => {
        const f = await fixture();
        const mutation = await writeMutation(f, 1);
        const file = kind === "run" ? f.run : mutation.file;
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        const before = await fs.lstat(file);
        const bytes = await fs.readFile(file);
        await fs.rename(file, path.join(f.retained, path.basename(file)));
        await privateFile(file, bytes);
        expect((await fs.lstat(file)).ino).not.toBe(before.ino);
        expect(await fs.readFile(file)).toEqual(bytes);
        await refusesUnchanged(
          f,
          selected.recheck,
          "EMPTY_CHAT_RECOVERY_STATE_CHANGED",
        );
      },
    );

    it.each([
      "run",
      "config",
      "access",
      "profile",
      "quit",
      "mutation",
    ] as const)(
      "recheck detects changed bytes on the original inode: %s",
      async (kind) => {
        const f = await fixture({ quit: true });
        const mutation = await writeMutation(f, 1);
        const file = kind === "mutation" ? mutation.file : f[kind];
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        const before = await fs.lstat(file);
        const bytes = await fs.readFile(file);
        await fs.copyFile(file, path.join(f.retained, path.basename(file)));
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
        await fs.writeFile(file, changed);
        expect((await fs.lstat(file)).ino).toBe(before.ino);
        expect(sum(changed)).not.toBe(sum(bytes));
        await refusesUnchanged(
          f,
          selected.recheck,
          "EMPTY_CHAT_RECOVERY_STATE_CHANGED",
        );
      },
    );

    it.each(["quit", "pending"] as const)(
      "recheck refuses previously absent %s appearing",
      async (kind) => {
        const f = await fixture();
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        await privateFile(f[kind], "new opaque retained state\n");
        await refusesUnchanged(
          f,
          selected.recheck,
          "EMPTY_CHAT_RECOVERY_STATE_PRESENT",
        );
      },
    );

    it.each(["core", "chat"] as const)(
      "recheck detects changed %s root identity",
      async (kind) => {
        const f = await fixture();
        const selected = await selectStartupPreservedRecovery(inputFor(f));
        const original = await fs.lstat(f[kind]);
        await fs.rename(f[kind], path.join(f.retained, `${kind}-original`));
        await privateDirectory(f[kind]);
        expect((await fs.lstat(f[kind])).ino).not.toBe(original.ino);
        await refusesUnchanged(
          f,
          selected.recheck,
          "STARTUP_PRESERVED_SELECTION_CHANGED",
        );
      },
    );

    it.each([1, 2, 3, 4, 5])(
      "propagates the original callback failure at gate %s without writes",
      async (failureAt) => {
        const f = await fixture();
        const before = await inventory(f.root);
        const originalFailure = new Error(
          "fixture current-owner assertion failed",
        );
        let calls = 0;
        const input = {
          ...inputFor(f),
          assertCurrent: async () => {
            if (++calls === failureAt) throw originalFailure;
          },
        };
        if (failureAt <= 3)
          await expect(selectStartupPreservedRecovery(input)).rejects.toBe(
            originalFailure,
          );
        else {
          const selected = await selectStartupPreservedRecovery(input);
          await expect(selected.recheck()).rejects.toBe(originalFailure);
        }
        expect(calls).toBe(failureAt);
        expect(await inventory(f.root)).toEqual(before);
      },
    );

    it("captures original callback and input values before awaiting the first gate", async () => {
      const f = await fixture();
      const other = await fixture();
      const before = await inventory(f.root);
      const otherBefore = await inventory(other.root);
      let originalCalls = 0;
      let replacementCalls = 0;
      const input = inputFor(f);
      input.assertCurrent = async () => {
        originalCalls++;
        if (originalCalls === 1) {
          input.userData = other.userData;
          input.home = other.home;
          input.computerId = "replacement-computer";
          input.buildId = "cd".repeat(32);
          input.assertCurrent = async () => {
            replacementCalls++;
            throw new Error("replacement callback must never be used");
          };
        }
      };
      const selected = await selectStartupPreservedRecovery(input);
      expect(originalCalls).toBe(3);
      expect(selected.profile.root).toBe(f.core);
      expect(selected.profile.home).toBe(f.home);
      expect(selected.selectionInput.ComputerID).toBe(COMPUTER_ID);
      expect(selected.exact.buildId).toBe(BUILD_ID);
      await selected.recheck();
      expect(originalCalls).toBe(5);
      expect(replacementCalls).toBe(0);
      expect(await inventory(f.root)).toEqual(before);
      expect(await inventory(other.root)).toEqual(otherBefore);
    });
  },
);
