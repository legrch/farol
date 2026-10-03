import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  parsePreviewRetirementOptions,
  runPreviewRetirementCli,
} from "../../tooling/retire-preview-install.mjs";

// Disposable native descriptors/locks and tiny identity bundles only. No live
// profile, provider, installation, signed package or updater acceptance.
const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const op = "f".repeat(32);
const suite = process.platform === "darwin" ? describe : describe.skip;
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function write(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode },
  );
}
async function bundle(directory, n) {
  const identity = createBuildIdentity({
    version: `0.1.${n}-owner.beta.1`,
    buildVersion: String(n),
    updateChannel: "github-owner-beta",
    builtAt: "2026-09-30T12:00:00.000Z",
    sourceCommit: String(n).repeat(40),
    sourceTreeDigest: String(n).repeat(64),
    sourceDirty: false,
  });
  await write(
    path.join(directory, "Contents/Resources/app/build-identity.json"),
    identity,
    0o644,
  );
  await write(
    path.join(directory, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.farol.next.preview</string><key>CFBundleShortVersionString</key><string>0.1.${n}</string><key>CFBundleVersion</key><string>${n}</string></dict></plist>`,
    0o644,
  );
  await fs.chmod(directory, 0o755);
  return {
    digest: await treeDigest(directory),
    version: identity.version,
    buildId: identity.buildId,
    identity,
  };
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-preview-retirement-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const applications = path.join(home, "Applications");
  const userData = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(userData, "farol-next-state");
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const preview = path.join(applications, "Farol Next Preview.app");
  const old = await bundle(preview, 3);
  const repairId = "a".repeat(32);
  const previous = path.join(
    applications,
    `.farol-repair-${repairId}/previous.app`,
  );
  const initial = await bundle(previous, 1);
  const quarantine = path.join(
    userData,
    `installed-updates-quarantine-${repairId}`,
  );
  await fs.mkdir(quarantine, { mode: 0o700 });
  const shape = ({ identity: _, ...build }) => build;
  const receipt = {
    schema: "farol.next.closed-repair/1",
    operationId: repairId,
    phase: "installed",
    destination: preview,
    userData,
    source: shape(initial),
    target: shape(old),
    sourceCommit: old.identity.sourceCommit,
    sourceTreeDigest: old.identity.sourceTreeDigest,
    sourceDirty: false,
    previous,
    quarantine,
    quarantined: true,
    quitDigest: "b".repeat(64),
  };
  const inode = async (p) => {
    const s = await fs.lstat(p);
    return [s.dev, s.ino];
  };
  const journal = {
    schema: "farol.next.closed-repair-journal/1",
    phase: "installed",
    receipt,
    sourceInode: await inode(previous),
    targetInode: await inode(preview),
    updatesInode: await inode(quarantine),
  };
  const normal = {
    schema: "farol.next.promotion-plan/1",
    operation: "applied",
    product: "Farol Next Preview",
    version: initial.version,
    sourceCommit: initial.identity.sourceCommit,
    sourceTreeDigest: initial.identity.sourceTreeDigest,
    sourceDirty: false,
    artifactSha256: initial.digest,
    source: path.join(root, "initial.app"),
    destination: preview,
    receipt: preview + ".receipt.json",
    overwrite: false,
    legacyMutation: false,
    activation: { userData, drained: true, obligations: [] },
    verifiedDestinationSha256: initial.digest,
  };
  await write(preview + ".receipt.json", normal);
  await write(preview + ".repair.json", receipt);
  const journalFile = path.join(applications, ".farol-closed-repair.json");
  await write(journalFile, journal);
  const updates = path.join(userData, "installed-updates");
  const downloadId = "c".repeat(32);
  const archive = path.join(
    updates,
    `download-${downloadId}/github-updates/11111111-1111-4111-8111-111111111111.zip`,
  );
  await write(archive, "unconfirmed old download; never install or read");
  const ready = {
    schema: "farol.ready-update/1",
    handle: archive,
    manifest: { fixture: "not consumed" },
    operation: null,
    downloadId,
  };
  await write(path.join(updates, "ready.json"), ready);
  await write(path.join(state, "config.json"), "retained settings\n");
  await write(path.join(state, "last-quit.json"), {
    schema: 1,
    at: "2026-10-01T12:00:00.000Z",
    drained: true,
    unconfirmed: [],
  });
  await write(path.join(userData, "Cookies"), "do not copy fixture\n");
  const candidateRoot = path.join(root, "candidate");
  const artifact = {
    schema: 6,
    product: "Farol Next Preview",
    version: "0.1.7-owner.beta.1",
    buildId: "d".repeat(64),
    artifactPath: path.join(candidateRoot, "_output/package/Farol.app"),
    artifactSha256: "e".repeat(64),
    sourceCommit: "d".repeat(40),
    sourceTreeDigest: "e".repeat(64),
    sourceDirty: false,
  };
  await write(
    path.join(candidateRoot, "_output/package/artifact.json"),
    artifact,
  );
  const args = ["--apply", "--operation", op, "--expected-preview", old.digest];
  async function cli(extra = {}, arguments_ = args) {
    let stdout = "";
    let stderr = "";
    const status = await runPreviewRetirementCli(arguments_, {
      home,
      candidateRoot,
      sourceIdentity: () => ({
        dirty: false,
        commit: artifact.sourceCommit,
        treeDigest: artifact.sourceTreeDigest,
      }),
      verify: () => {},
      activation: async () => ({
        drained: true,
        obligations: [],
        unreadable: [],
        changed: [],
      }),
      runtime: { execArgv: [] },
      stdout: {
        write(s) {
          stdout += s;
        },
      },
      stderr: {
        write(s) {
          stderr += s;
        },
      },
      ...extra,
    });
    return { status, stderr, receipt: stdout ? JSON.parse(stdout) : null };
  }
  return {
    root,
    home,
    applications,
    userData,
    state,
    preview,
    old,
    previous,
    journalFile,
    journal,
    receipt,
    updates,
    archive,
    ready,
    args,
    cli,
    history: path.join(applications, `.farol-preview-retirement-${op}`),
    retiredUpdates: path.join(userData, `installed-updates-retired-${op}`),
  };
}

suite("explicit preview installation retirement", () => {
  it("retains and restores an empty inactive updates directory without inventing a download", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.updates, "ready.json"));
    await fs.rm(path.join(f.updates, `download-${f.ready.downloadId}`), {
      recursive: true,
    });
    const original = await fs.lstat(f.updates);
    const retired = await f.cli();
    expect(retired.status, retired.stderr).toBe(0);
    expect((await fs.lstat(f.retiredUpdates)).ino).toBe(original.ino);
    expect(await fs.readdir(f.retiredUpdates)).toEqual([]);
    expect(await fs.readFile(path.join(f.state, "config.json"), "utf8")).toBe(
      "retained settings\n",
    );
    const restored = await f.cli({}, [
      "--restore",
      op,
      "--expected-preview",
      f.old.digest,
    ]);
    expect(restored.status, restored.stderr).toBe(0);
    expect((await fs.lstat(f.updates)).ino).toBe(original.ino);
    expect(await fs.readdir(f.updates)).toEqual([]);
    expect(await treeDigest(f.preview)).toBe(f.old.digest);
  });
  it("refuses unknown update content when no ready record exists", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.updates, "ready.json"));
    await fs.rm(path.join(f.updates, `download-${f.ready.downloadId}`), {
      recursive: true,
    });
    await write(path.join(f.updates, "restore-pending.json"), "unknown");
    const updates = await fs.lstat(f.updates);
    const preview = await fs.lstat(f.preview);
    expect((await f.cli()).status).not.toBe(0);
    expect((await fs.lstat(f.updates)).ino).toBe(updates.ino);
    expect((await fs.lstat(f.preview)).ino).toBe(preview.ino);
    expect(
      await fs.readFile(path.join(f.updates, "restore-pending.json"), "utf8"),
    ).toBe("unknown");
  });
  it.each([
    ["--apply"],
    [
      "--apply",
      "--operation",
      op,
      "--expected-preview",
      "0".repeat(64),
      "--home",
      "/tmp",
    ],
    [
      "--apply",
      "--operation",
      op,
      "--expected-preview",
      "0".repeat(64),
      "--force",
    ],
    [
      "--apply",
      "--operation",
      op,
      "--operation",
      op,
      "--expected-preview",
      "0".repeat(64),
    ],
    ["--restore", op, "--apply", "--expected-preview", "0".repeat(64)],
  ])(
    "rejects unsupported options %j before any native operation",
    (...args) => {
      expect(() => parsePreviewRetirementOptions(args)).toThrow();
    },
  );
  it("preserves old repair and unconfirmed download bytes/inodes, leaves settings in place and restores the exact old pair", async () => {
    const f = await fixture();
    const bytes = await fs.readFile(f.journalFile);
    const original = await fs.lstat(f.updates);
    const cookie = await fs.lstat(path.join(f.userData, "Cookies"));
    const retired = await f.cli();
    expect(retired.status, retired.stderr).toBe(0);
    expect(
      await fs.readFile(path.join(f.history, ".farol-closed-repair.json")),
    ).toEqual(bytes);
    expect(
      await treeDigest(path.join(f.history, "Farol Next Preview.app")),
    ).toBe(f.old.digest);
    expect((await fs.lstat(f.retiredUpdates)).ino).toBe(original.ino);
    expect(
      await fs.readFile(
        path.join(f.retiredUpdates, path.relative(f.updates, f.archive)),
        "utf8",
      ),
    ).toBe("unconfirmed old download; never install or read");
    expect((await fs.lstat(path.join(f.userData, "Cookies"))).ino).toBe(
      cookie.ino,
    );
    expect(await fs.readFile(path.join(f.state, "config.json"), "utf8")).toBe(
      "retained settings\n",
    );
    expect(
      (await f.cli({}, ["--restore", op, "--expected-preview", f.old.digest]))
        .status,
    ).toBe(0);
    expect(await treeDigest(f.preview)).toBe(f.old.digest);
    expect(await fs.readFile(f.journalFile)).toEqual(bytes);
    expect((await fs.lstat(f.updates)).ino).toBe(original.ino);
  });
  it.each([
    "new slot",
    "running",
    "pending update",
    "pending repair",
    "active MCP",
    "obligation",
    "dirty source",
    "package refusal",
    "wrong predecessor",
    "symlink profile",
    "no quit proof",
    "helper intent",
    "mutation journal",
  ])("refuses %s without changing the old installation", async (kind) => {
    const f = await fixture();
    const extra = {};
    let args = f.args;
    if (kind === "new slot")
      await fs.mkdir(path.join(f.applications, "Farol.app"));
    if (kind === "running")
      await write(path.join(f.state, "running.json"), "blocked");
    if (kind === "pending update")
      await write(path.join(f.updates, "restore-pending.json"), "blocked");
    if (kind === "pending repair") {
      f.journal.phase = "swap_intent";
      await write(f.journalFile, f.journal);
    }
    if (kind === "active MCP")
      await write(
        path.join(
          f.state,
          "secure-mcp-connector/computer-authority/mcp-lifecycle/active-11111111-1111-4111-8111-111111111111",
        ),
        "active",
      );
    if (kind === "no quit proof")
      await fs.unlink(path.join(f.state, "last-quit.json"));
    if (kind === "helper intent") {
      f.ready.helper = { pid: process.pid };
      await write(path.join(f.updates, "ready.json"), f.ready);
    }
    if (kind === "mutation journal")
      await write(
        path.join(
          f.state,
          "secure-mcp-connector/computer-authority/mutations/unknown.json",
        ),
        "unknown",
      );
    if (kind === "obligation")
      extra.activation = async () => ({
        drained: false,
        obligations: ["running"],
        unreadable: [],
        changed: [],
      });
    if (kind === "dirty source") extra.sourceIdentity = () => ({ dirty: true });
    if (kind === "package refusal")
      extra.verify = () => {
        throw new Error("PACKAGE_REFUSED");
      };
    if (kind === "wrong predecessor")
      args = [...f.args.slice(0, -1), "0".repeat(64)];
    if (kind === "symlink profile") {
      await fs.rename(f.userData, f.userData + ".pinned");
      await fs.symlink(f.userData + ".pinned", f.userData);
    }
    const original = hash(await fs.readFile(f.journalFile));
    const result = await f.cli(extra, args);
    expect(result.status, result.stderr).toBe(1);
    expect(hash(await fs.readFile(f.journalFile))).toBe(original);
    expect(await treeDigest(f.preview)).toBe(f.old.digest);
  });
  it("requires the exact retained failed Quit for an explicit closed recovery, without turning it into a successful Quit", async () => {
    const f = await fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const history = path.join(f.state, "closed-recovery-" + id);
    const quit = JSON.stringify({
      schema: 1,
      at: "2026-10-01T12:00:00.000Z",
      drained: false,
      unconfirmed: ["connector"],
    });
    const marker = "retained owning run marker fixture";
    await write(path.join(history, "running.json"), marker);
    await write(path.join(history, "last-quit.json"), quit);
    await write(path.join(history, "completed.json"), {
      schema: "farol.closed-computer-recovery/1",
      operationId: id,
      expectedRunSha256: hash(marker),
      expectedQuitSha256: hash(quit),
      phase: "retired_unconfirmed",
      retainedShellReservations: 1,
    });
    await fs.unlink(path.join(f.state, "last-quit.json"));
    const result = await f.cli({}, [...f.args, "--closed-recovery", id]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      await fs.readFile(path.join(history, "last-quit.json"), "utf8"),
    ).toBe(quit);
    await expect(
      fs.lstat(path.join(f.state, "last-quit.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a redirected Applications parent after the lock handshake and writes no foreign path", async () => {
    const f = await fixture();
    const foreign = path.join(f.root, "foreign");
    await fs.mkdir(foreign, { mode: 0o700 });
    const result = await f.cli({
      hook: "parent_opened",
      atPhase: async () => {
        await fs.rename(f.applications, f.applications + ".pinned");
        await fs.symlink(foreign, f.applications);
      },
    });
    expect(result.status).toBe(1);
    expect(await fs.readdir(foreign)).toEqual([]);
    expect(
      await treeDigest(
        path.join(f.applications + ".pinned", "Farol Next Preview.app"),
      ),
    ).toBe(f.old.digest);
  });
  it("refuses an altered retained receipt on same-operation resume and leaves the moved download in place", async () => {
    const f = await fixture();
    expect(
      (
        await f.cli({
          hook: "journal_moved",
          atPhase: () => {
            throw new Error("TEST_INTERRUPTION");
          },
        })
      ).status,
    ).toBe(1);
    const moved = await fs.lstat(f.retiredUpdates);
    await fs.appendFile(
      path.join(f.history, "Farol Next Preview.app.repair.json"),
      " ",
    );
    const result = await f.cli();
    expect(result.status).toBe(1);
    expect((await fs.lstat(f.retiredUpdates)).ino).toBe(moved.ino);
    await expect(fs.lstat(f.preview)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["updates_moved", "preview_moved", "journal_moved"])(
    "resumes %s without repeating or replacing any moved inode",
    async (phase) => {
      const f = await fixture();
      const result = await f.cli({
        hook: phase,
        atPhase: () => {
          throw new Error("TEST_INTERRUPTION");
        },
      });
      expect(result.status).toBe(1);
      const partial = await fs.lstat(f.retiredUpdates);
      const resumed = await f.cli();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect((await fs.lstat(f.retiredUpdates)).ino).toBe(partial.ino);
      const repeated = await f.cli();
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.receipt, repeated.stderr).toMatchObject({
        phase: "retired",
      });
      expect(
        (await f.cli({}, ["--restore", op, "--expected-preview", f.old.digest]))
          .status,
      ).toBe(0);
    },
  );

  it.each(["prepared.json", "phase.json"])(
    "resumes an interrupted %s publication and retains uncommitted bytes",
    async (name) => {
      const f = await fixture();
      if (name === "phase.json") {
        expect(
          (
            await f.cli({
              hook: "journal_moved",
              atPhase: () => {
                throw new Error("TEST_INTERRUPTION");
              },
            })
          ).status,
        ).toBe(1);
      } else {
        await fs.mkdir(f.history, { mode: 0o700 });
      }
      // A killed journal publisher can leave partial bytes before rename.
      // The exact private temporary convention comes from the pinned library.
      const temporary = path.join(f.history, `.${name}.${"a".repeat(32)}.tmp`);
      await fs.writeFile(temporary, '{"schema":', { mode: 0o600 });
      const staged = await fs.lstat(temporary);
      const resumed = await f.cli();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.receipt.phase).toBe("retired");
      expect((await fs.lstat(temporary)).ino).toBe(staged.ino);
      expect(await fs.readFile(temporary, "utf8")).toBe('{"schema":');
      expect(
        (await f.cli({}, ["--restore", op, "--expected-preview", f.old.digest]))
          .status,
      ).toBe(0);
      expect(await treeDigest(f.preview)).toBe(f.old.digest);
      expect((await fs.lstat(temporary)).ino).toBe(staged.ino);
    },
  );

  it.each(["symlink", "hardlink", "public", "oversize", "wrong name"])(
    "refuses an unsafe %s publication remnant before any installation move",
    async (kind) => {
      const f = await fixture();
      await fs.mkdir(f.history, { mode: 0o700 });
      const name = `.prepared.json.${"a".repeat(32)}.tmp`;
      const temporary = path.join(
        f.history,
        kind === "wrong name" ? name + ".foreign" : name,
      );
      const sentinel = path.join(f.root, "sentinel");
      await fs.writeFile(sentinel, "unchanged", { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(sentinel, temporary);
      else if (kind === "hardlink") await fs.link(sentinel, temporary);
      else
        await fs.writeFile(
          temporary,
          kind === "oversize" ? Buffer.alloc(65_537) : "partial",
          { mode: kind === "public" ? 0o644 : 0o600 },
        );
      const updates = await fs.lstat(f.updates);
      const result = await f.cli();
      expect(result.status, result.stderr).toBe(1);
      expect(await treeDigest(f.preview)).toBe(f.old.digest);
      expect((await fs.lstat(f.updates)).ino).toBe(updates.ino);
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
      await expect(
        fs.lstat(path.join(f.history, "prepared.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
