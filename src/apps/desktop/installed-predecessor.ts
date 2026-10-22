import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyRunMarker,
  currentBootTimeMs,
  MAX_RUN_MARKER_BYTES,
  processAlive,
  readProcessStart,
  RUN_MARKER_FILE_NAME,
  RunMarkerSchema,
} from "./run-marker";
import {
  MAX_QUIT_RECEIPT_BYTES,
  parseQuitReceipt,
  QUIT_RECEIPT_FILE_NAME,
} from "./quit-receipt";

type PhysicalIdentity = Readonly<{ device: string; inode: string }>;
export type InstalledPredecessor = Readonly<{
  pid: number;
  processStart: string;
  startedAt: string;
}>;
export type ClosedInstalledPredecessor = InstalledPredecessor &
  Readonly<{
    quitDigest: string;
    stateIdentity: PhysicalIdentity;
  }>;
export type InstalledPredecessorControl = Readonly<{
  original: InstalledPredecessor;
  // Only the application's existing graceful SIGTERM route. No escalation.
  requestQuit(): Promise<void>;
  observeClosed(): Promise<ClosedInstalledPredecessor>;
}>;

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function privateOwned(info: BigIntStats): boolean {
  return info.uid === BigInt(process.geteuid!()) && (info.mode & 0o077n) === 0n;
}

async function privateBytes(file: string, maximum: number): Promise<Buffer> {
  const fd = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !privateOwned(before) ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    ) {
      throw new Error("UPDATE_PREDECESSOR_RECORD_UNSAFE");
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const part = await fd.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    if (
      offset !== Number(before.size) ||
      !sameFile(before, await fd.stat({ bigint: true })) ||
      !sameFile(before, await fs.lstat(file, { bigint: true }))
    ) {
      throw new Error("UPDATE_PREDECESSOR_RECORD_CHANGED");
    }
    return buffer.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

/** Captures the actual installed lifetime without writing its state. */
export async function captureInstalledPredecessor(): Promise<InstalledPredecessorControl> {
  const home = os.userInfo().homedir;
  const profile = path.join(
    home,
    "Library/Application Support/io.github.legrch.farol",
  );
  const stateRoot = path.join(profile, "farol-state");
  const roots = [
    home,
    path.join(home, "Library"),
    path.join(home, "Library/Application Support"),
    profile,
    stateRoot,
  ];
  const identities = await Promise.all(
    roots.map(async (directory) => {
      const info = await fs.lstat(directory, { bigint: true });
      const privateMode = directory === profile || directory === stateRoot;
      if (
        !info.isDirectory() ||
        info.uid !== BigInt(process.geteuid!()) ||
        (info.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
        (await fs.realpath(directory)) !== directory
      ) {
        throw new Error("UPDATE_PREDECESSOR_ROOT_UNSAFE");
      }
      return { dev: info.dev, ino: info.ino };
    }),
  );
  async function verifyRoots(): Promise<void> {
    for (let i = 0; i < roots.length; i += 1) {
      const directory = roots[i]!;
      const original = identities[i]!;
      const info = await fs.lstat(directory, { bigint: true });
      const privateMode = directory === profile || directory === stateRoot;
      if (
        !info.isDirectory() ||
        info.dev !== original.dev ||
        info.ino !== original.ino ||
        info.uid !== BigInt(process.geteuid!()) ||
        (info.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
        (await fs.realpath(directory)) !== directory
      ) {
        throw new Error("UPDATE_PREDECESSOR_ROOT_CHANGED");
      }
    }
  }
  const markerPath = path.join(stateRoot, RUN_MARKER_FILE_NAME);
  const markerBytes = await privateBytes(markerPath, MAX_RUN_MARKER_BYTES);
  const marker = RunMarkerSchema.parse(
    JSON.parse(markerBytes.toString("utf8")),
  );
  function verifyLifetime(): void {
    if (
      marker.pid === process.pid ||
      classifyRunMarker(marker, {
        bootTime: currentBootTimeMs(),
        isAlive: processAlive,
        processStart: readProcessStart,
      }) !== "running" ||
      !marker.processStart
    ) {
      throw new Error("UPDATE_PREDECESSOR_LIFETIME_UNCONFIRMED");
    }
  }
  async function verifyLive(): Promise<void> {
    await verifyRoots();
    if (
      !(await privateBytes(markerPath, MAX_RUN_MARKER_BYTES)).equals(
        markerBytes,
      )
    ) {
      throw new Error("UPDATE_PREDECESSOR_LIFETIME_CHANGED");
    }
    verifyLifetime();
  }
  await verifyLive();
  const original = Object.freeze({
    pid: marker.pid,
    processStart: marker.processStart!,
    startedAt: marker.startedAt,
  });
  const state = identities.at(-1)!;
  const stateIdentity = Object.freeze({
    device: state.dev.toString(),
    inode: state.ino.toString(),
  });
  let quitAttempted = false;
  let closedDigest: string | undefined;
  let closureUnconfirmed = false;
  async function markerAbsent(): Promise<void> {
    try {
      await fs.lstat(markerPath);
      throw new Error("UPDATE_PREDECESSOR_RUN_MARKER_PRESENT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return Object.freeze({
    original,
    async requestQuit() {
      if (quitAttempted)
        throw new Error("UPDATE_PREDECESSOR_QUIT_ALREADY_ATTEMPTED");
      quitAttempted = true;
      await verifyLive();
      // The accepted predecessor installs SIGTERM only after ordinary Quit
      // handling is ready. Never force-stop or synthesize its drain receipt.
      process.kill(original.pid, "SIGTERM");
    },
    async observeClosed() {
      if (closureUnconfirmed)
        throw new Error("UPDATE_PREDECESSOR_CLOSURE_UNCONFIRMED");
      try {
        await verifyRoots();
      } catch (error) {
        closureUnconfirmed = true;
        throw error;
      }
      if (processAlive(original.pid))
        throw new Error("UPDATE_PREDECESSOR_STILL_PRESENT");
      try {
        await markerAbsent();
        const bytes = await privateBytes(
          path.join(stateRoot, QUIT_RECEIPT_FILE_NAME),
          MAX_QUIT_RECEIPT_BYTES,
        );
        const parsed = parseQuitReceipt(bytes.toString("utf8"));
        if (
          !parsed.ok ||
          !parsed.receipt.drained ||
          parsed.receipt.unconfirmed.length !== 0 ||
          Date.parse(parsed.receipt.at) <= Date.parse(original.startedAt) ||
          Date.parse(parsed.receipt.at) > Date.now()
        ) {
          throw new Error("UPDATE_PREDECESSOR_QUIT_UNCONFIRMED");
        }
        const quitDigest = createHash("sha256").update(bytes).digest("hex");
        await verifyRoots();
        await markerAbsent();
        if (processAlive(original.pid))
          throw new Error("UPDATE_PREDECESSOR_STILL_PRESENT");
        // Publish without yielding: another observation may have refused or
        // retained a different digest while the physical checks were pending.
        if (closureUnconfirmed)
          throw new Error("UPDATE_PREDECESSOR_CLOSURE_UNCONFIRMED");
        if (closedDigest !== undefined && closedDigest !== quitDigest) {
          throw new Error("UPDATE_PREDECESSOR_QUIT_CHANGED");
        }
        closedDigest = quitDigest;
        return Object.freeze({ ...original, quitDigest, stateIdentity });
      } catch (error) {
        // Once the selected PID is absent, missing/changed shutdown evidence
        // cannot later become success merely because valid-looking bytes appear.
        closureUnconfirmed = true;
        throw error;
      }
    },
  });
}
