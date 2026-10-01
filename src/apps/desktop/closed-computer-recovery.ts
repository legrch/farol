import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateWorkspaceMutationStore } from "../../modules/computer/infra/repo/private-workspace-mutation-store";
import { PrivateCodexHandoffJournal } from "../../modules/chat/infra/repo/private-codex-handoff-journal";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease";
import {
  MAX_RUN_MARKER_BYTES,
  RunMarkerSchema,
  classifyRunMarker,
  currentBootTimeMs,
  processAlive,
  readProcessStart,
  type RunMarkerProbe,
} from "./run-marker";
import { MAX_QUIT_RECEIPT_BYTES, QuitReceiptSchema } from "./quit-receipt";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Request = z.strictObject({
  operationId: z.string().uuid(),
  expectedRunSha256: Digest,
  expectedQuitSha256: Digest,
});
const Reservation = z.strictObject({
  handle: z.string().uuid(),
  fingerprint: Digest,
});
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function privateDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error("CLOSED_COMPUTER_RECOVERY_ROOT_UNSAFE");
}

async function privateBytes(
  file: string,
  maximum: number,
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await fs.open(file, FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.geteuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximum
    )
      throw new Error("CLOSED_COMPUTER_RECOVERY_FILE_UNSAFE");
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      bytesRead !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    )
      throw new Error("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sync(directory: string): Promise<void> {
  const handle = await fs.open(directory, FLAGS | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function retain(file: string, bytes: Buffer): Promise<void> {
  const previous = await privateBytes(file, 16384);
  if (previous !== null) {
    if (!previous.equals(bytes))
      throw new Error("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
    return;
  }
  const handle = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await sync(path.dirname(file));
}

/** Inspect only. Never signal a guessed/reused PID or launch a replacement client. */
export function assertClosedConnectorProcesses(connectorRoot: string): void {
  let table: string;
  try {
    table = execFileSync("/bin/ps", ["-ww", "-axo", "command="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
  } catch {
    throw new Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
  }
  if (!table.trim() || table.includes(connectorRoot))
    throw new Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
}

// Shell reservations deliberately survive forever as no-replay identities.
// Only the execution fence can prove no admitted shell/group remains. A
// scratch directory or malformed reservation still refuses reconciliation.
async function retainedShellReservations(root: string): Promise<number> {
  const directory = path.join(root, "shell-v2");
  try {
    await privateDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  const owners = await fs.readdir(directory);
  if (owners.length > 64)
    throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
  for (const owner of owners) {
    if (!/^[a-f0-9]{64}$/u.test(owner))
      throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
    const child = path.join(directory, owner);
    await privateDirectory(child);
    for (const entry of await fs.readdir(child)) {
      if (++count > 4096 || !/^shell-[a-f0-9]{64}\.json$/u.test(entry))
        throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
      const bytes = await privateBytes(path.join(child, entry), 1024);
      if (bytes === null)
        throw new Error("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
      Reservation.parse(JSON.parse(bytes.toString("utf8")));
    }
  }
  return count;
}

export type ClosedRecoveryState = Readonly<{
  obligations: readonly string[];
  unreadable: readonly string[];
  changed: readonly string[];
}>;

/** Deliberate maintenance with every NEW app closed. Keeps historical failure,
 * no-replay records and configuration in place; never writes a successful Quit.
 * The command supplies the owning promotion reader, not a reduced state schema.
 */
export async function recoverClosedComputer(
  input: Readonly<{
    userData: string;
    operationId: string;
    expectedRunSha256: string;
    expectedQuitSha256: string;
    desktopState(): Promise<ClosedRecoveryState>;
  }>,
  probes: Readonly<{
    run?: RunMarkerProbe;
    processesAbsent?: (root: string) => void;
  }> = {},
): Promise<Readonly<{ phase: "retired_unconfirmed"; archive: string }>> {
  const request = Request.parse({
    operationId: input.operationId,
    expectedRunSha256: input.expectedRunSha256,
    expectedQuitSha256: input.expectedQuitSha256,
  });
  const state = path.join(input.userData, "farol-next-state");
  const root = path.join(state, "secure-mcp-connector", "computer-authority");
  for (const directory of [input.userData, state, path.dirname(root), root])
    await privateDirectory(directory);
  const lease = await acquirePromotionLease(
    input.userData,
    `closed-recovery-${request.operationId}`,
    "promotion",
  );
  if (!lease) throw new Error("CLOSED_COMPUTER_RECOVERY_APP_ACTIVE");
  try {
    return await new PrivateExecutionFence({ root }).withUpdateDrain(
      async () => {
        const archive = path.join(
          state,
          `closed-recovery-${request.operationId}`,
        );
        try {
          await privateDirectory(archive);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const evidence = async (
          name: string,
          maximum: number,
          expected: string,
        ) => {
          const current = await privateBytes(path.join(state, name), maximum);
          const saved = await privateBytes(path.join(archive, name), maximum);
          const bytes = current ?? saved;
          if (
            !bytes ||
            digest(bytes) !== expected ||
            (saved !== null && !saved.equals(bytes))
          )
            throw new Error("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
          return bytes;
        };
        const run = await evidence(
          "running.json",
          MAX_RUN_MARKER_BYTES,
          request.expectedRunSha256,
        );
        const quit = await evidence(
          "last-quit.json",
          MAX_QUIT_RECEIPT_BYTES,
          request.expectedQuitSha256,
        );
        const failed = QuitReceiptSchema.parse(
          JSON.parse(quit.toString("utf8")),
        );
        if (
          failed.drained ||
          failed.unconfirmed.length !== 1 ||
          failed.unconfirmed[0] !== "connector"
        )
          throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
        const marker = RunMarkerSchema.parse(JSON.parse(run.toString("utf8")));
        const proof = async () => {
          if (
            classifyRunMarker(
              marker,
              probes.run ?? {
                bootTime: currentBootTimeMs(),
                isAlive: processAlive,
                processStart: readProcessStart,
              },
            ) !== "crashed"
          )
            throw new Error("CLOSED_COMPUTER_RECOVERY_APP_ACTIVE");
          const desktop = await input.desktopState();
          if (
            desktop.changed.length ||
            desktop.unreadable.length ||
            desktop.obligations.some(
              (name) =>
                name !== "QUIT_UNCONFIRMED:connector" &&
                name !== "QUIT_UNCONFIRMED:crash",
            )
          )
            throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
          if (
            !(await new PrivateWorkspaceMutationStore({
              root,
            }).settledForUpdate()) ||
            (
              await new PrivateCodexHandoffJournal(
                path.join(root, "codex-task-journal"),
              ).updateTaskKeys()
            ).length
          )
            throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
          const claude = path.join(root, "claude-task-journal");
          try {
            await privateDirectory(claude);
            if ((await fs.readdir(claude)).length)
              throw new Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await retainedShellReservations(root);
          (probes.processesAbsent ?? assertClosedConnectorProcesses)(
            path.dirname(root),
          );
          await evidence(
            "running.json",
            MAX_RUN_MARKER_BYTES,
            request.expectedRunSha256,
          );
          await evidence(
            "last-quit.json",
            MAX_QUIT_RECEIPT_BYTES,
            request.expectedQuitSha256,
          );
          if (!(await verifyPromotionLease(lease)))
            throw new Error("PROMOTION_LEASE_LOST");
        };
        await proof();
        await fs
          .mkdir(archive, { mode: 0o700 })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        await privateDirectory(archive);
        const metadata = {
          schema: "farol.closed-computer-recovery/1",
          ...request,
        };
        await retain(
          path.join(archive, "prepared.json"),
          Buffer.from(`${JSON.stringify(metadata)}\n`),
        );
        await retain(path.join(archive, "running.json"), run);
        await retain(path.join(archive, "last-quit.json"), quit);
        await new PrivateMcpLifecycle(root).reconcileInactive({
          operationId: request.operationId,
          failedQuitSha256: request.expectedQuitSha256,
          proveIdle: proof,
        });
        await proof();
        await retain(
          path.join(archive, "completed.json"),
          Buffer.from(
            `${JSON.stringify({ ...metadata, phase: "retired_unconfirmed", retainedShellReservations: await retainedShellReservations(root) })}\n`,
          ),
        );
        // Original failure bytes were durably retained before retiring either
        // current marker. Running is last: any earlier failure still blocks native
        // admission. Resume is tied to these exact bytes, never to a new attempt.
        for (const [name, bytes] of [
          ["last-quit.json", quit],
          ["running.json", run],
        ] as const) {
          const current = await privateBytes(
            path.join(state, name),
            bytes.length,
          );
          if (current !== null) {
            if (!current.equals(bytes))
              throw new Error("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
            await fs.unlink(path.join(state, name));
            await sync(state);
          }
        }
        return { phase: "retired_unconfirmed", archive };
      },
    );
  } finally {
    await releasePromotionLease(lease);
  }
}
