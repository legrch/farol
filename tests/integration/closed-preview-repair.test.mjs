import { afterEach, describe, expect, it } from "vitest";
import { constants } from "node:fs";
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
  const identity = createBuildIdentity({
    version: `0.1.${number}-owner.beta.1`,
    buildVersion: String(number),
    updateChannel: "github-owner-beta",
    builtAt: "2026-09-30T12:00:00.000Z",
    sourceCommit: String(number).repeat(40),
    sourceTreeDigest: String(number).repeat(64),
    sourceDirty: false,
  });
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
    schema: "farol.next.promotion-plan/1",
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
      schema: "farol.next.closed-repair/1",
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

  it("an absent/partial copy remains fail closed and all bytes are preserved", async () => {
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

  it("accepts a prior repair receipt only when both measured trees match it", async () => {
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
