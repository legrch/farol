import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquirePromotionLease,
  isPromotionLeaseHeldSync,
  promotionLeasePath,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../src/apps/desktop/promotion-lease.ts";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { preserveClosedInstalledPair } from "../../tooling/supervised-update-backup.mjs";
import { observeUpdateSlot } from "../../tooling/update-slot-observer.mjs";

// Lead must grant the single native lane after the UI lane is idle. Opt-in
// prevents an ordinary aggregate run from acquiring these Darwin kernel locks.
// Run only this file with FAROL_SUPERVISED_BACKUP_NATIVE=1. Collection has no
// filesystem effects. All app/profile paths are under a disposable synthetic
// HOME; no process inspection, children, apps, packages or installed data.
// Only os.userInfo and source-slot/predecessor observations are fixtures. The
// production lease module and every filesystem operation are real and unmocked.
// This qualifies bytes/POSIX modes/literal links plus the held-inode seam, not
// shutdown, packaging, recovery, restore, ACLs, xattrs or timestamp preservation.
vi.mock("../../tooling/update-slot-observer.mjs", () => ({
  observeUpdateSlot: vi.fn(),
}));

const nativeEnabled =
  process.platform === "darwin" &&
  process.env.FAROL_SUPERVISED_BACKUP_NATIVE === "1";

async function identity(file) {
  const info = await fs.lstat(file, { bigint: true });
  return { device: info.dev, inode: info.ino };
}

// Independent readback includes roots, every entry's type/mode, file bytes and
// literal link bytes. Source identities are compared separately from copies.
// lstat/readlink never resolve profile links, even dangling or opaque ones.
async function snapshot(root) {
  const entries = [];
  const identities = [];
  async function walk(relative) {
    const file = path.join(root, relative);
    const info = await fs.lstat(file, { bigint: true });
    const kind = info.isDirectory()
      ? "directory"
      : info.isSymbolicLink()
        ? "symlink"
        : "file";
    expect(info.isDirectory() || info.isSymbolicLink() || info.isFile()).toBe(
      true,
    );
    const bytes = info.isSymbolicLink()
      ? await fs.readlink(file, { encoding: "buffer" })
      : info.isFile()
        ? await fs.readFile(file)
        : null;
    entries.push([relative, kind, Number(info.mode & 0o7777n), bytes]);
    identities.push([
      relative,
      info.dev,
      info.ino,
      info.uid,
      info.gid,
      info.nlink,
    ]);
    if (info.isDirectory())
      for (const name of (await fs.readdir(file)).sort())
        await walk(path.join(relative, name));
  }
  await walk("");
  return { entries, identities };
}

async function acquire(
  f,
  generation = "disposable-preservation",
  role = "promotion",
) {
  let handle;
  try {
    handle = await acquirePromotionLease(f.userData, generation, role);
  } catch (error) {
    f.leaseOutcomeUnknown = true;
    throw error;
  }
  if (!handle) return null;
  // Register before any assertion/readback so a failed setup still closes its
  // known handle once. Unknown acquisition/close results retain the whole root.
  const entry = {
    handle,
    probeUserData: f.userData,
    identity: null,
    releaseAttempted: false,
    closed: false,
  };
  f.leases.push(entry);
  entry.identity = await identity(handle.file);
  return entry;
}

async function release(entry) {
  if (entry.releaseAttempted) return; // Never retry an uncertain close.
  entry.releaseAttempted = true;
  await releasePromotionLease(entry.handle);
  expect(await verifyPromotionLease(entry.handle)).toBe(false);
  // releasePromotionLease hides close errors. Its return is insufficient:
  // require the same retained inode and an actual shared-lock probe before
  // deleting disposable evidence. Missing/unsafe/locked is not confirmed close.
  expect(await identity(promotionLeasePath(entry.probeUserData))).toEqual(
    entry.identity,
  );
  expect(isPromotionLeaseHeldSync(entry.probeUserData)).toBe(false);
  entry.closed = true;
}

async function withFixture(context, body) {
  if (
    !context?.signal ||
    typeof context.signal.addEventListener !== "function" ||
    typeof context.signal.removeEventListener !== "function"
  )
    throw new Error("NATIVE_BACKUP_TEST_CONTEXT_REQUIRED");
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-backup-native-"),
  );
  const f = {
    root,
    leases: [],
    retainReason: null,
    leaseOutcomeUnknown: false,
  };
  let completed = false;
  let closureUnknown = false;
  const aborted = () => {
    f.retainReason = "native-run-aborted";
    console.info(
      JSON.stringify({
        scope: "disposable-fs-real-promotion-lease",
        root,
        outcome: "unknown",
        cleanup: "retained",
        leaseClosure: "unknown",
      }),
    );
  };
  context.signal.addEventListener("abort", aborted, { once: true });
  if (context.signal.aborted) aborted();
  try {
    if (context.signal.aborted) throw new Error("NATIVE_BACKUP_RUN_ABORTED");
    f.rootIdentity = await identity(root);
    f.home = path.join(root, "home");
    f.installed = path.join(f.home, "Applications/Farol.app");
    f.userData = path.join(
      f.home,
      "Library/Application Support/Farol Next Preview",
    );
    f.destinationParent = path.join(root, "private-preservation");
    f.retiredUserData = path.join(root, "retired-lease");
    await fs.mkdir(path.join(f.installed, "Contents/Versions/A"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(f.installed, 0o755);
    await fs.mkdir(path.join(f.userData, "Browser/Profile"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(path.join(f.userData, "Browser/Profile"), 0o750);
    await fs.mkdir(f.destinationParent, { mode: 0o700 });
    await fs.writeFile(
      path.join(f.installed, "Contents/Versions/A/runtime"),
      "synthetic executable bytes; never run",
      { mode: 0o751 },
    );
    await fs.chmod(
      path.join(f.installed, "Contents/Versions/A/runtime"),
      0o751,
    );
    await fs.symlink("A", path.join(f.installed, "Contents/Versions/Current"));
    await fs.writeFile(
      path.join(f.userData, "Browser/Profile/data"),
      Buffer.from([0, 255, 1, 2, 0]),
      { mode: 0o640 },
    );
    await fs.chmod(path.join(f.userData, "Browser/Profile/data"), 0o640);
    await fs.writeFile(path.join(f.userData, "empty"), "", { mode: 0o400 });
    await fs.symlink(
      path.join(root, "absent/socket"),
      path.join(f.userData, "SingletonSocket"),
    );
    await fs.lchmod(path.join(f.userData, "SingletonSocket"), 0o700);
    await fs.symlink(
      "fixture-host-424242",
      path.join(f.userData, "SingletonLock"),
    );
    await fs.symlink(
      "Browser/Profile/data",
      path.join(f.userData, "data-link"),
    );
    await fs.symlink(
      Buffer.from([0x6e, 0xff]),
      path.join(f.userData, "opaque-link"),
    );
    f.primary = await acquire(f);
    expect(f.primary).not.toBeNull();
    f.lease = f.primary.handle;
    const state = path.dirname(f.lease.file);
    await fs.writeFile(
      path.join(state, "last-quit.json"),
      "synthetic closed proof; not a real Quit receipt",
      { mode: 0o600 },
    );
    const stateIdentity = await identity(state);
    f.source = Object.freeze({
      digest: await treeDigest(f.installed),
      version: "0.1.11-owner.beta.1",
      buildId: "b".repeat(64),
    });
    const original = Object.freeze({
      pid: process.pid + 1,
      processStart: "synthetic lifetime; no process observed",
      startedAt: "2026-10-06T00:00:00.000Z",
    });
    f.proof = Object.freeze({
      ...original,
      quitDigest: "a".repeat(64),
      stateIdentity: Object.freeze({
        device: stateIdentity.device.toString(),
        inode: stateIdentity.inode.toString(),
      }),
    });
    f.predecessor = { original, observeClosed: vi.fn(async () => f.proof) };
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: process.geteuid(),
      gid: process.getegid(),
      username: "disposable-fixture",
      homedir: f.home,
      shell: "/bin/false",
    });
    vi.mocked(observeUpdateSlot).mockReset();
    vi.mocked(observeUpdateSlot).mockImplementation(async (slot) => {
      expect(slot).toBe(f.installed);
      return { ...f.source, digest: await treeDigest(slot) };
    });
    await body(f);
    completed = true;
  } finally {
    vi.restoreAllMocks();
    closureUnknown = f.leaseOutcomeUnknown;
    for (const entry of f.leases) {
      try {
        await release(entry);
      } catch {
        closureUnknown = true;
      }
      if (!entry.closed) closureUnknown = true;
    }
    const retain = !completed || closureUnknown || f.retainReason !== null;
    let cleanup = "retained";
    if (!retain) {
      try {
        expect(await identity(root)).toEqual(f.rootIdentity);
        expect(await fs.realpath(root)).toBe(root);
        if (context.signal.aborted)
          throw new Error("NATIVE_BACKUP_RUN_ABORTED");
        await fs.rm(root, { recursive: true });
        await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
        if (context.signal.aborted)
          throw new Error("NATIVE_BACKUP_RUN_ABORTED");
        cleanup = "removed";
      } catch {
        // No second cleanup attempt after a partial or unknown removal.
        cleanup = "unconfirmed";
      }
    }
    console.info(
      JSON.stringify({
        scope: "disposable-fs-real-promotion-lease",
        root,
        leaseClosure: closureUnknown ? "unknown" : "confirmed",
        cleanup,
        reason: closureUnknown
          ? "lease-closure-unconfirmed"
          : !completed
            ? "test-incomplete"
            : f.retainReason,
      }),
    );
    context.signal.removeEventListener("abort", aborted);
    if (completed && (closureUnknown || cleanup === "unconfirmed"))
      throw new Error(`NATIVE_BACKUP_CLEANUP_UNCONFIRMED:${root}`);
  }
}

const preserve = (f) =>
  preserveClosedInstalledPair({
    destinationParent: f.destinationParent,
    predecessor: f.predecessor,
    lease: f.lease,
    expectedSource: f.source,
  });

async function savedRoot(f) {
  const names = await fs.readdir(f.destinationParent);
  expect(names).toHaveLength(1);
  return path.join(f.destinationParent, names[0]);
}

async function replaceLeaseInode(f) {
  const entry = f.primary;
  const bytes = await fs.readFile(entry.handle.file);
  const retired = promotionLeasePath(f.retiredUserData);
  await fs.mkdir(path.dirname(retired), { recursive: true, mode: 0o700 });
  // Retain the locked inode under another disposable profile's exact lease
  // path so closure can be probed there; no unlink, hardlink or second holder.
  entry.probeUserData = f.retiredUserData;
  await fs.rename(entry.handle.file, retired);
  await fs.writeFile(entry.handle.file, bytes, { flag: "wx", mode: 0o600 });
  expect(await identity(retired)).toEqual(entry.identity);
  expect(await identity(entry.handle.file)).not.toEqual(entry.identity);
  expect(await fs.readFile(entry.handle.file)).toEqual(bytes);
  expect(isPromotionLeaseHeldSync(f.retiredUserData)).toBe(true);
  expect(await verifyPromotionLease(entry.handle)).toBe(false);
}

describe.skipIf(!nativeEnabled)(
  "closed pair preservation (Darwin FS + production lease; fixture closure/slot)",
  () => {
    it("captures and verifies saved bytes, modes and literal links under the exact held inode without changing live sources", async (context) =>
      withFixture(context, async (f) => {
        expect(await verifyPromotionLease(f.lease)).toBe(true);
        expect(isPromotionLeaseHeldSync(f.userData)).toBe(true);
        const beforeApp = await snapshot(f.installed);
        const beforeProfile = await snapshot(f.userData);
        // A real second open is refused in this process by the Darwin kernel.
        expect(await acquire(f, "competing-admission", "admission")).toBeNull();
        const result = await preserve(f);
        expect(result.root).toBe(await savedRoot(f));
        expect((await fs.lstat(result.root)).mode & 0o7777).toBe(0o700);
        expect((await snapshot(result.app)).entries).toEqual(beforeApp.entries);
        expect((await snapshot(result.profile)).entries).toEqual(
          beforeProfile.entries,
        );
        const savedLease = path.join(
          result.profile,
          "farol-next-state/promotion.lease",
        );
        expect(await identity(savedLease)).not.toEqual(f.primary.identity);
        expect(await treeDigest(result.app)).toBe(f.source.digest);
        const receipt = path.join(result.root, "preservation.json");
        expect((await fs.lstat(receipt)).mode & 0o7777).toBe(0o400);
        expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual({
          schema: "farol.closed-installed-pair-preservation/1",
          source: f.source,
          predecessor: f.proof,
          profileDigest: result.profileDigest,
          appDigest: f.source.digest,
          app: "Farol.app",
          profile: "profile",
        });
        expect(await result.verify()).toBe(true);
        expect(await verifyPromotionLease(f.lease)).toBe(true);
        expect(await identity(f.lease.file)).toEqual(f.primary.identity);
        expect(await snapshot(f.installed)).toEqual(beforeApp);
        expect(await snapshot(f.userData)).toEqual(beforeProfile);
      }));

    for (const kind of ["released", "replaced-inode", "copied-handle"]) {
      it(`refuses capture before copying with a ${kind} lease`, async (context) =>
        withFixture(context, async (f) => {
          if (kind === "released") await release(f.primary);
          if (kind === "replaced-inode") await replaceLeaseInode(f);
          if (kind === "copied-handle") f.lease = { ...f.lease };
          expect(await verifyPromotionLease(f.lease)).toBe(false);
          const beforeApp = await snapshot(f.installed);
          const beforeProfile = await snapshot(f.userData);
          await expect(preserve(f)).rejects.toMatchObject({
            message: "SUPERVISED_BACKUP_LEASE_UNCONFIRMED",
          });
          expect(f.predecessor.observeClosed).not.toHaveBeenCalled();
          expect(observeUpdateSlot).not.toHaveBeenCalled();
          expect(await fs.readdir(f.destinationParent)).toEqual([]);
          expect(await snapshot(f.installed)).toEqual(beforeApp);
          expect(await snapshot(f.userData)).toEqual(beforeProfile);
        }));
    }

    for (const kind of ["released", "replaced-inode"]) {
      it(`permanently refuses saved-pair verification after a ${kind} lease`, async (context) =>
        withFixture(context, async (f) => {
          const result = await preserve(f);
          expect(await result.verify()).toBe(true);
          const saved = await snapshot(result.profile);
          if (kind === "released") await release(f.primary);
          else await replaceLeaseInode(f);
          expect(await result.verify()).toBe(false);
          if (kind === "released") {
            // A new real handle on the SAME inode cannot revive the old capability.
            const next = await acquire(f, "new-promotion");
            expect(next).not.toBeNull();
            expect(next.identity).toEqual(f.primary.identity);
            expect(await verifyPromotionLease(next.handle)).toBe(true);
            expect(await verifyPromotionLease(f.lease)).toBe(false);
          } else {
            // Deterministic fixture restoration, never a retry of capture/release.
            await fs.rename(
              f.lease.file,
              path.join(f.root, "replacement.lease"),
            );
            f.primary.probeUserData = f.userData;
            await fs.rename(
              promotionLeasePath(f.retiredUserData),
              f.lease.file,
            );
            expect(await identity(f.lease.file)).toEqual(f.primary.identity);
            expect(await verifyPromotionLease(f.lease)).toBe(true);
          }
          expect(await result.verify()).toBe(false);
          expect(await snapshot(result.profile)).toEqual(saved);
        }));
    }

    for (const kind of ["released", "replaced-inode"]) {
      it(`retains a late failed capture and never returns validity after a ${kind} lease`, async (context) =>
        withFixture(context, async (f) => {
          let observations = 0;
          f.predecessor.observeClosed.mockImplementation(async () => {
            if (++observations === 3) {
              // The fixture schedules loss after real copy/receipt I/O and before
              // initial capture verification. No production lease or FS is mocked.
              f.retainReason = "failed-capture";
              const root = await savedRoot(f);
              expect(
                JSON.parse(
                  await fs.readFile(
                    path.join(root, "preservation.json"),
                    "utf8",
                  ),
                ).source,
              ).toEqual(f.source);
              if (kind === "released") await release(f.primary);
              else await replaceLeaseInode(f);
            }
            return f.proof;
          });
          let result;
          let failure;
          try {
            result = await preserve(f); // One capture attempt; never retried.
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(Error);
          expect(failure.message).toBe("SUPERVISED_BACKUP_LEASE_UNCONFIRMED");
          expect(result).toBeUndefined(); // Receipt presence grants no verify capability.
          expect(failure.partialRoot).toBe(await savedRoot(f));
          expect(
            await treeDigest(path.join(failure.partialRoot, "Farol.app")),
          ).toBe(f.source.digest);
          expect(
            JSON.parse(
              await fs.readFile(
                path.join(failure.partialRoot, "preservation.json"),
                "utf8",
              ),
            ).source,
          ).toEqual(f.source);
          expect(await verifyPromotionLease(f.lease)).toBe(false);
          // Even these expected failures retain their partial pair for Lead review.
        }));
    }
  },
);
