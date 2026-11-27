import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  prepareEmptyRecoveryChild,
  type ExactEmptyRecoverySelection,
  type EmptyRecoverySelectionInput,
  type EmptyRecoveryChildResult,
} from "../../../apps/desktop/bridge/empty-recovery-child";
import type { ProfileLaunchBinding } from "../../../apps/desktop/bridge/profile";
import { recordTerminal } from "../../../apps/desktop/bridge/terminal-recorder";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../modules/computer/infra/mcp/private-mcp-lifecycle";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
  type PromotionLeaseHandle,
} from "./promotion-lease";
import { MAX_RUN_MARKER_BYTES } from "./run-marker";
import type { ClosedRecoveryState } from "./closed-computer-recovery";
import {
  installedEmptyQuitScope,
  installedPreservedQuitScope,
  unacknowledgedDevQuitScope,
} from "../../../apps/desktop/recovery/quit";
import { emptyRecoveryIntent } from "../../../apps/desktop/recovery/intent";
import {
  knownEmptyRecoveryChild,
  type KnownEmptyRecoveryFailure,
  type PreparedEmptyRecoveryObservation,
} from "../../../apps/desktop/recovery/known";
import {
  assertClosedSelection,
  assertInstalledEmptySelection,
  assertInstalledPreservedSelection,
  assertInterruptedSelection,
  assertUnacknowledgedDevSelection,
  isOperationId,
  isSha256,
} from "../../../apps/desktop/recovery/selection";
import {
  retainEmptyArchive,
  retainEmptyChatForArchival,
} from "./retained-empty-archive";
import type { PreservedRecoveryBinding } from "../../../apps/desktop/bridge/preserved-recovery-child";
import { LEGACY_PREPARATION_ARCHIVE_NAME } from "./chatgpt-task-journal-record";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Snapshot = Readonly<{ bytes: Buffer; device: number; inode: number }>;
// The finish consumer owns this metadata-retirement port; the selector supplies
// its private factory instance. This conveys no Go/process/connector authority.
export type StartupLegacyPreparation = Readonly<{
  operationId: string;
  sha256: string;
  verify(): Promise<void>;
  // One memoized transition under the existing recovery intent and admission.
  retireInto(archive: string): Promise<Snapshot>;
}>;

// Private desktop host mechanics only. Go owns selected journal validation,
// preservation, retirement and terminal policy. This adapter never resets a
// profile, changes configuration, erases UNKNOWN, writes Quit or starts the app.
async function snapshot(file: string, maximum: number): Promise<Snapshot> {
  const f = await fs.open(file, FLAGS);
  try {
    const a = await f.stat();
    if (
      !a.isFile() ||
      a.nlink !== 1 ||
      a.uid !== process.geteuid?.() ||
      (a.mode & 0o777) !== 0o600 ||
      a.size > maximum
    )
      throw Error("EMPTY_CHAT_RECOVERY_FILE_UNSAFE");
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await f.read(bytes, 0, bytes.length, 0);
    const b = await f.stat();
    const n = await fs.lstat(file);
    if (
      bytesRead !== a.size ||
      b.size !== a.size ||
      b.mtimeMs !== a.mtimeMs ||
      b.ctimeMs !== a.ctimeMs ||
      n.dev !== a.dev ||
      n.ino !== a.ino
    )
      throw Error("EMPTY_CHAT_RECOVERY_STATE_CHANGED");
    return { bytes: bytes.subarray(0, bytesRead), device: a.dev, inode: a.ino };
  } finally {
    await f.close();
  }
}
async function unchanged(file: string, original: Snapshot): Promise<void> {
  const current = await snapshot(file, original.bytes.length);
  if (
    current.device !== original.device ||
    current.inode !== original.inode ||
    !current.bytes.equals(original.bytes)
  )
    throw Error("EMPTY_CHAT_RECOVERY_STATE_CHANGED");
}
async function absent(file: string): Promise<void> {
  try {
    await fs.lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw Error("EMPTY_CHAT_RECOVERY_STATE_PRESENT");
}
async function sync(directory: string): Promise<void> {
  const f = await fs.open(directory, FLAGS | constants.O_DIRECTORY);
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function privateRoot(
  directory: string,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const s = await fs.lstat(directory);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.geteuid?.() ||
    (s.mode & 0o777) !== 0o700 ||
    (await fs.realpath(directory)) !== directory
  )
    throw Error("EMPTY_CHAT_RECOVERY_ROOT_UNSAFE");
  return { dev: s.dev, ino: s.ino };
}

export { emptyRecoveryIntent };
export { knownEmptyRecoveryChild };
export type { KnownEmptyRecoveryFailure, PreparedEmptyRecoveryObservation };
export {
  installedEmptyQuitScope,
  installedPreservedQuitScope,
  unacknowledgedDevQuitScope,
};

export type ClosedEmptyChatRecoveryInput = Readonly<{
  userData: string;
  executable: string;
  profile: ProfileLaunchBinding;
  selectionInput: EmptyRecoverySelectionInput;
  exact: ExactEmptyRecoverySelection;
  expectedRunSha256: string;
  expectedConfigSha256: string;
  // Trusted CLI supplies the existing full owning desktop projection and fixed
  // root process checks. Inspection success cannot provide these permissions.
  desktopState(): Promise<ClosedRecoveryState>;
  processesAbsent(): void;
  attest(): Promise<void>;
}>;

export async function recoverClosedEmptyChat(
  input: ClosedEmptyChatRecoveryInput,
): Promise<
  Readonly<{
    phase: "prepared_for_cold_start";
    archive: string;
    operationId: string;
  }>
> {
  assertClosedSelection(input.selectionInput);
  return recoverSelectedEmptyChat(input);
}

// Explicit Dev-only abandonment of an empty acknowledged lifetime. Its missing
// terminal remains missing in the archive. Only the NEW owner is retired below.
export async function recoverInterruptedEmptyChat(
  input: ClosedEmptyChatRecoveryInput & { expectedQuitSha256: string },
): Promise<
  Readonly<{
    phase: "prepared_for_cold_start";
    archive: string;
    operationId: string;
  }>
> {
  assertInterruptedSelection(
    input.selectionInput,
    input.expectedQuitSha256,
    input.userData,
  );
  return recoverSelectedEmptyChat(input, input.expectedQuitSha256);
}

// Dev-only cold restart of the existing consumed, empty lifetime after an
// unacknowledged Quit. The Go empty-recovery owner must still prove the exact
// original scope/roots, no turns/results/writes and settled Computer records.
// Original exit/ACK facts remain absent; only the maintenance child is retired.
export async function recoverUnacknowledgedEmptyDev(
  input: ClosedEmptyChatRecoveryInput & { expectedQuitSha256: string },
) {
  assertUnacknowledgedDevSelection(
    input.selectionInput,
    input.expectedQuitSha256,
    input.userData,
  );
  return recoverSelectedEmptyChat(input, input.expectedQuitSha256, true);
}

// Installed recovery preserves only a fully qualified consumed empty chain.
// The combined failed Quit remains failed; only a distinct maintenance owner
// receives a new original ACK and observed terminal. Go owns empty selection.
export async function recoverInstalledEmptyChat(
  input: ClosedEmptyChatRecoveryInput & { expectedQuitSha256: string },
) {
  assertInstalledEmptySelection(
    input.selectionInput,
    input.expectedQuitSha256,
    input.userData,
  );
  return recoverSelectedEmptyChat(input, input.expectedQuitSha256, false, true);
}

// Owner-selected maintenance preserves the exact Computer journal, including
// unresolved reservations. It never settles, deletes or retries those operations.
export async function recoverInstalledPreservedChat(
  input: ClosedEmptyChatRecoveryInput & { expectedQuitSha256: string },
) {
  assertInstalledPreservedSelection(
    input.selectionInput,
    input.expectedQuitSha256,
    input.userData,
  );
  return recoverSelectedEmptyChat(
    input,
    input.expectedQuitSha256,
    false,
    true,
    true,
  );
}

async function recoverSelectedEmptyChat(
  input: ClosedEmptyChatRecoveryInput,
  expectedQuitSha256?: string,
  unacknowledgedDev = false,
  installedEmpty = false,
  installedPreserved = false,
): Promise<
  Readonly<{
    phase: "prepared_for_cold_start";
    archive: string;
    operationId: string;
  }>
> {
  const selected = structuredClone({
    userData: input.userData,
    profile: input.profile,
    exact: input.exact,
    selectionInput: input.selectionInput,
  });
  const { userData, profile, exact, selectionInput } = selected;
  const state = path.join(userData, "farol-state");
  if (
    profile.root !== path.join(state, "go-core") ||
    !isOperationId(exact.operationId) ||
    ![input.expectedRunSha256, input.expectedConfigSha256].every(isSha256)
  )
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
  // Validate the comparison shape before any lease/profile/child effect.
  const expectedIntent = emptyRecoveryIntent(selectionInput, profile);
  await privateRoot(userData);
  await privateRoot(state);
  const parent = await privateRoot(profile.root);
  if (
    String(parent.dev) !== profile.device ||
    String(parent.ino) !== profile.inode
  )
    throw Error("EMPTY_CHAT_RECOVERY_ROOT_CHANGED");
  const root = path.join(state, "secure-mcp-connector", "computer-authority");
  await privateRoot(path.dirname(root));
  await privateRoot(root);
  const lease = await acquirePromotionLease(
    userData,
    `empty-chat-recovery-${exact.operationId}`,
    "promotion",
  );
  if (!lease) throw Error("EMPTY_CHAT_RECOVERY_APP_ACTIVE");
  try {
    return await new PrivateExecutionFence({ root }).withClosedRecoveryDrain(
      async () => {
        const running = path.join(state, "running.json");
        const configuration = path.join(state, "config.json");
        const pending = path.join(state, "go-core.empty-recovery.pending");
        const archive = path.join(
          profile.root,
          `chat-retired-${exact.operationId}`,
        );
        const run = await snapshot(running, MAX_RUN_MARKER_BYTES);
        const config = await snapshot(configuration, 256 * 1024);
        const failedQuit =
          expectedQuitSha256 === undefined
            ? undefined
            : await snapshot(path.join(state, "last-quit.json"), 16384);
        let previousConfirmedQuit = false;
        let failedComponents: readonly string[] | undefined;
        if (failedQuit) {
          const quit = JSON.parse(failedQuit.bytes.toString("utf8"));
          if (installedEmpty) {
            (installedPreserved
              ? installedPreservedQuitScope
              : installedEmptyQuitScope)(
              JSON.parse(run.bytes.toString("utf8")),
              quit,
            );
            failedComponents = quit.unconfirmed;
          }
          if (unacknowledgedDev)
            previousConfirmedQuit =
              unacknowledgedDevQuitScope(
                JSON.parse(run.bytes.toString("utf8")),
                quit,
              ) === "previous-confirmed";
          if (
            sum(failedQuit.bytes) !== expectedQuitSha256 ||
            quit.schema !== 1 ||
            (!previousConfirmedQuit &&
              (quit.drained !== false ||
                !isDeepStrictEqual(
                  quit.unconfirmed,
                  installedEmpty
                    ? failedComponents
                    : unacknowledgedDev
                      ? ["go-core", "connector"]
                      : ["go-core"],
                )))
          )
            throw Error("INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED");
        }
        if (
          sum(run.bytes) !== input.expectedRunSha256 ||
          sum(config.bytes) !== input.expectedConfigSha256
        )
          throw Error("EMPTY_CHAT_RECOVERY_STATE_CHANGED");
        let preparedRoots:
          | Readonly<{
              archive: { dev: number; ino: number };
              chat: { dev: number; ino: number };
            }>
          | undefined;
        const proof = async () => {
          const current = await privateRoot(profile.root);
          if (!isDeepStrictEqual(current, parent))
            throw Error("EMPTY_CHAT_RECOVERY_ROOT_CHANGED");
          if (
            preparedRoots &&
            (!isDeepStrictEqual(
              await privateRoot(archive),
              preparedRoots.archive,
            ) ||
              !isDeepStrictEqual(
                await privateRoot(path.join(profile.root, "chat")),
                preparedRoots.chat,
              ))
          )
            throw Error("EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED");
          await unchanged(running, run);
          await unchanged(configuration, config);
          if (failedQuit)
            await unchanged(path.join(state, "last-quit.json"), failedQuit);
          else await absent(path.join(state, "last-quit.json"));
          const desktop = await input.desktopState();
          if (
            desktop.changed.length ||
            desktop.unreadable.length ||
            !isDeepStrictEqual(
              desktop.obligations,
              failedQuit && !previousConfirmedQuit
                ? [
                    installedEmpty
                      ? `QUIT_UNCONFIRMED:${failedComponents!.join(",")}`
                      : unacknowledgedDev
                        ? "QUIT_UNCONFIRMED:go-core,connector"
                        : "QUIT_UNCONFIRMED:go-core",
                    "QUIT_UNCONFIRMED:crash",
                  ]
                : ["QUIT_UNCONFIRMED:crash"],
            )
          )
            throw Error("EMPTY_CHAT_RECOVERY_WORK_PENDING");
          input.processesAbsent();
          if (!(await verifyPromotionLease(lease)))
            throw Error("PROMOTION_LEASE_LOST");
        };
        await absent(pending);
        await absent(archive);
        await input.attest();
        await proof();
        const movedArchive = failedQuit
          ? await retainEmptyChatForArchival(
              path.join(profile.root, "chat"),
              archive,
            )
          : undefined;
        // Original child facts, never reconstructed from a complete-looking head.
        const child = await prepareEmptyRecoveryChild(
          input.executable,
          profile,
          selectionInput,
          exact,
        );
        await proof();
        const archived = await privateRoot(archive);
        if (
          archived.dev !== exact.current.ChatRoot.Device ||
          archived.ino !== exact.current.ChatRoot.Inode
        )
          throw Error("EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED");
        preparedRoots = {
          archive: archived,
          chat: {
            dev: child.publication.Binding.ChatRoot.Device,
            ino: child.publication.Binding.ChatRoot.Inode,
          },
        };
        await proof();
        const intent = await snapshot(pending, 65536);
        if (
          !isDeepStrictEqual(
            JSON.parse(intent.bytes.toString("utf8")),
            expectedIntent,
          )
        )
          throw Error("EMPTY_CHAT_RECOVERY_INTENT_CHANGED");
        return await finishEmptyRecoveryHost({
          input,
          child,
          exact,
          profile,
          state,
          archive,
          run,
          config,
          pending,
          intent,
          preparedRoots,
          lease,
          proof,
          ...(failedQuit ? { failedQuit } : {}),
          ...(previousConfirmedQuit ? { previousConfirmedQuit: true } : {}),
          ...(movedArchive ? { archivePin: await movedArchive() } : {}),
          ...(unacknowledgedDev || installedEmpty
            ? {
                reconcileConnector: async () => {
                  const lifecycle = new PrivateMcpLifecycle(root);
                  await lifecycle.beginClosedRecoveryStop();
                  await lifecycle.reconcileInactive({
                    operationId: exact.operationId,
                    failedQuitSha256: expectedQuitSha256!,
                    proveIdle: proof,
                  });
                  await proof();
                },
              }
            : {}),
        });
      },
    );
  } finally {
    await releasePromotionLease(lease);
  }
}

// One owner-authorized completion of the known pre-recorder comparison failure.
// Never prepare, acknowledge, restore a Chat owner, or launch the application.
export async function completeKnownEmptyChat(
  input: ClosedEmptyChatRecoveryInput & {
    readonly failure: KnownEmptyRecoveryFailure;
    observePrepared(): Promise<PreparedEmptyRecoveryObservation>;
  },
): Promise<{
  phase: "prepared_for_cold_start";
  archive: string;
  operationId: string;
}> {
  const selected = structuredClone({
    profile: input.profile,
    exact: input.exact,
    selectionInput: input.selectionInput,
    failure: input.failure,
  });
  const { profile, exact, selectionInput, failure } = selected;
  const state = path.join(input.userData, "farol-state");
  const archive = path.join(profile.root, `chat-retired-${exact.operationId}`);
  const pending = path.join(state, "go-core.empty-recovery.pending");
  const running = path.join(state, "running.json");
  const configuration = path.join(state, "config.json");
  if (profile.root !== path.join(state, "go-core"))
    throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
  const expectedIntent = emptyRecoveryIntent(selectionInput, profile);
  await privateRoot(input.userData);
  await privateRoot(state);
  const parent = await privateRoot(profile.root);
  if (
    String(parent.dev) !== profile.device ||
    String(parent.ino) !== profile.inode
  )
    throw Error("EMPTY_CHAT_RECOVERY_ROOT_CHANGED");
  const root = path.join(state, "secure-mcp-connector", "computer-authority");
  await privateRoot(path.dirname(root));
  await privateRoot(root);
  const lease = await acquirePromotionLease(
    input.userData,
    `empty-chat-completion-${failure.completionOperationId}`,
    "promotion",
  );
  if (!lease) throw Error("EMPTY_CHAT_RECOVERY_APP_ACTIVE");
  try {
    return await new PrivateExecutionFence({ root }).withClosedRecoveryDrain(
      async () => {
        const run = await snapshot(running, MAX_RUN_MARKER_BYTES);
        const config = await snapshot(configuration, 256 * 1024);
        const intent = await snapshot(pending, 65536);
        const preparedRoots = {
          archive: await privateRoot(archive),
          chat: await privateRoot(path.join(profile.root, "chat")),
        };
        if (
          sum(run.bytes) !== input.expectedRunSha256 ||
          sum(config.bytes) !== input.expectedConfigSha256 ||
          sum(intent.bytes) !== failure.pendingSha256 ||
          !isDeepStrictEqual(
            JSON.parse(intent.bytes.toString("utf8")),
            expectedIntent,
          ) ||
          preparedRoots.archive.dev !== exact.current.ChatRoot.Device ||
          preparedRoots.archive.ino !== exact.current.ChatRoot.Inode
        )
          throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
        const attempt = path.join(archive, "known-completion-attempt.json");
        await absent(attempt);
        await absent(path.join(archive, "maintenance-completed.json"));
        await absent(path.join(archive, "failed-running.json"));
        await absent(path.join(archive, "maintenance-intent.json"));
        const archivePin = await retainEmptyArchive(archive);
        const proof = async () => {
          if (
            !isDeepStrictEqual(await privateRoot(profile.root), parent) ||
            !isDeepStrictEqual(
              await privateRoot(archive),
              preparedRoots.archive,
            ) ||
            !isDeepStrictEqual(
              await privateRoot(path.join(profile.root, "chat")),
              preparedRoots.chat,
            )
          )
            throw Error("EMPTY_CHAT_RECOVERY_ROOT_CHANGED");
          await unchanged(running, run);
          await unchanged(configuration, config);
          await unchanged(pending, intent);
          await archivePin.verify();
          await absent(path.join(state, "last-quit.json"));
          const desktop = await input.desktopState();
          if (
            desktop.changed.length ||
            desktop.unreadable.length ||
            !isDeepStrictEqual(desktop.obligations, ["QUIT_UNCONFIRMED:crash"])
          )
            throw Error("EMPTY_CHAT_RECOVERY_WORK_PENDING");
          input.processesAbsent();
          if (!(await verifyPromotionLease(lease)))
            throw Error("PROMOTION_LEASE_LOST");
        };
        await input.attest();
        await proof();
        const observed = await input.observePrepared();
        const child = knownEmptyRecoveryChild(
          exact,
          failure,
          observed,
          preparedRoots.chat,
        );
        await proof();
        // Permanent attempt before the first recorder effect; absence is never
        // reconstructed after a failure. An unknown recorder cannot be repeated.
        const bytes = Buffer.from(
          `${JSON.stringify({ schema: "farol.known-empty-completion-attempt/1", failure, observed })}\n`,
        );
        const f = await fs.open(
          attempt,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await f.writeFile(bytes);
          await f.sync();
        } finally {
          await f.close();
        }
        const retainedAttempt = await snapshot(attempt, 16384);
        if (!retainedAttempt.bytes.equals(bytes))
          throw Error("EMPTY_CHAT_RECOVERY_COMPLETION_UNKNOWN");
        await archivePin.include(
          "known-completion-attempt.json",
          retainedAttempt,
        );
        await sync(archive);
        await proof();
        return await finishEmptyRecoveryHost({
          input,
          child,
          exact,
          profile,
          state,
          archive,
          run,
          config,
          pending,
          intent,
          preparedRoots,
          lease,
          archivePin,
          proof: async () => {
            await proof();
            await unchanged(attempt, retainedAttempt);
          },
          knownFailure: {
            receiptSha256: failure.receiptSha256,
            completionOperationId: failure.completionOperationId,
          },
        });
      },
    );
  } finally {
    await releasePromotionLease(lease);
  }
}

// Common final handoff mechanics: one original terminal recorder, retained
// completion/failure/intent, and the pending move LAST. No prepare or ACK here.
async function finishEmptyRecoveryHost({
  input,
  child,
  exact,
  profile,
  state,
  archive,
  run,
  config,
  pending,
  intent,
  preparedRoots,
  lease,
  verifyLease,
  proof,
  knownFailure,
  archivePin,
  failedQuit,
  previousConfirmedQuit,
  reconcileConnector,
  preservedHistory,
  legacyPreparation,
}: {
  input: Pick<
    ClosedEmptyChatRecoveryInput,
    | "executable"
    | "expectedRunSha256"
    | "expectedConfigSha256"
    | "processesAbsent"
    | "attest"
  > & {
    selectionInput: Pick<
      EmptyRecoverySelectionInput,
      "Interrupted" | "InstalledPreserved" | "InstalledEmpty"
    >;
  };
  child: EmptyRecoveryChildResult;
  exact: Pick<ExactEmptyRecoverySelection, "operationId" | "buildId">;
  profile: ProfileLaunchBinding;
  state: string;
  archive: string;
  run: Snapshot;
  config: Snapshot;
  pending: string;
  intent: Snapshot;
  preparedRoots: {
    archive: { dev: number; ino: number };
    chat: { dev: number; ino: number };
  };
  lease: PromotionLeaseHandle;
  // A borrowed startup handle retains its original full verifier through the
  // final eligibility change, including installed-replacement/current-host gates.
  verifyLease?: () => Promise<boolean>;
  proof(): Promise<void>;
  knownFailure?: { receiptSha256: string; completionOperationId: string };
  archivePin?: Awaited<ReturnType<typeof retainEmptyArchive>>;
  failedQuit?: Snapshot;
  previousConfirmedQuit?: true;
  reconcileConnector?(): Promise<void>;
  preservedHistory?: Readonly<{
    scope: PreservedRecoveryBinding;
    originalACK: "unobserved";
    originalTerminal: "unobserved";
  }>;
  legacyPreparation?: StartupLegacyPreparation;
}): Promise<{
  phase: "prepared_for_cold_start";
  archive: string;
  operationId: string;
}> {
  const running = path.join(state, "running.json");
  const configuration = path.join(state, "config.json");
  await recordTerminal(
    input.executable,
    profile,
    child.terminal,
    child.acknowledgement,
  );
  await input.attest();
  await proof();
  await unchanged(pending, intent);
  const completion = path.join(archive, "maintenance-completed.json");
  const interruptedRetirement =
    failedQuit && input.selectionInput.Interrupted
      ? {
          originalHandoffId:
            input.selectionInput.Interrupted!.OriginalHandoffID,
          originalTerminal: "unobserved",
          failedQuitSha256: sum(failedQuit.bytes),
          terminalReceiptScope: "new-maintenance-child",
        }
      : undefined;
  const unacknowledgedDev =
    failedQuit && !input.selectionInput.Interrupted && !preservedHistory
      ? {
          originalRetirement: "absent",
          originalACK: "absent",
          originalTerminal: "unobserved",
          ...(previousConfirmedQuit
            ? {
                originalQuitScope: "previous-lifetime",
                previousConfirmedQuitSha256: sum(failedQuit.bytes),
              }
            : { failedQuitSha256: sum(failedQuit.bytes) }),
          terminalReceiptScope: "new-maintenance-child",
        }
      : undefined;
  const receipt = Buffer.from(
    `${JSON.stringify({ schema: preservedHistory ? "farol.closed-preserved-chat-recovery/1" : "farol.closed-empty-chat-recovery/1", operationId: exact.operationId, buildId: exact.buildId, failedRunSha256: input.expectedRunSha256, configSha256: input.expectedConfigSha256, publication: child.publication, acknowledgement: child.acknowledgement, originalChildTerminal: child.terminal, recorderConfirmed: true, ...(preservedHistory ? { preservedHistory, originalQuitScope: failedQuit ? (previousConfirmedQuit ? "previous-lifetime" : "current-unconfirmed") : "absent", retainedQuitSha256: failedQuit ? sum(failedQuit.bytes) : undefined } : {}), ...(legacyPreparation ? { selectedLegacyPreparation: { operationId: legacyPreparation.operationId, sha256: legacyPreparation.sha256, originalPhase: "prepared", legacyDisposition: "selected_for_retirement", correspondingGoOutcome: "unobserved" } } : {}), ...(knownFailure ? { knownFailure } : {}), ...(interruptedRetirement ? { interruptedRetirement } : {}), ...(unacknowledgedDev ? (input.selectionInput.InstalledPreserved ? { installedPreservedLifetime: unacknowledgedDev } : input.selectionInput.InstalledEmpty ? { installedEmptyLifetime: unacknowledgedDev } : { unacknowledgedDev }) : {}) })}\n`,
  );
  const f = await fs.open(
    completion,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await f.writeFile(receipt);
    await f.sync();
  } finally {
    await f.close();
  }
  const retained = await snapshot(completion, 16384);
  if (!retained.bytes.equals(receipt))
    throw Error("EMPTY_CHAT_RECOVERY_COMPLETION_UNKNOWN");
  await archivePin?.include("maintenance-completed.json", retained);
  await sync(archive);
  await proof();
  await unchanged(pending, intent);
  // The original failed run and Quit remain pinned until inactive MCP ownership
  // is durably reconciled under the same exclusive Desktop/Computer leases.
  await reconcileConnector?.();
  if (legacyPreparation !== undefined) {
    const retainedPreparation = await legacyPreparation.retireInto(archive);
    await archivePin?.include(
      LEGACY_PREPARATION_ARCHIVE_NAME,
      retainedPreparation,
    );
    await unchanged(pending, intent);
  }
  // Preserve original failure and intent; NEVER manufacture a clean Quit.
  const retainedRun = path.join(archive, "failed-running.json");
  const retainedIntent = path.join(archive, "maintenance-intent.json");
  await absent(retainedRun);
  await absent(retainedIntent);
  await fs.rename(running, retainedRun);
  await sync(state);
  await sync(archive);
  await unchanged(retainedRun, run);
  await archivePin?.include("failed-running.json", run);
  if (failedQuit) {
    const originalQuit = path.join(state, "last-quit.json");
    const retainedQuitName = previousConfirmedQuit
      ? "previous-last-quit.json"
      : "failed-last-quit.json";
    const retainedQuit = path.join(archive, retainedQuitName);
    await unchanged(originalQuit, failedQuit);
    await absent(retainedQuit);
    await fs.rename(originalQuit, retainedQuit);
    await sync(state);
    await sync(archive);
    await unchanged(retainedQuit, failedQuit);
    await archivePin?.include(retainedQuitName, failedQuit);
  }
  await unchanged(configuration, config);
  await unchanged(pending, intent);
  if (
    !isDeepStrictEqual(await privateRoot(archive), preparedRoots.archive) ||
    !isDeepStrictEqual(
      await privateRoot(path.join(profile.root, "chat")),
      preparedRoots.chat,
    )
  )
    throw Error("EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED");
  input.processesAbsent();
  if (!(await verifyPromotionLease(lease))) throw Error("PROMOTION_LEASE_LOST");
  await archivePin?.verify();
  if (verifyLease !== undefined && !(await verifyLease()))
    throw Error("PROMOTION_LEASE_LOST");
  // This is the final eligibility change. Any preceding unknown leaves the
  // original pending inode blocking both normal Go and Electron startup.
  try {
    await fs.rename(pending, retainedIntent);
    await sync(state);
    await sync(archive);
    await unchanged(retainedIntent, intent);
    await archivePin?.include("maintenance-intent.json", intent);
    await archivePin?.verify();
  } catch (originalError) {
    // A lost final durability/readback result must not leave an unfenced
    // normal-start path. One best-effort NEW uncertainty marker; preserve
    // both the original intent and error, never retry the transition.
    try {
      const fence = await fs.open(
        pending,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fence.writeFile(
          `${JSON.stringify({ schema: "farol.empty-recovery-unknown/1", operationId: exact.operationId, buildId: exact.buildId })}\n`,
        );
        await fence.sync();
      } finally {
        await fence.close();
      }
      await sync(state);
    } catch (fenceError) {
      if ((fenceError as NodeJS.ErrnoException).code !== "EEXIST")
        throw new AggregateError(
          [originalError, fenceError],
          "EMPTY_CHAT_RECOVERY_COMPLETION_AND_FENCE_UNKNOWN",
        );
    }
    throw originalError;
  }
  return {
    phase: "prepared_for_cold_start",
    archive,
    operationId: exact.operationId,
  };
}

// Internal trusted host mechanics shared by the two closed-maintenance owners.
// No IPC/MCP entry exposes these filesystem handles or grants recovery authority.
export const closedRecoveryHostMechanics = Object.freeze({
  snapshot,
  unchanged,
  absent,
  privateRoot,
  finish: finishEmptyRecoveryHost,
});
