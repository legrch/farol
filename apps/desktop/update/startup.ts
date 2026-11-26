import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../../src/pkg/build-info/identity";
import { treeDigest } from "../../../src/pkg/artifact-tree-digest/digest";
import {
  ADOPTED_BASELINE_FILE,
  SHARED_SLOT,
  adoptedRecordFor,
  installerManifestForAdoption,
  publishAdoptedRecord,
  readAdoptedRecord,
  recordAbsent,
  type AdoptionOutcome,
} from "../../../src/apps/desktop/installed-adoption";
import { captureInstalledExecutionSnapshot } from "../../../src/apps/desktop/installed-execution-snapshot";
import type { InstalledExecutionSnapshot } from "../../../src/apps/desktop/installed-execution-snapshot";
import {
  AcceptedBuild,
  ClosedRepairJournal,
  ClosedRepairReceipt,
  Journal,
  Operation,
  PromotionReceipt,
  Retained,
  SavedReceipt,
  sameBuild,
  sameOperation,
} from "./record";
import {
  canonicalOwnedDirectory,
  privateDirectory,
  readRecord,
  readReadyRecord,
  readRestoreIntent,
  writeRecord,
} from "./records";
import { installedUpdateStartupDecision, startupHelperState } from "./decision";
import { observeHelper, type ProcessRead } from "./process";

// What a fresh owner observes at startup, before anything else may run: the
// operation binding and journal under an authenticated update root, installer
// custody, and the correlation of the running build with the accepted or
// promoted build of the shared slot or a settled private launch. Every check
// fails closed with its own code, and the order of the reads is the stored
// contract. Nothing here launches a process or retries: the clean `ps` read,
// the release manifest parsing, the version order, the adoption lookup and the
// slot-binding bytes belong to their owners and arrive as ports.

type RejectedDirectoryStat = Pick<
  BigIntStats,
  "dev" | "ino" | "uid" | "mode" | "isDirectory"
>;

async function openRejectedDirectory(directory: string): Promise<
  Readonly<{
    stat(): Promise<RejectedDirectoryStat>;
    close(): Promise<void>;
  }>
> {
  const fd = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  return { stat: () => fd.stat({ bigint: true }), close: () => fd.close() };
}

const readRejectedEntry = (file: string): Promise<RejectedDirectoryStat> =>
  fs.lstat(file, { bigint: true });

export type InstalledUpdateResourcesOrigin = Readonly<{
  slot: "/Applications/Farol.app";
  app: string;
  execution: InstalledExecutionSnapshot;
  recheck(): Promise<void>;
  recheckUpdateSource(): Promise<void>;
}> &
  (
    | Readonly<{ kind: "shared-slot" }>
    | Readonly<{ kind: "private-launch"; operationId: string }>
  );
export type InstalledUpdateRelaunchGuard = Readonly<{
  recheck(): Promise<void>;
  resourcesOrigin?: InstalledUpdateResourcesOrigin;
}>;

export type InstalledUpdateRelaunchOptions = Readonly<{
  args: readonly string[];
  directory: string;
  userData: string;
  build: BuildIdentity;
  // Production Electron supplies its physical, non-ASAR filesystem and copier.
  physicalFiles?: typeof fs;
  copyApp?(source: string, destination: string): Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  // Read-only seams for pure fixtures; production uses the existing native owners.
  observation?: Readonly<{
    canonicalOwnedDirectory: typeof canonicalOwnedDirectory;
    readRecord: typeof readRecord;
    readBuild(
      directory: string,
      file: string,
      timeoutMs: number,
    ): Promise<unknown>;
    readProcess: ProcessRead;
    // Startup adoption only: real-absence probe and atomic record publisher.
    recordAbsent?: typeof recordAbsent;
    writeRecord?: (file: string, value: unknown) => Promise<void>;
    rejectedDirectory?: Readonly<{
      openDirectory: typeof openRejectedDirectory;
      lstat: typeof readRejectedEntry;
    }>;
  }>;
}>;

export type SlotLocation = "shared" | "legacy";
export type StartupManifest = NonNullable<
  ReturnType<typeof installerManifestForAdoption>
>;
type RetainedRecord = z.infer<typeof Retained> | z.infer<typeof SavedReceipt>;

export type StartupPorts = Readonly<{
  slotBinding: Readonly<{
    file: string;
    bytes(
      operation: Pick<
        z.infer<typeof Operation>,
        "operationId" | "source" | "target"
      >,
      location: SlotLocation,
    ): Buffer;
  }>;
  retained(record: RetainedRecord): Readonly<
    | {
        ok: true;
        value: {
          artifactSha256: string;
          version: string;
          buildId: string;
          buildVersion: string;
        };
      }
    | { ok: false }
  >;
  compareVersions(left: string, right: string): number | null;
  adoptionManifest(input: {
    build: z.infer<typeof BuildIdentitySchema>;
    root: string;
  }): Promise<AdoptionOutcome<StartupManifest>>;
  readProcess: ProcessRead;
}>;

export function createStartup(ports: StartupPorts) {
  async function readOperationBinding(
    root: string,
    op: z.infer<typeof Operation>,
    location: SlotLocation,
    read: typeof readRecord = readRecord,
    purpose: "update" | "ordinary-shared-execution" = "update",
  ): Promise<void> {
    if (purpose === "ordinary-shared-execution" && location !== "shared")
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
    const directory = path.join(root, op.operationId);
    const physical = read === readRecord;
    if (physical) {
      await canonicalOwnedDirectory(root, true);
      await canonicalOwnedDirectory(directory, true);
    }
    const before = physical ? await fs.lstat(directory) : null;
    const parent = physical ? await fs.lstat(root) : null;
    let digest: string | null = null;
    const expected = ports.slotBinding.bytes(op, location);
    const raw = await read(
      path.join(root, op.operationId, ports.slotBinding.file),
      true,
      (value) => {
        digest = value;
      },
      8192,
    );
    if (before) {
      await canonicalOwnedDirectory(directory, true);
      const after = await fs.lstat(directory);
      await canonicalOwnedDirectory(root, true);
      const liveParent = await fs.lstat(root);
      if (
        !parent ||
        liveParent.dev !== parent.dev ||
        liveParent.ino !== parent.ino ||
        liveParent.mode !== parent.mode ||
        liveParent.uid !== parent.uid
      )
        throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.uid !== before.uid
      )
        throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
    }
    // A historical record can authenticate the exact current executable image
    // without gaining authority to continue or mutate its unbound update. Keep
    // private-file/parent checks and every present binding strict. All helper,
    // recovery and correlated relaunch callers retain the default update purpose.
    if (
      raw === null &&
      digest === null &&
      purpose === "ordinary-shared-execution"
    )
      return;
    if (
      raw === null ||
      digest !== createHash("sha256").update(expected).digest("hex")
    )
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
  }

  async function readOperationJournal(
    root: string,
    op: z.infer<typeof Operation>,
    location: SlotLocation,
    read: typeof readRecord = readRecord,
  ): Promise<z.infer<typeof Journal>> {
    return Journal.parse(
      await readStartupOperationJournal(root, op, location, read),
    );
  }

  async function readStartupOperationJournal(
    root: string,
    op: z.infer<typeof Operation>,
    location: SlotLocation,
    read: typeof readRecord = readRecord,
    purpose: "update" | "ordinary-shared-execution" = "update",
    absent: typeof recordAbsent = recordAbsent,
  ): Promise<z.infer<typeof Journal> | null> {
    await readOperationBinding(root, op, location, read, purpose);
    const file = path.join(root, op.operationId, "journal.json");
    let raw: unknown;
    try {
      raw = await read(file);
    } catch (error) {
      // A present journal the strict reader refuses (JSON null, a repeated key,
      // invalid UTF-8) is malformed journal evidence, as it always was.
      if (error instanceof Error && error.message === "UPDATE_RECORD_INVALID")
        throw new Error("UPDATE_OPERATION_JOURNAL_INVALID");
      throw error;
    }
    if (raw === null) {
      // JSON null is malformed journal evidence, not the pre-journal crash window.
      // Preserve it; only a separate ENOENT observation permits the none row.
      if (!(await absent(file)))
        throw new Error("UPDATE_OPERATION_JOURNAL_INVALID");
      return null;
    }
    const journal = Journal.parse(raw);
    if (!sameOperation(journal, op))
      throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
    return journal;
  }

  // Runtime resources keep their own immutable private authority. Only an
  // updater admission checks that the mutable public source still matches it.
  async function recheckSharedUpdateSource(
    options: InstalledUpdateRelaunchOptions,
    expected: z.infer<typeof AcceptedBuild>,
  ): Promise<void> {
    const slot = "/Applications/Farol.app";
    const canonical =
      options.observation?.canonicalOwnedDirectory ?? canonicalOwnedDirectory;
    await canonical(slot, false);
    const measured = options.observation
      ? AcceptedBuild.parse(
          await options.observation.readBuild(options.directory, slot, 30000),
        )
      : { ...expected, digest: await treeDigest(slot, options.physicalFiles) };
    if (!sameBuild(measured, expected))
      throw new Error("UPDATE_ACCEPTED_SOURCE_CHANGED");
    await canonical(slot, false);
  }

  async function readInstallerManifestForStartup(
    options: InstalledUpdateRelaunchOptions,
    profile: string,
    build: z.infer<typeof BuildIdentitySchema>,
  ): Promise<StartupManifest | null> {
    const custody = path.join(
      os.userInfo().homedir,
      "Library/Application Support/io.github.legrch.farol-installer",
    );
    const file = path.join(custody, "current.json");
    if (!options.observation) {
      try {
        await fs.lstat(custody);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
      }
      try {
        await canonicalOwnedDirectory(custody, true);
      } catch {
        throw new Error("UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
      }
    }
    let raw: unknown | null;
    try {
      raw = await (options.observation?.readRecord ?? readRecord)(
        file,
        true,
        undefined,
        4096,
      );
      if (
        raw === null &&
        !(await (options.observation?.recordAbsent ?? recordAbsent)(file))
      )
        throw new Error("UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    } catch {
      throw new Error("UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    }
    return installerManifestForAdoption(raw, profile, build);
  }

  // Ordinary public-slot startup must satisfy AttestedCore's immutable-tree
  // contract before any backend binary is spawned. Baselines authenticate code;
  // runtime lifetime and updater recovery still keep their independent gates.
  async function observeSharedSlotStartup(
    options: InstalledUpdateRelaunchOptions,
  ): Promise<InstalledUpdateRelaunchGuard | null> {
    if (options.directory !== "/Applications/Farol.app/Contents/Resources/app")
      return null;
    const app = "/Applications/Farol.app";
    const profile = path.join(
      os.userInfo().homedir,
      "Library/Application Support/io.github.legrch.farol",
    );
    const root = path.join(profile, "installed-updates");
    const build = BuildIdentitySchema.parse(options.build);
    if (
      options.userData !== profile ||
      !options.copyApp ||
      !options.physicalFiles ||
      build.sourceDirty ||
      !build.buildVersion ||
      !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
      createHash("sha256")
        .update(canonicalBuildIdentityPayload(build))
        .digest("hex") !== build.buildId
    )
      throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
    const read = options.observation?.readRecord ?? readRecord;
    if (!options.observation) {
      await canonicalOwnedDirectory(profile, true);
      await privateDirectory(root);
    }
    // Every startup observes installer custody, including a fresh profile or an
    // unchanged OTA build. Pending placement must not be bypassed by another
    // baseline path, and a completed matching placement works offline.
    const installedManifest = await readInstallerManifestForStartup(
      options,
      profile,
      build,
    );
    const operationImage = async (record: z.infer<typeof Retained>) => {
      const op = record.operation ?? record.preparation;
      const parsed = ports.retained(record);
      if (
        !op ||
        !parsed.ok ||
        !sameBuild(op.target, {
          digest: parsed.value.artifactSha256,
          version: parsed.value.version,
          buildId: parsed.value.buildId,
        })
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      await readOperationBinding(
        root,
        op,
        "shared",
        read,
        "ordinary-shared-execution",
      );
      const expected = [op.source, op.target].find(
        (value) =>
          value.buildId === build.buildId && value.version === build.version,
      );
      if (!expected) throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      return expected;
    };
    let expected: z.infer<typeof AcceptedBuild>;
    // Set only by first-launch adoption; published after a successful capture.
    let adoption: {
      file: string;
      record: ReturnType<typeof adoptedRecordFor>;
      replacing: string | null;
    } | null = null;
    // A ready record is a fence: only a verified absence is "none prepared",
    // and a present one holding JSON null is invalid evidence.
    const ready = await readReadyRecord(
      path.join(root, "ready.json"),
      read,
      options.observation?.recordAbsent ?? recordAbsent,
    );
    const saved = await read(path.join(root, "last-update.json"));
    const repair = await read(app + ".repair.json");
    const repairJournal = await read("/Applications/.farol-closed-repair.json");
    const readyRecord = ready === null ? null : Retained.parse(ready);
    let active =
      readyRecord?.operation || readyRecord?.preparation
        ? readyRecord
        : saved !== null
          ? SavedReceipt.parse(saved)
          : null;
    let manualReplacement = false;
    // A restore intent is the recovery fence. Every path that can admit this
    // startup consults it; only the active-operation path may continue past a
    // valid intent, because it correlates the intent with its own operation.
    // Absent (ENOENT) means none, a present null or malformed record refuses.
    const refuseRestoreIntent = async (): Promise<void> => {
      const pending = await readRestoreIntent(
        path.join(root, "restore-pending.json"),
        read,
        options.observation?.recordAbsent ?? recordAbsent,
      );
      if (pending) throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    };
    if (
      active?.operation &&
      saved !== null &&
      !readyRecord?.operation &&
      !readyRecord?.preparation &&
      ![active.operation.source, active.operation.target].some(
        (item) =>
          item.buildId === build.buildId && item.version === build.version,
      )
    ) {
      const previous = SavedReceipt.parse(saved);
      const op = previous.operation;
      const parsed = ports.retained(previous);
      const settledBuild =
        previous.phase === "completed"
          ? op?.target
          : previous.phase === "rolled_back"
            ? op?.source
            : null;
      const absent = options.observation?.recordAbsent ?? recordAbsent;
      if (
        !op ||
        !settledBuild ||
        previous.runningBuildId !== settledBuild.buildId ||
        !parsed.ok ||
        !sameBuild(op.target, {
          digest: parsed.value.artifactSha256,
          version: parsed.value.version,
          buildId: parsed.value.buildId,
        }) ||
        ports.compareVersions(build.version, op.target.version) !== 1 ||
        BigInt(build.buildVersion!) <= BigInt(parsed.value.buildVersion) ||
        repair !== null ||
        repairJournal !== null ||
        readyRecord?.helper ||
        (readyRecord !== null && !ports.retained(readyRecord).ok) ||
        !(
          await Promise.all(
            [
              "restore-pending.json",
              "download-pending.json",
              "package-cleanup-pending.json",
            ].map((name) => absent(path.join(root, name))),
          )
        ).every(Boolean) ||
        !(await absent(app + ".repair.json")) ||
        !(await absent("/Applications/.farol-closed-repair.json"))
      ) {
        // A present null or malformed restore marker is invalid evidence; a
        // valid one, like any other refusal here, stays unconfirmed.
        await readRestoreIntent(
          path.join(root, "restore-pending.json"),
          read,
          absent,
        );
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      }
      try {
        await readOperationBinding(root, op, "shared", read);
        const journal = await readStartupOperationJournal(
          root,
          op,
          "shared",
          read,
          "update",
          absent,
        );
        const helper = await observeHelper(
          previous.helper,
          options.observation?.readProcess ?? ports.readProcess,
        );
        if (
          journal?.phase !== previous.phase ||
          startupHelperState(helper) !== "exited"
        )
          throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      } catch {
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      }
      manualReplacement = true;
      active = null;
    }
    if (active?.operation) {
      const record = active;
      expected = await operationImage(record);
      const op = record.operation!;
      const pending = await readRestoreIntent(
        path.join(root, "restore-pending.json"),
        read,
        options.observation?.recordAbsent ?? recordAbsent,
      );
      if (pending && !sameOperation(pending.operation, op))
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      const helper = await observeHelper(
        pending && !pending.notStartedAt ? pending.helper : record.helper,
        options.observation?.readProcess ?? ports.readProcess,
      );
      const journal = await readStartupOperationJournal(
        root,
        op,
        "shared",
        read,
        "ordinary-shared-execution",
        options.observation?.recordAbsent ?? recordAbsent,
      );
      const installed = options.observation
        ? AcceptedBuild.parse(
            await options.observation.readBuild(options.directory, app, 30000),
          )
        : { ...expected, digest: await treeDigest(app, options.physicalFiles) };
      const decision = installedUpdateStartupDecision({
        phase: journal?.phase ?? null,
        helper: startupHelperState(helper),
        installed,
        running: build,
        operation: op,
      });
      if (!decision.mayStart)
        throw new Error(
          helper === "live" || helper === "unknown"
            ? "UPDATE_HELPER_EXIT_UNCONFIRMED"
            : "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
        );
    } else if (active?.preparation) {
      await refuseRestoreIntent();
      expected = await operationImage(active);
    } else if (repair !== null || repairJournal !== null) {
      await refuseRestoreIntent();
      const receipt = ClosedRepairReceipt.parse(repair);
      const journal = ClosedRepairJournal.parse(repairJournal);
      if (
        receipt.destination !== app ||
        receipt.userData !== profile ||
        journal.phase !== receipt.phase ||
        JSON.stringify(journal.receipt) !== JSON.stringify(receipt)
      )
        throw new Error("UPDATE_REPAIR_RECOVERY_REQUIRED");
      expected =
        receipt.phase === "installed" ? receipt.target : receipt.source;
    } else {
      await refuseRestoreIntent();
      const file = app + ".receipt.json";
      const receiptRaw = await read(file);
      // Adoption needs every other piece of baseline evidence to be truly absent
      // (ENOENT). A file that exists, even holding JSON null, keeps the refusal
      // below. A ready record is allowed only when it is a plain retained
      // download with no operation: the user may quit between downloading an
      // update and installing it, and that must not strand an adopted copy.
      const absent = options.observation?.recordAbsent ?? recordAbsent;
      if (
        manualReplacement ||
        (receiptRaw === null &&
          saved === null &&
          repair === null &&
          repairJournal === null &&
          // Absent, or the very retained-download record the updater itself
          // accepts (valid manifest, non-empty handle). Anything malformed refuses.
          (ready === null || ports.retained(Retained.parse(ready)).ok) &&
          (
            await Promise.all(
              [
                file,
                path.join(root, "last-update.json"),
                app + ".repair.json",
                "/Applications/.farol-closed-repair.json",
              ].map(absent),
            )
          ).every(Boolean))
      ) {
        const adoptedFile = path.join(root, ADOPTED_BASELINE_FILE);
        const state = await readAdoptedRecord({
          file: adoptedFile,
          slot: SHARED_SLOT,
          userData: profile,
          build,
          read,
          absent,
        });
        if (state.kind === "expected") {
          // A recorded baseline never touches the network.
          expected = { ...state.expected };
        } else {
          // A completed native placement carries the manifest verified before
          // its namespace effect. Other manually placed copies still use the
          // published release lookup.
          let manifest = installedManifest;
          if (!manifest) {
            const resolved = await ports.adoptionManifest({ build, root });
            if (!resolved.ok) throw new Error(resolved.code);
            manifest = resolved.value;
          }
          let measured: string;
          try {
            measured = options.observation
              ? AcceptedBuild.parse(
                  await options.observation.readBuild(
                    options.directory,
                    app,
                    30000,
                  ),
                ).digest
              : await treeDigest(app, options.physicalFiles);
          } catch {
            throw new Error("UPDATE_ADOPTION_TREE_UNREADABLE");
          }
          if (measured !== manifest.artifactSha256)
            throw new Error("UPDATE_ADOPTION_TREE_MISMATCH");
          expected = {
            digest: manifest.artifactSha256,
            version: manifest.version,
            buildId: manifest.buildId,
          };
          adoption = {
            file: adoptedFile,
            record: adoptedRecordFor({
              slot: SHARED_SLOT,
              userData: profile,
              manifest,
            }),
            replacing: state.kind === "superseded" ? state.digest : null,
          };
        }
      } else {
        const receipt = PromotionReceipt.parse(receiptRaw);
        if (
          receipt.destination !== app ||
          receipt.receipt !== file ||
          receipt.activation.userData !== profile ||
          receipt.sourceCommit !== build.sourceCommit ||
          receipt.sourceTreeDigest !== build.sourceTreeDigest ||
          receipt.version !== build.version ||
          receipt.artifactSha256 !== receipt.verifiedDestinationSha256
        )
          throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expected = {
          digest: receipt.verifiedDestinationSha256,
          version: receipt.version,
          buildId: build.buildId,
        };
      }
    }
    if (
      expected.buildId !== build.buildId ||
      expected.version !== build.version
    )
      throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    const execution = await captureInstalledExecutionSnapshot({
      sourceApp: app,
      sourceExecutable: process.execPath,
      privateParent: root,
      expectedDigest: expected.digest,
      copyApp: options.copyApp,
      physicalFiles: options.physicalFiles,
    });
    if (adoption) {
      // Only the verified, captured image may anchor the record, and nothing is
      // written under /Applications. A failed write is a closed failure.
      let published: boolean;
      try {
        published = await publishAdoptedRecord({
          ...adoption,
          read,
          write: options.observation?.writeRecord ?? writeRecord,
        });
      } catch {
        throw new Error("UPDATE_ADOPTION_RECORD_UNWRITTEN");
      }
      if (!published) {
        // Another writer replaced the superseded record: it must validate for
        // this exact build and manifest digest, else startup stays refused.
        const current = await readAdoptedRecord({
          file: adoption.file,
          slot: SHARED_SLOT,
          userData: profile,
          build,
          read,
          absent: options.observation?.recordAbsent ?? recordAbsent,
        });
        if (
          current.kind !== "expected" ||
          current.expected.digest !== expected.digest
        )
          throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      }
    }
    const resourcesOrigin: InstalledUpdateResourcesOrigin = Object.freeze({
      kind: "shared-slot",
      slot: "/Applications/Farol.app",
      app,
      execution,
      recheck: execution.recheck,
      recheckUpdateSource: () => recheckSharedUpdateSource(options, expected),
    });
    return Object.freeze({ resourcesOrigin, recheck: execution.recheck });
  }

  // LaunchServices can reopen the last private image without its one-shot hint.
  // Such a reopen still requires the genuine settled generation and slot binding.
  async function observeCompletedPrivateLaunch(
    options: InstalledUpdateRelaunchOptions,
  ): Promise<InstalledUpdateRelaunchGuard | null> {
    const profile = path.join(
      os.userInfo().homedir,
      "Library/Application Support/io.github.legrch.farol",
    );
    const root = path.join(profile, "installed-updates");
    const app = path.resolve(options.directory, "../../..");
    const relative = path.relative(root, app).split(path.sep);
    if (
      relative.length !== 2 ||
      !/^[a-f0-9]{32}$/u.test(relative[0]!) ||
      relative[1] !== "launch-Farol.app"
    )
      return null;
    if (
      options.userData !== profile ||
      !options.copyApp ||
      !options.physicalFiles ||
      options.directory !== path.join(app, "Contents/Resources/app")
    )
      throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
    const build = BuildIdentitySchema.parse(options.build);
    if (
      build.sourceDirty ||
      !build.buildVersion ||
      !["github-owner-beta", "github-stable"].includes(build.updateChannel) ||
      createHash("sha256")
        .update(canonicalBuildIdentityPayload(build))
        .digest("hex") !== build.buildId
    )
      throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
    const read = options.observation?.readRecord ?? readRecord;
    const canonical =
      options.observation?.canonicalOwnedDirectory ?? canonicalOwnedDirectory;
    const binding = Operation.extend({
      schema: z.literal("farol.installed-operation-slot/1"),
      installLocation: z.literal("shared"),
    }).parse(await read(path.join(root, relative[0]!, ports.slotBinding.file)));
    const operation = Operation.parse({
      operationId: binding.operationId,
      source: binding.source,
      target: binding.target,
    });
    if (
      operation.operationId !== relative[0] ||
      operation.target.buildId !== build.buildId ||
      operation.target.version !== build.version
    )
      throw new Error("UPDATE_RELAUNCH_IDENTITY_MISMATCH");
    await readOperationBinding(root, operation, "shared", read);
    const settled = async () => {
      await readInstallerManifestForStartup(options, profile, build);
      for (const [directory, privateMode] of [
        [profile, true],
        [root, true],
        [path.join(root, operation.operationId), true],
        [app, true],
        ["/Applications/Farol.app", false],
      ] as const)
        await canonical(directory, privateMode);
      const receipt = SavedReceipt.parse(
        await read(path.join(root, "last-update.json")),
      );
      const parsed = ports.retained(receipt);
      if (
        !receipt.operation ||
        !parsed.ok ||
        !sameBuild(receipt.operation.target, {
          digest: parsed.value.artifactSha256,
          version: parsed.value.version,
          buildId: parsed.value.buildId,
        })
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      await readOperationBinding(root, receipt.operation, "shared", read);
      const expected = operation.target;
      if (!sameOperation(receipt.operation, operation))
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      const pending = await readRestoreIntent(
        path.join(root, "restore-pending.json"),
        read,
        options.observation?.recordAbsent ?? recordAbsent,
      );
      if (pending && !sameOperation(pending.operation, operation))
        throw new Error("UPDATE_OPERATION_IDENTITY_MISMATCH");
      const helper = await observeHelper(
        pending && !pending.notStartedAt ? pending.helper : receipt.helper,
        options.observation?.readProcess ?? ports.readProcess,
      );
      const journal = await readStartupOperationJournal(
        root,
        operation,
        "shared",
        read,
        "update",
        options.observation?.recordAbsent ?? recordAbsent,
      );
      const measured = options.observation
        ? AcceptedBuild.parse(
            await options.observation.readBuild(
              options.directory,
              "/Applications/Farol.app",
              30000,
            ),
          )
        : {
            ...expected,
            digest: await treeDigest(
              "/Applications/Farol.app",
              options.physicalFiles,
            ),
          };
      if (
        !installedUpdateStartupDecision({
          phase: journal?.phase ?? null,
          helper: startupHelperState(helper),
          installed: measured,
          running: build,
          operation,
        }).mayStart
      )
        throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      await canonical("/Applications/Farol.app", false);
    };
    await settled();
    const execution = await captureInstalledExecutionSnapshot({
      sourceApp: app,
      sourceExecutable: process.execPath,
      privateParent: root,
      expectedDigest: operation.target.digest,
      copyApp: options.copyApp,
      physicalFiles: options.physicalFiles,
    });
    const resourcesOrigin: InstalledUpdateResourcesOrigin = Object.freeze({
      kind: "private-launch",
      slot: "/Applications/Farol.app",
      app,
      operationId: operation.operationId,
      execution,
      recheckUpdateSource: () =>
        recheckSharedUpdateSource(options, operation.target),
      recheck: async () => {
        await readOperationBinding(root, operation, "shared", read);
        await execution.recheck();
      },
    });
    return Object.freeze({
      resourcesOrigin,
      recheck: async () => {
        await settled();
        await resourcesOrigin.recheck();
      },
    });
  }

  return {
    readOperationBinding,
    readOperationJournal,
    readStartupOperationJournal,
    recheckSharedUpdateSource,
    readInstallerManifestForStartup,
    observeSharedSlotStartup,
    observeCompletedPrivateLaunch,
  };
}

export type Startup = ReturnType<typeof createStartup>;
