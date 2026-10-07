import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  prepareEmptyRecoveryChild,
  type ExactEmptyRecoverySelection,
  type EmptyRecoverySelectionInput,
} from "../../../apps/desktop/bridge/empty-recovery-child";
import type { ProfileLaunchBinding } from "../../../apps/desktop/bridge/profile";
import { recordTerminal } from "../../../apps/desktop/bridge/terminal-recorder";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease";
import { MAX_RUN_MARKER_BYTES } from "./run-marker";
import type { ClosedRecoveryState } from "./closed-computer-recovery";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Snapshot = Readonly<{ bytes: Buffer; device: number; inode: number }>;

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
  const selected = structuredClone({
    userData: input.userData,
    profile: input.profile,
    exact: input.exact,
    selectionInput: input.selectionInput,
  });
  const { userData, profile, exact, selectionInput } = selected;
  const state = path.join(userData, "farol-next-state");
  if (
    profile.root !== path.join(state, "go-core") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(exact.operationId) ||
    ![input.expectedRunSha256, input.expectedConfigSha256].every((v) =>
      /^[a-f0-9]{64}$/u.test(v),
    )
  )
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
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
        await absent(pending);
        await absent(archive);
        await input.attest();
        await proof();
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
        const expectedIntent = {
          ...(selectionInput as object),
          Profile: {
            ProfileID: profile.profileId,
            Root: profile.root,
            Device: Number(profile.device),
            Inode: Number(profile.inode),
          },
        };
        if (
          !isDeepStrictEqual(
            JSON.parse(intent.bytes.toString("utf8")),
            expectedIntent,
          )
        )
          throw Error("EMPTY_CHAT_RECOVERY_INTENT_CHANGED");
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
        const receipt = Buffer.from(
          `${JSON.stringify({ schema: "farol.closed-empty-chat-recovery/1", operationId: exact.operationId, buildId: exact.buildId, failedRunSha256: input.expectedRunSha256, configSha256: input.expectedConfigSha256, publication: child.publication, acknowledgement: child.acknowledgement, originalChildTerminal: child.terminal, recorderConfirmed: true })}\n`,
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
        await sync(archive);
        await proof();
        await unchanged(pending, intent);
        // Preserve original failure and intent; NEVER manufacture a clean Quit.
        const retainedRun = path.join(archive, "failed-running.json");
        const retainedIntent = path.join(archive, "maintenance-intent.json");
        await absent(retainedRun);
        await absent(retainedIntent);
        await fs.rename(running, retainedRun);
        await sync(state);
        await sync(archive);
        await unchanged(retainedRun, run);
        await unchanged(configuration, config);
        await unchanged(pending, intent);
        if (
          !isDeepStrictEqual(
            await privateRoot(archive),
            preparedRoots.archive,
          ) ||
          !isDeepStrictEqual(
            await privateRoot(path.join(profile.root, "chat")),
            preparedRoots.chat,
          )
        )
          throw Error("EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED");
        input.processesAbsent();
        if (!(await verifyPromotionLease(lease)))
          throw Error("PROMOTION_LEASE_LOST");
        // This is the final eligibility change. Any preceding unknown leaves the
        // original pending inode blocking both normal Go and Electron startup.
        try {
          await fs.rename(pending, retainedIntent);
          await sync(state);
          await sync(archive);
          await unchanged(retainedIntent, intent);
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
      },
    );
  } finally {
    await releasePromotionLease(lease);
  }
}
