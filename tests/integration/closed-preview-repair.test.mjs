import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { runClosedRepairCli } from "../../tooling/closed-preview-repair.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../tooling/promotion-lease.mjs";

// Native disposable filesystem and Darwin lock/swap evidence. The tiny bundles
// are identity fixtures, not sealed Electron packages or live runtime evidence.
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const suite = process.platform === "darwin" ? describe : describe.skip;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const appName = "Farol Next Preview.app";

async function write(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode },
  );
}
async function bundle(directory, number) {
  const currentIdentity = createBuildIdentity({
    version: `0.1.${number}-owner.beta.1`,
    buildVersion: String(number),
    updateChannel: "github-owner-beta",
    builtAt: "2026-09-30T12:00:00.000Z",
    sourceCommit: String(number).repeat(40),
    sourceTreeDigest: String(number).repeat(64),
    sourceDirty: false,
  });
  // Explicit legacy metadata for this old-install reader, never a writer default.
  const { buildId: _currentBuildId, ...body } = currentIdentity;
  const legacyBody = {
    ...body,
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
  };
  const identity = { ...legacyBody, buildId: sha(JSON.stringify(legacyBody)) };
  await write(
    path.join(directory, "Contents/Resources/app/build-identity.json"),
    identity,
    0o644,
  );
  await write(
    path.join(directory, "Contents/Resources/app/payload"),
    `build ${number}\n`,
    0o644,
  );
  await write(
    path.join(directory, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.farol.next.preview</string><key>CFBundleShortVersionString</key><string>0.1.${number}</string><key>CFBundleVersion</key><string>${number}</string></dict></plist>`,
    0o644,
  );
  await fs.chmod(directory, 0o755);
  return { identity, digest: await treeDigest(directory) };
}
async function snapshot(directory) {
  const entries = [];
  async function walk(current, relative) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name);
      const key = path.join(relative, name);
      const info = await fs.lstat(file);
      const node = { path: key, dev: info.dev, ino: info.ino, mode: info.mode };
      if (info.isSymbolicLink()) node.link = await fs.readlink(file);
      else if (info.isDirectory()) node.directory = true;
      else node.bytes = (await fs.readFile(file)).toString("base64");
      entries.push(node);
      if (info.isDirectory()) await walk(file, key);
    }
  }
  await walk(directory, "");
  return entries;
}

async function retainedDownload(f, optional = {}) {
  const id = "5891969cfcd0382a942bc2c87539eefc";
  const directory = path.join(f.updateRoot, "download-" + id);
  const handle = path.join(
    directory,
    "github-updates/12345678-1234-1234-1234-123456789abc.zip",
  );
  await write(handle, "unverified archive fixture bytes");
  await write(
    path.join(directory, "unknown-extraction/unknown.bytes"),
    "uncertain extraction stays intact",
  );
  await fs.symlink(
    "missing-but-retained",
    path.join(directory, "unknown-extraction/unknown.link"),
  );
  const metadata = await fs.lstat(directory, { bigint: true });
  const ended = spawnSync("/usr/bin/true", [], { stdio: "ignore" });
  expect(ended.status).toBe(0);
  const manifest = {
    schema: "farol.github-release/1",
    repository: "legrch/farol-releases",
    channel: "owner-beta",
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    version: "0.1.2-owner.beta.1",
    buildVersion: "4",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    buildId: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    archiveSha256: "e".repeat(64),
    archiveName: "Farol-0.1.2-owner.beta.1-darwin-arm64.zip",
    archiveSize: 1000,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  };
  const pending = {
    schema: "farol.update-download-intent/1",
    buildId: manifest.buildId,
    archiveSha256: manifest.archiveSha256,
    download: {
      phase: "verifying",
      id,
      producer: {
        pid: ended.pid,
        processStart: "fixture producer observed terminal",
      },
      identity: {
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        birthtimeNs: String(metadata.birthtimeNs),
      },
    },
  };
  const ready = {
    schema: "farol.ready-update/1",
    handle,
    manifest,
    operation: null,
    downloadId: id,
    ...optional,
  };
  const cleanup = { schema: "farol.update-package-cleanup/1", handle };
  const persist = async () => {
    await write(path.join(f.updateRoot, "ready.json"), ready);
    await write(path.join(f.updateRoot, "download-pending.json"), pending);
    await write(
      path.join(f.updateRoot, "package-cleanup-pending.json"),
      cleanup,
    );
  };
  await persist();
  return { id, directory, handle, ready, pending, cleanup, persist };
}

async function fixture({ updates = true } = {}) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-cold-repair-"),
  );
  roots.push(root);
  const home = path.join(root, "owner");
  const applications = path.join(home, "Applications");
  const destination = path.join(applications, appName);
  const userData = path.join(
    home,
    "Library/Application Support/Farol Next Preview",
  );
  const state = path.join(userData, "farol-next-state");
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const old = await bundle(destination, 1);
  const candidateRoot = path.join(root, "candidate");
  const candidate = path.join(candidateRoot, "_output/package", appName);
  const target = await bundle(candidate, 3);
  const artifact = {
    schema: 5,
    product: "Farol Next Preview",
    version: target.identity.version,
    buildId: target.identity.buildId,
    artifactPath: candidate,
    artifactSha256: target.digest,
    sourceCommit: target.identity.sourceCommit,
    sourceTreeDigest: target.identity.sourceTreeDigest,
    sourceDirty: false,
  };
  await write(
    path.join(candidateRoot, "_output/package/artifact.json"),
    artifact,
  );
  const normal = {
    schema: "farol.promotion-plan/1",
    operation: "applied",
    product: "Farol Next Preview",
    version: old.identity.version,
    sourceCommit: old.identity.sourceCommit,
    sourceTreeDigest: old.identity.sourceTreeDigest,
    sourceDirty: false,
    artifactSha256: old.digest,
    source: path.join(root, "original-source", appName),
    destination,
    receipt: destination + ".receipt.json",
    overwrite: false,
    legacyMutation: false,
    activation: { userData, drained: true, obligations: [] },
    verifiedDestinationSha256: old.digest,
  };
  await write(destination + ".receipt.json", normal);
  const quit = {
    schema: 1,
    at: "2026-09-30T12:10:00.000Z",
    drained: true,
    unconfirmed: [],
  };
  await write(path.join(state, "last-quit.json"), quit);
  await write(
    path.join(state, "config.json"),
    '{"private":"unchanged config"}\n',
  );
  await write(
    path.join(userData, "Cookies"),
    "credential-fixture-do-not-copy\n",
  );
  const updateRoot = path.join(userData, "installed-updates");
  if (updates) {
    await write(path.join(updateRoot, "package-cleanup-pending.json"), {
      schema: "farol.update-package-cleanup/1",
      handle: path.join(updateRoot, "unknown-extraction"),
    });
    await write(
      path.join(updateRoot, "unknown-extraction/unknown.bytes"),
      "preserve uncertain bytes\n",
    );
    await fs.symlink(
      "missing-but-preserved",
      path.join(updateRoot, "unknown-extraction/unknown.link"),
    );
  }
  async function cli(
    args = ["--expected-predecessor", old.digest, "--apply"],
    extra = {},
  ) {
    let output = "";
    let error = "";
    const status = await runClosedRepairCli(args, {
      home,
      candidateRoot,
      sourceIdentity: () => ({
        dirty: false,
        commit: artifact.sourceCommit,
        treeDigest: artifact.sourceTreeDigest,
      }),
      verify: () => {},
      activationObligations: async () => ({
        drained: true,
        obligations: [],
        unreadable: [],
        changed: [],
      }),
      stdout: {
        write(value) {
          output += value;
        },
      },
      stderr: {
        write(value) {
          error += value;
        },
      },
      ...extra,
    });
    return { status, error, receipt: output ? JSON.parse(output) : null };
  }
  return {
    root,
    home,
    applications,
    destination,
    userData,
    state,
    old,
    target,
    candidate,
    candidateRoot,
    normal,
    quit,
    updateRoot,
    cli,
    journal: async () =>
      JSON.parse(
        await fs.readFile(
          path.join(applications, ".farol-closed-repair.json"),
          "utf8",
        ),
      ),
  };
}

suite("bounded closed preview repair", () => {
  it.each([6, 7])(
    "refuses package schema %s before acquiring a lease or dispatching the historical helper",
    async (schema) => {
      const f = await fixture();
      const file = path.join(f.candidateRoot, "_output/package/artifact.json");
      const artifact = JSON.parse(await fs.readFile(file, "utf8"));
      const branded = path.join(path.dirname(f.candidate), "Farol.app");
      await fs.rename(f.candidate, branded);
      await write(file, { ...artifact, schema, artifactPath: branded });
      const before = await snapshot(f.home);
      const acquire = vi.fn(async () => null);
      const descriptor = vi.fn();
      const verify = vi.fn();
      const activation = vi.fn();
      const result = await f.cli(undefined, {
        leases: {
          acquirePromotionLease: acquire,
          promotionLeaseDescriptor: descriptor,
        },
        verify,
        activationObligations: activation,
      });
      expect(result.status).toBe(1);
      expect(result.error).toContain(
        "CLOSED_REPAIR_PACKAGE_LAYOUT_UNSUPPORTED",
      );
      expect(acquire).not.toHaveBeenCalled();
      expect(descriptor).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(activation).not.toHaveBeenCalled();
      expect(await snapshot(f.home)).toEqual(before);
    },
  );

  it("repairs, quarantines whole uncertain staging, then swaps the same exact pair back without copying state", async () => {
    const f = await fixture();
    const originalReceipt = await fs.readFile(f.destination + ".receipt.json");
    const updatesStat = await fs.lstat(f.updateRoot);
    const result = await f.cli();
    expect(result.error).toBe("");
    expect(result.status).toBe(0);
    const r = result.receipt;
    expect(Object.keys(r).sort()).toEqual(
      "schema operationId phase destination userData source target sourceCommit sourceTreeDigest sourceDirty previous quarantine quarantined quitDigest"
        .split(" ")
        .sort(),
    );
    expect(r).toMatchObject({
      schema: "farol.closed-repair/1",
      phase: "installed",
      destination: f.destination,
      userData: f.userData,
      source: { digest: f.old.digest },
      target: { digest: f.target.digest },
      quarantined: true,
      quitDigest: sha(JSON.stringify(f.quit)),
      sourceDirty: false,
    });
    expect(await treeDigest(f.destination)).toBe(f.target.digest);
    expect(await treeDigest(r.previous)).toBe(f.old.digest);
    expect((await fs.lstat(r.quarantine)).ino).toBe(updatesStat.ino);
    expect(
      await fs.readFile(
        path.join(r.quarantine, "unknown-extraction/unknown.bytes"),
        "utf8",
      ),
    ).toBe("preserve uncertain bytes\n");
    expect(
      await fs.readlink(
        path.join(r.quarantine, "unknown-extraction/unknown.link"),
      ),
    ).toBe("missing-but-preserved");
    expect(await fs.readFile(f.destination + ".receipt.json")).toEqual(
      originalReceipt,
    );
    await write(path.join(f.state, "last-quit.json"), {
      ...f.quit,
      at: "2026-09-30T12:11:00.000Z",
    });
    const rolled = await f.cli(["--rollback", r.operationId]);
    expect(rolled.error).toBe("");
    expect(rolled.receipt.phase).toBe("rolled_back");
    expect(await treeDigest(f.destination)).toBe(f.old.digest);
    expect(await treeDigest(r.previous)).toBe(f.target.digest);
    expect(await fs.readFile(path.join(f.state, "config.json"), "utf8")).toBe(
      '{"private":"unchanged config"}\n',
    );
    expect(await fs.readFile(path.join(f.userData, "Cookies"), "utf8")).toBe(
      "credential-fixture-do-not-copy\n",
    );
    expect(await fs.readFile(f.destination + ".receipt.json")).toEqual(
      originalReceipt,
    );
    expect((await f.cli(["--rollback", r.operationId])).status).toBe(0);
    expect(await treeDigest(f.destination)).toBe(f.old.digest);
  });

  it.each([
    "wrong predecessor",
    "forged receipt",
    "missing receipt",
    "running",
    "unconfirmed quit",
    "symlink quit",
    "symlink profile",
    "symlink application",
    "corrupt target",
    "dirty source",
    "package denial",
    "obligation",
    "restore pending",
    "apply journal",
    "helper live",
    "native fence",
    "native producer",
    "native admission",
  ])(
    "refuses %s and preserves the original slot and old staging",
    async (kind) => {
      const f = await fixture();
      const extra = {};
      let args;
      if (kind === "wrong predecessor")
        args = ["--expected-predecessor", "f".repeat(64), "--apply"];
      if (kind === "forged receipt")
        await write(f.destination + ".receipt.json", {
          ...f.normal,
          sourceCommit: "e".repeat(40),
        });
      if (kind === "missing receipt")
        await fs.unlink(f.destination + ".receipt.json");
      if (kind === "running")
        await write(path.join(f.state, "running.json"), {});
      if (kind === "unconfirmed quit")
        await write(path.join(f.state, "last-quit.json"), {
          ...f.quit,
          unconfirmed: ["child"],
        });
      if (kind === "symlink quit") {
        await fs.rename(
          path.join(f.state, "last-quit.json"),
          path.join(f.state, "quit.saved"),
        );
        await fs.symlink("quit.saved", path.join(f.state, "last-quit.json"));
      }
      if (kind === "symlink profile") {
        await fs.rename(f.userData, f.userData + ".saved");
        await fs.symlink(f.userData + ".saved", f.userData);
      }
      if (kind === "symlink application") {
        await fs.rename(f.destination, f.destination + ".saved");
        await fs.symlink(f.destination + ".saved", f.destination);
      }
      if (kind === "corrupt target")
        await write(
          path.join(f.candidate, "Contents/Resources/app/payload"),
          "corrupt",
        );
      if (kind === "dirty source")
        extra.sourceIdentity = () => ({ dirty: true });
      if (kind === "package denial")
        extra.verify = () => {
          throw new Error("package invalid");
        };
      if (kind === "obligation")
        extra.activationObligations = async () => ({
          drained: false,
          obligations: ["TASK_RUNNING"],
          unreadable: [],
          changed: [],
        });
      if (kind === "restore pending")
        await write(path.join(f.updateRoot, "restore-pending.json"), {});
      if (kind === "apply journal")
        await write(
          path.join(f.updateRoot, "a".repeat(32), "journal.json"),
          {},
        );
      if (kind === "helper live")
        await write(path.join(f.updateRoot, "download-pending.json"), {
          schema: "farol.update-download-intent/1",
          buildId: "a".repeat(64),
          archiveSha256: "b".repeat(64),
          download: {
            id: "a".repeat(32),
            phase: "verifying",
            producer: { pid: process.pid, processStart: "still live" },
          },
        });
      if (kind === "native fence")
        await write(
          path.join(
            f.state,
            "secure-mcp-connector/computer-authority/execution-fence/shell-unknown.json",
          ),
          {},
        );
      let lock;
      if (kind === "native producer" || kind === "native admission") {
        const file = path.join(
          f.state,
          kind === "native producer"
            ? "secure-mcp-connector/computer-authority/mcp-lifecycle/lifetime.lock"
            : "secure-mcp-connector/computer-authority/execution-fence/admission.lock",
        );
        await write(file, "");
        lock = await fs.open(
          file,
          constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x10,
        );
      }
      try {
        const result = await f.cli(args, extra);
        expect(result.status, result.error).toBe(1);
        expect(
          await treeDigest(
            kind === "symlink application"
              ? f.destination + ".saved"
              : f.destination,
          ),
        ).toBe(f.old.digest);
        expect(
          await fs.readFile(
            path.join(f.updateRoot, "unknown-extraction/unknown.bytes"),
            "utf8",
          ),
        ).toBe("preserve uncertain bytes\n");
        await expect(
          fs.lstat(f.destination + ".repair.json"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await lock?.close();
      }
    },
  );

  it("refuses an actual promotion lease holder, and the child's inherited fd excludes admission until terminal", async () => {
    const f = await fixture();
    const held = await acquirePromotionLease(
      f.userData,
      "test-held",
      "promotion",
    );
    try {
      expect((await f.cli()).error).toContain("LEASE_HELD");
    } finally {
      await releasePromotionLease(held);
    }
    const result = await f.cli(undefined, {
      hook: "swap_intent",
      atPhase: async () => {
        expect(
          await acquirePromotionLease(f.userData, "contender", "admission"),
        ).toBeNull();
      },
    });
    expect(result.status, result.error).toBe(0);
    const after = await acquirePromotionLease(
      f.userData,
      "after-terminal",
      "admission",
    );
    expect(after).not.toBeNull();
    await releasePromotionLease(after);
  });

  it("refuses an independent fd on the exact locked inode instead of adopting its lock", async () => {
    const f = await fixture();
    await write(path.join(f.state, "promotion.lease"), "");
    const independent = await fs.open(
      path.join(f.state, "promotion.lease"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const result = await f.cli(undefined, {
        leases: {
          acquirePromotionLease,
          verifyPromotionLease,
          releasePromotionLease,
          promotionLeaseDescriptor: () => independent.fd,
        },
      });
      expect(result.error).toContain("LEASE_DESCRIPTOR_NOT_HOLDER");
      expect(await treeDigest(f.destination)).toBe(f.old.digest);
    } finally {
      await independent.close();
    }
  });

  it("records the exact helper bytes and refuses changed recovery pair or quit evidence", async () => {
    const python = await fs.readFile(
      new URL("../../tooling/closed-preview-repair.py", import.meta.url),
    );
    const launcher = await fs.readFile(
      new URL("../../tooling/closed-preview-repair.mjs", import.meta.url),
      "utf8",
    );
    expect(launcher).toContain(sha(python));
    const f = await fixture();
    await f.cli(undefined, {
      hook: "swapped",
      atPhase: (child) => child.kill("SIGKILL"),
    });
    const journal = await f.journal();
    const recover = [
      "--expected-predecessor",
      f.old.digest,
      "--recover",
      journal.receipt.operationId,
      "--apply",
    ];
    expect(
      (
        await f.cli([
          "--expected-predecessor",
          "d".repeat(64),
          "--recover",
          journal.receipt.operationId,
          "--apply",
        ])
      ).error,
    ).toContain("RECOVERY_PAIR_CHANGED");
    await write(path.join(f.state, "last-quit.json"), {
      ...f.quit,
      at: "2026-09-30T12:12:00.000Z",
    });
    expect((await f.cli(recover)).error).toContain("RECOVERY_PAIR_CHANGED");
    expect(await treeDigest(f.destination)).toBe(f.target.digest);
    expect((await f.journal()).phase).toBe("swap_intent");
  });

  it("refuses a swapped Applications parent before mutation", async () => {
    const f = await fixture();
    const result = await f.cli(undefined, {
      hook: "parent_opened",
      atPhase: async () => {
        await fs.rename(f.applications, f.applications + ".saved");
        await fs.mkdir(f.applications, { mode: 0o700 });
      },
    });
    expect(result.status).toBe(1);
    expect(
      await treeDigest(path.join(f.applications + ".saved", appName)),
    ).toBe(f.old.digest);
    expect(await fs.readdir(f.applications)).toEqual([]);
  });

  it.each([
    "staged",
    "swap_intent",
    "swapped",
    "save_intent",
    "saved",
    "quarantine_intent",
    "quarantined",
    "receipt_intent",
  ])(
    "reconciles interruption at %s by exact inode/build pair without copying or swapping twice",
    async (phase) => {
      const f = await fixture();
      const interrupted = await f.cli(undefined, {
        hook: phase,
        atPhase: (child) => {
          child.kill("SIGKILL");
        },
      });
      expect(interrupted.status).toBe(1);
      const journal = await f.journal();
      expect(journal.phase).not.toBe("installed");
      await expect(
        fs.lstat(f.destination + ".repair.json"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const originalTargetInode = journal.targetInode;
      expect((await f.cli()).error).toContain("RECOVERY_REQUIRED");
      const recovered = await f.cli([
        "--expected-predecessor",
        f.old.digest,
        "--recover",
        journal.receipt.operationId,
        "--apply",
      ]);
      expect(recovered.status, recovered.error).toBe(0);
      expect(await treeDigest(f.destination)).toBe(f.target.digest);
      expect(await treeDigest(recovered.receipt.previous)).toBe(f.old.digest);
      expect((await fs.lstat(f.destination)).ino).toBe(originalTargetInode[1]);
      const again = await f.cli([
        "--expected-predecessor",
        f.old.digest,
        "--recover",
        journal.receipt.operationId,
        "--apply",
      ]);
      expect(again.status, again.error).toBe(0);
      expect((await fs.lstat(f.destination)).ino).toBe(originalTargetInode[1]);
    },
  );

  it.each(["receipt_published", "rollback_receipt_published"])(
    "reconciles %s after a later normal Quit without repeating the swap",
    async (phase) => {
      const f = await fixture();
      let args;
      if (phase === "rollback_receipt_published") {
        const installed = await f.cli();
        expect(installed.status, installed.error).toBe(0);
        args = ["--rollback", installed.receipt.operationId];
      }
      const interrupted = await f.cli(args, {
        hook: phase,
        atPhase: (child) => child.kill("SIGKILL"),
      });
      expect(interrupted.status).toBe(1);
      const journal = await f.journal();
      const published = JSON.parse(
        await fs.readFile(f.destination + ".repair.json", "utf8"),
      );
      expect(published).toEqual(journal.receipt);
      const slotInode = (await fs.lstat(f.destination)).ino;
      const previousInode = (await fs.lstat(published.previous)).ino;
      await write(path.join(f.state, "last-quit.json"), {
        ...f.quit,
        at: "2026-09-30T12:20:00.000Z",
      });
      const recovered = await f.cli(
        phase === "receipt_published"
          ? [
              "--expected-predecessor",
              f.old.digest,
              "--recover",
              published.operationId,
              "--apply",
            ]
          : ["--rollback", published.operationId],
      );
      expect(recovered.status, recovered.error).toBe(0);
      expect((await f.journal()).phase).toBe(published.phase);
      expect(recovered.receipt).toEqual(published);
      expect((await fs.lstat(f.destination)).ino).toBe(slotInode);
      expect((await fs.lstat(published.previous)).ino).toBe(previousInode);
    },
  );

  it.each([
    "unpublished",
    "changed-receipt",
    "changed-slot",
    "changed-quarantine",
  ])(
    "refuses a later Quit recovery when the published terminal evidence is %s",
    async (scenario) => {
      const f = await fixture();
      const interrupted = await f.cli(undefined, {
        hook:
          scenario === "unpublished" ? "receipt_intent" : "receipt_published",
        atPhase: (child) => child.kill("SIGKILL"),
      });
      expect(interrupted.status).toBe(1);
      const journal = await f.journal();
      if (scenario === "changed-receipt")
        await write(f.destination + ".repair.json", {
          ...journal.receipt,
          quitDigest: "1".repeat(64),
        });
      if (scenario === "changed-slot")
        await write(
          path.join(f.destination, "Contents/Resources/app/payload"),
          "changed target",
        );
      if (scenario === "changed-quarantine") {
        await fs.rename(
          journal.receipt.quarantine,
          journal.receipt.quarantine + ".saved",
        );
        await fs.mkdir(journal.receipt.quarantine, { mode: 0o700 });
      }
      await write(path.join(f.state, "last-quit.json"), {
        ...f.quit,
        at: "2026-09-30T12:20:00.000Z",
      });
      const slotBefore = await snapshot(f.destination);
      const previousBefore = await snapshot(journal.receipt.previous);
      const result = await f.cli([
        "--expected-predecessor",
        f.old.digest,
        "--recover",
        journal.receipt.operationId,
        "--apply",
      ]);
      expect(result.status).toBe(1);
      expect(await f.journal()).toEqual(journal);
      expect(await snapshot(f.destination)).toEqual(slotBefore);
      expect(await snapshot(journal.receipt.previous)).toEqual(previousBefore);
    },
  );

  it("recovers an absent stage only with the unchanged original slot and empty operation container", async () => {
    const f = await fixture();
    expect(
      (
        await f.cli(undefined, {
          hook: "copy_intent",
          atPhase: (child) => child.kill("SIGKILL"),
        })
      ).status,
    ).toBe(1);
    const journal = await f.journal();
    const container = path.join(
      f.applications,
      ".farol-repair-" + journal.receipt.operationId,
    );
    expect(await fs.readdir(container)).toEqual([]);
    expect(await treeDigest(f.destination)).toBe(f.old.digest);
    const result = await f.cli([
      "--expected-predecessor",
      f.old.digest,
      "--recover",
      journal.receipt.operationId,
      "--apply",
    ]);
    expect(result.status, result.error).toBe(0);
    expect(await treeDigest(result.receipt.previous)).toBe(f.old.digest);
    expect(await treeDigest(f.destination)).toBe(f.target.digest);
  });

  it.each(["container", "source-bytes", "source-inode", "target"])(
    "refuses absent-stage recovery after %s changes without preparing another copy",
    async (kind) => {
      const f = await fixture();
      await f.cli(undefined, {
        hook: "copy_intent",
        atPhase: (child) => child.kill("SIGKILL"),
      });
      const journal = await f.journal();
      const container = path.join(
        f.applications,
        ".farol-repair-" + journal.receipt.operationId,
      );
      if (kind === "container")
        await write(path.join(container, "unknown.bytes"), "preserved");
      if (kind === "source-bytes")
        await write(
          path.join(f.destination, "Contents/Resources/app/payload"),
          "changed",
        );
      if (kind === "source-inode") {
        await fs.rename(f.destination, f.destination + ".moved");
        await fs.cp(f.destination + ".moved", f.destination, {
          recursive: true,
        });
      }
      if (kind === "target")
        await write(
          path.join(f.candidate, "Contents/Resources/app/payload"),
          "changed",
        );
      const before = await snapshot(container);
      const installed = await treeDigest(f.destination);
      const result = await f.cli([
        "--expected-predecessor",
        f.old.digest,
        "--recover",
        journal.receipt.operationId,
        "--apply",
      ]);
      expect(result.status).toBe(1);
      expect(result.error).toContain(
        kind === "container"
          ? "COPY_CONTAINER_UNCONFIRMED"
          : kind === "target"
            ? "TARGET_IDENTITY_CHANGED"
            : "COPY_SOURCE_CHANGED",
      );
      expect(await snapshot(container)).toEqual(before);
      expect(await treeDigest(f.destination)).toBe(installed);
      expect((await f.journal()).phase).toBe("copy_intent");
    },
  );

  it.each(["native", "generator"])(
    "bounds directory enumeration before materialization (%s)",
    async (mode) => {
      const f = await fixture({ updates: false });
      const directory = path.join(f.root, "enumeration");
      await fs.mkdir(directory);
      for (let i = 0; i < 4; i += 1)
        await write(path.join(directory, String(i)), "fixture");
      const program = String.raw`
import os,sys
scope={"__name__":"bounded_enumeration_fixture"}
with open(sys.argv[1],"rb") as source: exec(compile(source.read(),sys.argv[1],"exec"),scope)
scope["MAX_ENTRIES"]=3
seen=[0]
class Entry:
    def __init__(self,name): self.name=name
class Cursor:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def __iter__(self):
        for n in range(4):
            seen[0]+=1
            yield Entry(str(n))
        raise AssertionError("enumerated beyond the bounded prefix")
if sys.argv[2]=="generator":
    os.scandir=lambda _:Cursor()
    os.listdir=lambda _:[entry.name for entry in Cursor()]
    descriptor=0
else: descriptor=os.open(sys.argv[3],os.O_RDONLY|os.O_DIRECTORY)
try:
    try: scope["sorted_names"](descriptor)
    except scope["Refusal"] as error:
        assert str(error)==scope["EXIT_COPY"]
        if sys.argv[2]=="generator": assert seen[0]==4
    else: raise AssertionError("oversized directory was admitted")
finally:
    if sys.argv[2]=="native":os.close(descriptor)
`;
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          program,
          new URL("../../tooling/closed-preview-repair.py", import.meta.url)
            .pathname,
          mode,
          directory,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("a present partial copy remains fail closed and all bytes are preserved", async () => {
    const f = await fixture();
    expect(
      (
        await f.cli(undefined, {
          hook: "copy_intent",
          atPhase: (child) => child.kill("SIGKILL"),
        })
      ).status,
    ).toBe(1);
    const journal = await f.journal();
    const stage = path.join(
      f.applications,
      ".farol-repair-" + journal.receipt.operationId,
      "staged.app",
    );
    await write(path.join(stage, "partial"), "unknown bytes");
    const recovered = await f.cli([
      "--expected-predecessor",
      f.old.digest,
      "--recover",
      journal.receipt.operationId,
      "--apply",
    ]);
    expect(recovered.status).toBe(1);
    expect(await fs.readFile(path.join(stage, "partial"), "utf8")).toBe(
      "unknown bytes",
    );
    expect(await treeDigest(f.destination)).toBe(f.old.digest);
    expect((await f.journal()).phase).toBe("copy_intent");
  });

  it.each(["missing", "replaced"])(
    "refuses rollback before any mutation when the quarantine is %s",
    async (scenario) => {
      const f = await fixture();
      const installed = (await f.cli()).receipt;
      await fs.rename(installed.quarantine, installed.quarantine + ".saved");
      if (scenario === "replaced")
        await fs.mkdir(installed.quarantine, { mode: 0o700 });
      const installedBefore = await snapshot(f.destination);
      const previousBefore = await snapshot(installed.previous);
      const journalBefore = await f.journal();
      const receiptBefore = await fs.readFile(f.destination + ".repair.json");
      const result = await f.cli(["--rollback", installed.operationId]);
      expect(result.status).toBe(1);
      expect(await snapshot(f.destination)).toEqual(installedBefore);
      expect(await snapshot(installed.previous)).toEqual(previousBefore);
      expect(await f.journal()).toEqual(journalBefore);
      expect(await fs.readFile(f.destination + ".repair.json")).toEqual(
        receiptBefore,
      );
    },
  );

  it("rollback reconciles its interrupted swap and refuses wrong IDs or changed companions", async () => {
    const f = await fixture();
    const installed = (await f.cli()).receipt;
    expect((await f.cli(["--rollback", "e".repeat(32)])).status).toBe(1);
    expect(
      (
        await f.cli(["--rollback", installed.operationId], {
          hook: "rollback_swapped",
          atPhase: (child) => child.kill("SIGKILL"),
        })
      ).status,
    ).toBe(1);
    expect(await treeDigest(f.destination)).toBe(f.old.digest);
    expect((await f.journal()).phase).toBe("rollback_intent");
    expect((await f.cli(["--rollback", installed.operationId])).status).toBe(0);
    await write(path.join(installed.previous, "changed"), "corrupt companion");
    expect((await f.cli(["--rollback", installed.operationId])).status).toBe(1);
  });

  it.each([true, false])(
    "refuses a fresh repair chain before replacing its journal/receipt or allocating another container (journal present: %s)",
    async (journalPresent) => {
      const f = await fixture();
      const installed = (await f.cli()).receipt;
      const next = await bundle(f.candidate, 4);
      await write(path.join(f.candidateRoot, "_output/package/artifact.json"), {
        schema: 5,
        artifactPath: f.candidate,
        version: next.identity.version,
        buildId: next.identity.buildId,
        artifactSha256: next.digest,
        sourceCommit: next.identity.sourceCommit,
        sourceTreeDigest: next.identity.sourceTreeDigest,
        sourceDirty: false,
      });
      if (!journalPresent)
        await fs.unlink(path.join(f.applications, ".farol-closed-repair.json"));
      const applications = await snapshot(f.applications);
      const profile = await snapshot(f.userData);
      const result = await f.cli(
        ["--expected-predecessor", f.target.digest, "--apply"],
        {
          sourceIdentity: () => ({
            dirty: false,
            commit: next.identity.sourceCommit,
            treeDigest: next.identity.sourceTreeDigest,
          }),
        },
      );
      expect(result.status, result.error).toBe(1);
      expect(result.error).toContain("CLOSED_REPAIR_CHAIN_UNSUPPORTED");
      expect(await snapshot(f.applications)).toEqual(applications);
      expect(await snapshot(f.userData)).toEqual(profile);
      if (journalPresent)
        expect((await f.journal()).receipt.operationId).toBe(
          installed.operationId,
        );
    },
  );

  it.each([{}, { helper: null }, { preparation: null, helper: null }])(
    "quarantines only the linked download-only ready tuple intact (%j)",
    async (optional) => {
      const f = await fixture({ updates: false });
      await retainedDownload(f, optional);
      const updates = await snapshot(f.updateRoot);
      const config = await fs.readFile(path.join(f.state, "config.json"));
      const result = await f.cli();
      expect(result.status, result.error).toBe(0);
      expect(result.receipt.quarantined).toBe(true);
      expect(await snapshot(result.receipt.quarantine)).toEqual(updates);
      expect(await fs.readFile(path.join(f.state, "config.json"))).toEqual(
        config,
      );
      expect(await fs.readFile(path.join(f.userData, "Cookies"), "utf8")).toBe(
        "credential-fixture-do-not-copy\n",
      );
    },
  );

  it.each([
    "operation",
    "preparation",
    "helper",
    "extra field",
    "unknown schema",
    "missing pending",
    "missing cleanup",
    "different id",
    "different handle",
    "different build",
    "different archive",
    "different inode",
    "different birthtime",
    "missing identity",
    "malformed manifest",
    "unknown manifest field",
    "live producer",
    "nested journal",
  ])(
    "refuses retained ready %s before repair journal and preserves all update bytes",
    async (kind) => {
      const f = await fixture({ updates: false });
      const tuple = await retainedDownload(f);
      if (kind === "operation")
        tuple.ready.operation = {
          operationId: "a".repeat(32),
          source: {},
          target: {},
        };
      if (kind === "preparation") tuple.ready.preparation = {};
      if (kind === "helper")
        tuple.ready.helper = { pid: process.pid, processStart: "live" };
      if (kind === "extra field") tuple.ready.extra = true;
      if (kind === "unknown schema")
        tuple.ready.schema = "farol.ready-update/2";
      if (kind === "different id") tuple.ready.downloadId = "f".repeat(32);
      if (kind === "different handle") tuple.cleanup.handle += ".other";
      if (kind === "different build")
        tuple.ready.manifest.buildId = "f".repeat(64);
      if (kind === "different archive")
        tuple.ready.manifest.archiveSha256 = "f".repeat(64);
      if (kind === "different inode") tuple.pending.download.identity.ino = "1";
      if (kind === "different birthtime")
        tuple.pending.download.identity.birthtimeNs = "1";
      if (kind === "missing identity") delete tuple.pending.download.identity;
      if (kind === "malformed manifest") tuple.ready.manifest = null;
      if (kind === "unknown manifest field") tuple.ready.manifest.extra = true;
      if (kind === "live producer")
        tuple.pending.download.producer.pid = process.pid;
      await tuple.persist();
      if (kind === "missing pending")
        await fs.unlink(path.join(f.updateRoot, "download-pending.json"));
      if (kind === "missing cleanup")
        await fs.unlink(
          path.join(f.updateRoot, "package-cleanup-pending.json"),
        );
      if (kind === "nested journal")
        await write(
          path.join(tuple.directory, "unknown-extraction/journal.json"),
          {},
        );
      const before = await snapshot(f.updateRoot);
      const result = await f.cli();
      expect(result.status, result.error).toBe(1);
      expect(await snapshot(f.updateRoot)).toEqual(before);
      expect(await treeDigest(f.destination)).toBe(f.old.digest);
      await expect(
        fs.lstat(path.join(f.applications, ".farol-closed-repair.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([true, false])(
    "fresh apply after rollback requires the genuine original install anchor (%s)",
    async (genuine) => {
      const f = await fixture({ updates: false });
      const installed = (await f.cli()).receipt;
      expect((await f.cli(["--rollback", installed.operationId])).status).toBe(
        0,
      );
      if (!genuine)
        await write(f.destination + ".receipt.json", {
          ...f.normal,
          sourceCommit: "f".repeat(40),
        });
      const before = await snapshot(f.applications);
      const result = await f.cli();
      if (genuine) {
        expect(result.status, result.error).toBe(0);
        expect(result.receipt.operationId).not.toBe(installed.operationId);
        expect(await treeDigest(f.destination)).toBe(f.target.digest);
        expect(await treeDigest(installed.previous)).toBe(f.target.digest);
      } else {
        expect(result.error).toContain("PREDECESSOR_UNACCEPTED");
        expect(await snapshot(f.applications)).toEqual(before);
      }
    },
  );

  it("refuses another fresh apply even when the prior installed repair companion changed", async () => {
    const f = await fixture({ updates: false });
    const repaired = (await f.cli()).receipt;
    await bundle(f.candidate, 4);
    const target = JSON.parse(
      await fs.readFile(
        path.join(f.candidate, "Contents/Resources/app/build-identity.json"),
        "utf8",
      ),
    );
    await write(path.join(f.candidateRoot, "_output/package/artifact.json"), {
      schema: 5,
      artifactPath: f.candidate,
      version: target.version,
      buildId: target.buildId,
      artifactSha256: await treeDigest(f.candidate),
      sourceCommit: target.sourceCommit,
      sourceTreeDigest: target.sourceTreeDigest,
      sourceDirty: false,
    });
    await write(path.join(repaired.previous, "corrupted"), "unknown");
    const result = await f.cli(
      ["--expected-predecessor", f.target.digest, "--apply"],
      {
        sourceIdentity: () => ({
          dirty: false,
          commit: target.sourceCommit,
          treeDigest: target.sourceTreeDigest,
        }),
      },
    );
    expect(result.status).toBe(1);
    expect(await treeDigest(f.destination)).toBe(f.target.digest);
  });

  it("rejects CLI home/source overrides and missing explicit approval before any filesystem read", async () => {
    let text = "";
    for (const args of [
      ["--home", "/tmp"],
      ["--source", "/tmp"],
      ["--apply"],
      ["--rollback", "a".repeat(32), "--apply"],
    ]) {
      expect(
        await runClosedRepairCli(args, {
          stderr: {
            write(value) {
              text += value;
            },
          },
        }),
      ).toBe(1);
    }
    expect(text).toContain("OPTION_INVALID");
    expect(text).toContain("EXPLICIT_PAIR_REQUIRED");
  });
});
