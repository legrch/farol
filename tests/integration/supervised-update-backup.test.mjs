import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { observeUpdateSlot } from "../../tooling/update-slot-observer.mjs";
import {
  promotionLeasePath,
  verifyPromotionLease,
} from "../../src/apps/desktop/promotion-lease.ts";
import { preserveClosedInstalledPair } from "../../tooling/supervised-update-backup.mjs";

// Real disposable filesystem copies, with fixed installed roots redirected only
// through os.userInfo. The slot observer, lease and predecessor are mocked: no
// actual installed/profile reads, kernel leases, PID checks, children or apps.
// These cases qualify the preservation adapter, not a real package or shutdown.
vi.mock("../../tooling/update-slot-observer.mjs", () => ({
  observeUpdateSlot: vi.fn(),
}));
vi.mock("../../src/apps/desktop/promotion-lease.ts", async (original) => ({
  ...(await original()),
  verifyPromotionLease: vi.fn(),
}));

const roots = [];
beforeEach(() => {
  vi.mocked(observeUpdateSlot).mockReset();
  vi.mocked(verifyPromotionLease).mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-backup-adapter-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const installed = path.join(home, "Applications/Farol.app");
  const userData = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(userData, "farol-next-state");
  const destinationParent = path.join(root, "private-preservation");
  await fs.mkdir(path.join(installed, "Contents/Versions/A"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(installed, 0o755);
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.mkdir(destinationParent, { mode: 0o700 });
  const executable = path.join(installed, "Contents/Versions/A/runtime");
  await fs.writeFile(executable, "fixture executable bytes; never run", {
    mode: 0o751,
  });
  await fs.symlink("A", path.join(installed, "Contents/Versions/Current"));
  await fs.mkdir(path.join(userData, "Browser/Profile"), {
    recursive: true,
    mode: 0o750,
  });
  await fs.writeFile(
    path.join(userData, "Browser/Profile/data"),
    Buffer.from([0, 255, 1, 2, 0]),
    { mode: 0o640 },
  );
  await fs.writeFile(
    path.join(state, "last-quit.json"),
    "fixture evidence, not a receipt",
    { mode: 0o600 },
  );
  await fs.writeFile(
    promotionLeasePath(userData),
    "fixture lease diagnostics; not a kernel lock",
    { mode: 0o600 },
  );
  await fs.symlink(
    "/private/nonexistent-fixture-singleton/socket",
    path.join(userData, "SingletonSocket"),
  );
  await fs.symlink("fixture-host-424242", path.join(userData, "SingletonLock"));
  await fs.symlink("Browser/Profile/data", path.join(userData, "data-link"));
  const source = Object.freeze({
    digest: await treeDigest(installed),
    version: "0.1.11-owner.beta.1",
    buildId: "b".repeat(64),
  });
  const expectedSource = { ...source };
  const stateInfo = await fs.lstat(state, { bigint: true });
  const original = Object.freeze({
    pid: 424242,
    processStart: "fixture original process",
    startedAt: "2026-10-05T00:00:00.000Z",
  });
  const proof = Object.freeze({
    ...original,
    quitDigest: "a".repeat(64),
    stateIdentity: Object.freeze({
      device: stateInfo.dev.toString(),
      inode: stateInfo.ino.toString(),
    }),
  });
  const predecessor = {
    original,
    requestQuit: vi.fn(),
    observeClosed: vi.fn(async () => proof),
  };
  const lease = Object.freeze({
    file: promotionLeasePath(userData),
    record: Object.freeze({ role: "promotion" }),
  });
  const authority = { held: true };
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  vi.mocked(verifyPromotionLease).mockImplementation(
    async (value) => value === lease && authority.held,
  );
  vi.mocked(observeUpdateSlot).mockImplementation(async (slot) => {
    expect(slot).toBe(installed);
    return Object.freeze({ ...source, digest: await treeDigest(slot) });
  });
  return {
    root,
    home,
    installed,
    userData,
    state,
    destinationParent,
    expectedSource,
    source,
    executable,
    predecessor,
    proof,
    lease,
    authority,
  };
}

const preserve = (f) =>
  preserveClosedInstalledPair({
    destinationParent: f.destinationParent,
    expectedSource: f.expectedSource,
    predecessor: f.predecessor,
    lease: f.lease,
  });
async function backupRoot(f) {
  const names = await fs.readdir(f.destinationParent);
  expect(names).toHaveLength(1);
  return path.join(f.destinationParent, names[0]);
}
async function mode(file) {
  return (await fs.lstat(file)).mode & 0o7777;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("closed installed pair preservation (disposable FS, mocked authority)", () => {
  it("preserves the fixed app/profile pair privately without changing source bytes, modes or links", async () => {
    const f = await fixture();
    const result = await preserve(f);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(result.source).toEqual(f.source);
    expect(result.root).toBe(await backupRoot(f));
    expect(result.app).toBe(path.join(result.root, "Farol.app"));
    expect(result.profile).toBe(path.join(result.root, "profile"));
    expect(await mode(result.root)).toBe(0o700);
    expect(await treeDigest(result.app)).toBe(f.source.digest);
    expect(await treeDigest(f.installed)).toBe(f.source.digest);
    expect(result.profileDigest).toMatch(/^[a-f0-9]{64}$/u);
    for (const relative of [
      "Browser",
      "Browser/Profile",
      "Browser/Profile/data",
      "farol-next-state/last-quit.json",
      "farol-next-state/promotion.lease",
    ]) {
      expect(await mode(path.join(result.profile, relative))).toBe(
        await mode(path.join(f.userData, relative)),
      );
    }
    expect(
      await fs.readFile(path.join(result.profile, "Browser/Profile/data")),
    ).toEqual(Buffer.from([0, 255, 1, 2, 0]));
    for (const relative of ["SingletonSocket", "SingletonLock", "data-link"]) {
      expect(
        await fs.readlink(path.join(result.profile, relative), {
          encoding: "buffer",
        }),
      ).toEqual(
        await fs.readlink(path.join(f.userData, relative), {
          encoding: "buffer",
        }),
      );
      expect(await mode(path.join(result.profile, relative))).toBe(
        await mode(path.join(f.userData, relative)),
      );
    }
    expect(await fs.readdir(result.root)).toEqual(["Farol.app", "profile"]);
    expect(f.predecessor.requestQuit).not.toHaveBeenCalled();
    expect(f.predecessor.observeClosed).toHaveBeenCalledTimes(4);
    f.expectedSource.digest = "0".repeat(64);
    expect(await result.verify()).toBe(true);
    expect(verifyPromotionLease).toHaveBeenCalledWith(f.lease);
  });

  it("streams a multi-chunk file, empty file and exact unusual POSIX modes", async () => {
    const f = await fixture();
    const data = Buffer.alloc(2 * 1024 * 1024 + 13, 173);
    await fs.writeFile(path.join(f.userData, "large"), data, { mode: 0o604 });
    await fs.writeFile(path.join(f.userData, "empty"), "", { mode: 0o400 });
    await fs.mkdir(path.join(f.userData, "empty-directory"), { mode: 0o711 });
    const result = await preserve(f);
    expect(await fs.readFile(path.join(result.profile, "large"))).toEqual(data);
    expect(await mode(path.join(result.profile, "large"))).toBe(0o604);
    expect(await mode(path.join(result.profile, "empty"))).toBe(0o400);
    expect(await mode(path.join(result.profile, "empty-directory"))).toBe(
      0o711,
    );
    expect(await result.verify()).toBe(true);
  });

  it("preserves literal non-UTF8 symlink bytes without opening the destination", async () => {
    const f = await fixture();
    const link = Buffer.from([0x2f, 0x78, 0xff]);
    await fs.symlink(link, path.join(f.userData, "opaque-link"));
    const result = await preserve(f);
    expect(
      await fs.readlink(path.join(result.profile, "opaque-link"), {
        encoding: "buffer",
      }),
    ).toEqual(link);
  });

  it("preserves a non-default symlink mode without following a dangling link", async () => {
    const f = await fixture();
    await fs.lchmod(path.join(f.userData, "SingletonSocket"), 0o700);
    const result = await preserve(f);
    expect(await mode(path.join(result.profile, "SingletonSocket"))).toBe(
      0o700,
    );
    expect(
      await fs.readlink(path.join(result.profile, "SingletonSocket")),
    ).toBe("/private/nonexistent-fixture-singleton/socket");
    expect(await result.verify()).toBe(true);
  });

  it("creates a separate pair without replacing or deleting an earlier snapshot", async () => {
    const f = await fixture();
    const first = await preserve(f);
    const second = await preserve(f);
    expect(second.root).not.toBe(first.root);
    expect(second.profileDigest).toBe(first.profileDigest);
    expect(await fs.readdir(f.destinationParent)).toHaveLength(2);
    expect(await first.verify()).toBe(true);
  });

  it.each(["bytes", "mode", "literal-link"])(
    "binds profileDigest to preserved %s",
    async (kind) => {
      const f = await fixture();
      const first = await preserve(f);
      const file = path.join(f.userData, "Browser/Profile/data");
      if (kind === "bytes") await fs.appendFile(file, "changed");
      if (kind === "mode") await fs.chmod(file, 0o600);
      if (kind === "literal-link") {
        await fs.unlink(path.join(f.userData, "SingletonLock"));
        await fs.symlink(
          "different-dangling-target",
          path.join(f.userData, "SingletonLock"),
        );
      }
      const second = await preserve(f);
      expect(second.profileDigest).not.toBe(first.profileDigest);
      // Later live-profile writes do not rewrite or invalidate the saved pair.
      expect(await first.verify()).toBe(true);
    },
  );

  it("verifies the immutable pair after legitimate live updater staging and intent writes", async () => {
    const f = await fixture();
    const result = await preserve(f);
    expect(await result.verify()).toBe(true);
    const observedSlots = vi.mocked(observeUpdateSlot).mock.calls.length;
    const updates = path.join(f.state, "installed-updates");
    await fs.mkdir(path.join(updates, "staging/candidate"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(updates, "staging/candidate/app.zip"),
      "fixture staged bytes",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(updates, "operation.json"),
      "fixture prepareLocal intent",
      { mode: 0o600 },
    );
    expect(await result.verify()).toBe(true);
    expect(observeUpdateSlot).toHaveBeenCalledTimes(observedSlots);
    await expect(
      fs.lstat(path.join(result.profile, "farol-next-state/installed-updates")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await fs.readFile(
        path.join(result.profile, "farol-next-state/last-quit.json"),
        "utf8",
      ),
    ).toBe("fixture evidence, not a receipt");
    f.authority.held = false;
    expect(await result.verify()).toBe(false);
  });

  it.each(["controller-pid", "missing-start", "invalid-time"])(
    "requires a real-shaped original lifetime: %s",
    async (kind) => {
      const f = await fixture();
      f.predecessor.original = {
        ...f.predecessor.original,
        ...(kind === "controller-pid"
          ? { pid: process.pid }
          : kind === "missing-start"
            ? { processStart: "" }
            : { startedAt: "not-a-date" }),
      };
      await expect(preserve(f)).rejects.toThrow("PREDECESSOR_INVALID");
      expect(f.predecessor.observeClosed).not.toHaveBeenCalled();
      expect(await fs.readdir(f.destinationParent)).toEqual([]);
    },
  );

  it.each(["released", "unknown"])(
    "refuses a final lease probe that is %s and retains the copied pair",
    async (kind) => {
      const f = await fixture();
      let calls = 0;
      vi.mocked(verifyPromotionLease).mockImplementation(async (value) => {
        if (++calls === 9) {
          if (kind === "unknown") throw new Error("private fixture details");
          return false;
        }
        return value === f.lease;
      });
      let failure;
      try {
        await preserve(f);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe(
        kind === "unknown"
          ? "SUPERVISED_BACKUP_UNCONFIRMED"
          : "SUPERVISED_BACKUP_LEASE_UNCONFIRMED",
      );
      expect(failure.partialRoot).toBe(await backupRoot(f));
      expect(
        await treeDigest(path.join(failure.partialRoot, "Farol.app")),
      ).toBe(f.source.digest);
    },
  );

  it.each([
    "relative",
    "dot-segment",
    "trailing-slash",
    "symlink",
    "public",
    "shared",
    "inside-profile",
    "inside-app",
  ])("refuses a %s destination before snapshot writes", async (kind) => {
    const f = await fixture();
    const originalParent = f.destinationParent;
    if (kind === "relative") f.destinationParent = "relative";
    if (kind === "dot-segment") f.destinationParent += "/.";
    if (kind === "trailing-slash") f.destinationParent += "/";
    if (kind === "symlink") {
      f.destinationParent = path.join(f.root, "alias");
      await fs.symlink(originalParent, f.destinationParent);
    }
    if (kind === "public") await fs.chmod(f.destinationParent, 0o755);
    if (kind === "shared") await fs.chmod(f.destinationParent, 0o777);
    if (kind === "inside-profile") f.destinationParent = f.userData;
    if (kind === "inside-app")
      f.destinationParent = path.join(f.installed, "Contents");
    await expect(preserve(f)).rejects.toThrow(/SUPERVISED_BACKUP_/u);
    expect(await fs.readdir(originalParent)).toEqual([]);
  });

  it.each([
    "profile-root",
    "app-root",
    "home-parent",
    "hardlinked-profile-file",
    "hardlinked-app-file",
    "public-profile",
    "shared-app",
  ])("refuses unsafe %s", async (kind) => {
    const f = await fixture();
    if (
      kind === "profile-root" ||
      kind === "app-root" ||
      kind === "home-parent"
    ) {
      const target =
        kind === "profile-root"
          ? f.userData
          : kind === "app-root"
            ? f.installed
            : path.join(f.home, "Library");
      await fs.rename(target, target + ".saved");
      await fs.symlink(target + ".saved", target);
    }
    if (kind === "hardlinked-profile-file")
      await fs.link(
        path.join(f.userData, "Browser/Profile/data"),
        path.join(f.root, "linked"),
      );
    if (kind === "hardlinked-app-file")
      await fs.link(f.executable, path.join(f.root, "linked"));
    if (kind === "public-profile") await fs.chmod(f.userData, 0o755);
    if (kind === "shared-app") await fs.chmod(f.installed, 0o777);
    await expect(preserve(f)).rejects.toThrow(/SUPERVISED_BACKUP_/u);
    expect(await fs.readdir(f.destinationParent)).toEqual([]);
  });

  it.each(["digest", "version", "buildId", "extra"])(
    "refuses malformed expected %s before slot observation",
    async (key) => {
      const f = await fixture();
      f.expectedSource[key] = "invalid";
      await expect(preserve(f)).rejects.toThrow("SOURCE_INVALID");
      expect(observeUpdateSlot).not.toHaveBeenCalled();
    },
  );

  it.each(["digest", "version", "buildId", "throws"])(
    "requires existing slot verification for %s",
    async (key) => {
      const f = await fixture();
      vi.mocked(observeUpdateSlot).mockImplementationOnce(async () => {
        if (key === "throws")
          throw new Error("private fixture details must not escape");
        return {
          ...f.source,
          [key]: key === "version" ? "0.1.10-owner.beta.1" : "0".repeat(64),
        };
      });
      await expect(preserve(f)).rejects.toThrow(
        key === "throws" ? "SUPERVISED_BACKUP_UNCONFIRMED" : "SOURCE_MISMATCH",
      );
      expect(await fs.readdir(f.destinationParent)).toEqual([]);
    },
  );

  it.each([
    "released",
    "copied-handle",
    "admission-role",
    "wrong-profile",
    "unknown",
  ])("requires the exact held promotion lease: %s", async (kind) => {
    const f = await fixture();
    if (kind === "released") f.authority.held = false;
    if (kind === "copied-handle") f.lease = { ...f.lease };
    if (kind === "admission-role")
      f.lease = { ...f.lease, record: { role: "admission" } };
    if (kind === "wrong-profile")
      f.lease = { ...f.lease, file: path.join(f.root, "promotion.lease") };
    if (kind === "unknown")
      vi.mocked(verifyPromotionLease).mockRejectedValue(new Error("unknown"));
    await expect(preserve(f)).rejects.toThrow(/SUPERVISED_BACKUP_/u);
    expect(f.predecessor.observeClosed).not.toHaveBeenCalled();
    expect(await fs.readdir(f.destinationParent)).toEqual([]);
  });

  it.each([
    "pid",
    "processStart",
    "startedAt",
    "quitDigest",
    "stateIdentity",
    "extra",
    "still-running",
  ])("refuses invalid closed proof %s", async (field) => {
    const f = await fixture();
    const changes = {
      pid: 42,
      processStart: "other lifetime",
      startedAt: "2026-10-04T00:00:00.000Z",
      quitDigest: "bad",
      stateIdentity: { device: "0", inode: "1" },
      extra: true,
    };
    f.predecessor.observeClosed.mockImplementation(async () => {
      if (field === "still-running")
        throw new Error("UPDATE_PREDECESSOR_STILL_PRESENT");
      return { ...f.proof, [field]: changes[field] };
    });
    await expect(preserve(f)).rejects.toThrow(/SUPERVISED_BACKUP_/u);
    expect(await fs.readdir(f.destinationParent)).toEqual([]);
  });

  it("refuses oversized sparse files before reading or making a snapshot", async () => {
    const f = await fixture();
    const file = await fs.open(path.join(f.userData, "oversized"), "wx", 0o600);
    try {
      await file.truncate(512 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    await expect(preserve(f)).rejects.toThrow("FILE_LIMIT");
    expect(observeUpdateSlot).not.toHaveBeenCalled();
    expect(await fs.readdir(f.destinationParent)).toEqual([]);
  });

  it("refuses the combined byte limit using metadata-only sparse fixtures", async () => {
    const f = await fixture();
    for (let index = 0; index < 33; index += 1) {
      const file = await fs.open(
        path.join(f.userData, `sparse-${index}`),
        "wx",
        0o600,
      );
      try {
        await file.truncate(512 * 1024 * 1024);
      } finally {
        await file.close();
      }
    }
    await expect(preserve(f)).rejects.toThrow("TOTAL_LIMIT");
    expect(observeUpdateSlot).not.toHaveBeenCalled();
    expect(await fs.readdir(f.destinationParent)).toEqual([]);
  });

  it.each([
    "closure-rejected",
    "quit-changed",
    "state-changed",
    "lease-released",
    "source-file",
    "source-link",
    "backup-file",
    "parent-replaced",
  ])(
    "retains partial snapshots on post-copy %s without returning validity",
    async (kind) => {
      const f = await fixture();
      let calls = 0;
      f.predecessor.observeClosed.mockImplementation(async () => {
        calls += 1;
        if (calls !== 3) return f.proof;
        if (kind === "closure-rejected") throw new Error("unconfirmed closure");
        if (kind === "quit-changed")
          return { ...f.proof, quitDigest: "c".repeat(64) };
        if (kind === "state-changed")
          return {
            ...f.proof,
            stateIdentity: { ...f.proof.stateIdentity, inode: "1" },
          };
        if (kind === "lease-released") f.authority.held = false;
        if (kind === "source-file")
          await fs.writeFile(
            path.join(f.userData, "Browser/Profile/data"),
            "changed",
          );
        if (kind === "source-link") {
          await fs.unlink(path.join(f.userData, "SingletonLock"));
          await fs.symlink("other", path.join(f.userData, "SingletonLock"));
        }
        if (kind === "backup-file")
          await fs.writeFile(
            path.join(await backupRoot(f), "profile/Browser/Profile/data"),
            "changed",
          );
        if (kind === "parent-replaced") {
          await fs.rename(
            f.destinationParent,
            f.destinationParent + ".retained",
          );
          await fs.mkdir(f.destinationParent, { mode: 0o700 });
        }
        return f.proof;
      });
      let failure;
      try {
        await preserve(f);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/^SUPERVISED_BACKUP_[A-Z_]+$/u);
      expect(failure.partialRoot).toMatch(/farol-closed-pair-/u);
      const retained =
        kind === "parent-replaced"
          ? failure.partialRoot.replace(
              f.destinationParent,
              f.destinationParent + ".retained",
            )
          : failure.partialRoot;
      expect((await fs.lstat(retained)).isDirectory()).toBe(true);
      expect(await mode(retained)).toBe(0o700);
      expect(
        await fs.readFile(
          path.join(retained, "Farol.app/Contents/Versions/A/runtime"),
          "utf8",
        ),
      ).toBe("fixture executable bytes; never run");
    },
  );

  it.each(["profile-content", "app-root", "backup-content", "backup-root"])(
    "rechecks %s after the final supplied closure callback",
    async (kind) => {
      const f = await fixture();
      let calls = 0;
      f.predecessor.observeClosed.mockImplementation(async () => {
        if (++calls === 4) {
          if (kind === "profile-content")
            await fs.appendFile(
              path.join(f.userData, "Browser/Profile/data"),
              "late",
            );
          if (kind === "app-root") {
            await fs.rename(f.installed, f.installed + ".retained");
            await fs.cp(f.installed + ".retained", f.installed, {
              recursive: true,
              verbatimSymlinks: true,
            });
          }
          if (kind === "backup-content")
            await fs.appendFile(
              path.join(await backupRoot(f), "profile/Browser/Profile/data"),
              "late",
            );
          if (kind === "backup-root") {
            const selected = await backupRoot(f);
            await fs.rename(selected, selected + ".retained");
            await fs.mkdir(selected, { mode: 0o700 });
          }
        }
        return f.proof;
      });
      await expect(preserve(f)).rejects.toThrow(/SUPERVISED_BACKUP_/u);
    },
  );

  it.each([
    "backup-bytes",
    "backup-mode",
    "backup-link",
    "same-bytes-new-inode",
    "backup-root",
    "source-root",
    "lease",
    "quit",
    "state-root",
    "parent-mode",
  ])("sticks to refusal after %s changes", async (kind) => {
    const f = await fixture();
    const result = await preserve(f);
    const file = path.join(result.profile, "Browser/Profile/data");
    if (kind === "backup-bytes") await fs.appendFile(file, "changed");
    if (kind === "backup-mode") await fs.chmod(file, 0o600);
    if (kind === "backup-link") {
      await fs.unlink(path.join(result.profile, "SingletonLock"));
      await fs.symlink("changed", path.join(result.profile, "SingletonLock"));
    }
    if (kind === "same-bytes-new-inode") {
      await fs.rename(file, file + ".retained");
      await fs.writeFile(file, Buffer.from([0, 255, 1, 2, 0]), { mode: 0o640 });
    }
    if (kind === "backup-root") {
      await fs.rename(result.root, result.root + ".retained");
      await fs.mkdir(result.root, { mode: 0o700 });
    }
    if (kind === "source-root") {
      await fs.rename(f.userData, f.userData + ".retained");
      await fs.cp(f.userData + ".retained", f.userData, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    if (kind === "lease") f.authority.held = false;
    if (kind === "quit")
      f.predecessor.observeClosed.mockResolvedValue({
        ...f.proof,
        quitDigest: "d".repeat(64),
      });
    if (kind === "state-root") {
      await fs.rename(f.state, f.state + ".retained");
      await fs.mkdir(f.state, { mode: 0o700 });
    }
    if (kind === "parent-mode") await fs.chmod(f.destinationParent, 0o755);
    expect(await result.verify()).toBe(false);
    const checks = vi.mocked(verifyPromotionLease).mock.calls.length;
    f.authority.held = true;
    f.predecessor.observeClosed.mockResolvedValue(f.proof);
    if (kind === "backup-mode") await fs.chmod(file, 0o640);
    if (kind === "parent-mode") await fs.chmod(f.destinationParent, 0o700);
    expect(await result.verify()).toBe(false);
    expect(verifyPromotionLease).toHaveBeenCalledTimes(checks);
  });

  it("shares concurrent verification and permanently refuses an unknown authority observation", async () => {
    const f = await fixture();
    const result = await preserve(f);
    const entered = deferred();
    const release = deferred();
    f.predecessor.observeClosed.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("lost closure observation");
    });
    const first = result.verify();
    await entered.promise;
    const second = result.verify();
    try {
      expect(second).toBe(first);
    } finally {
      release.resolve();
    }
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await result.verify()).toBe(false);
  });
});
