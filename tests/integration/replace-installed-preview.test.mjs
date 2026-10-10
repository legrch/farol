// Native disposable lock/custody/placement evidence, with synthetic package and
// source verification. No Electron package, owner profile or provider qualifies.
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { promotionUserData } from "../../tooling/promotion-obligations.mjs";
import {
  replaceInstalledPreview,
  snapshotInstalledReplacement,
} from "../../tooling/replace-installed-preview.mjs";
import { isPromotionLeaseHeld } from "../../tooling/promotion-lease.mjs";
const roots = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true });
});

async function fixture() {
  const temporary = await fs.realpath(os.tmpdir());
  const r = await fs.mkdtemp(path.join(temporary, "farol-replacement-"));
  roots.push(r);
  const home = path.join(r, "home");
  const userData = promotionUserData(home);
  const apps = path.join(home, "Applications");
  const oldApp = path.join(apps, "Farol.app");
  const candidateApp = path.join(r, "candidate/Farol.app");
  const build = (n) =>
    createBuildIdentity({
      version: `0.2.0-owner.beta.${n}`,
      buildVersion: String(n + 14),
      updateChannel: "github-owner-beta",
      builtAt: "2026-10-10T00:00:00.000Z",
      sourceCommit: String(n).repeat(40),
      sourceTreeDigest: String(n).repeat(64),
      sourceDirty: false,
    });
  const oldBuild = build(5),
    target = build(6);
  for (const [app, identity] of [
    [oldApp, oldBuild],
    [candidateApp, target],
  ]) {
    await fs.mkdir(path.join(app, "Contents/Resources/app"), {
      recursive: true,
      mode: 0o755,
    });
    await fs.writeFile(
      path.join(app, "Contents/Resources/app/build-identity.json"),
      JSON.stringify(identity),
      { mode: 0o644 },
    );
  }
  await fs.chmod(home, 0o700);
  await fs.mkdir(path.join(userData, "farol-next-state"), {
    recursive: true,
    mode: 0o700,
  });
  const updates = path.join(userData, "installed-updates");
  await fs.mkdir(updates, { mode: 0o700 });
  for (const [name, raw] of [
    ["lock", ""],
    ["ready.json", '{"helper":null}'],
    ["last-update.json", '{"helper":null,"phase":"verified"}'],
  ])
    await fs.writeFile(path.join(updates, name), raw, { mode: 0o600 });
  const op = path.join(updates, "a".repeat(32));
  await fs.mkdir(path.join(op, "previous.app"), {
    recursive: true,
    mode: 0o700,
  });
  const journal = '{"phase":"launch_requested","fixtureOnly":true}\n';
  await fs.writeFile(path.join(op, "journal.json"), journal, { mode: 0o600 });
  const oldDigest = await treeDigest(oldApp);
  const receipt = {
    schema: "farol.next.promotion-plan/1",
    operation: "applied",
    product: "Farol Next Preview",
    version: oldBuild.version,
    sourceCommit: oldBuild.sourceCommit,
    sourceTreeDigest: oldBuild.sourceTreeDigest,
    sourceDirty: false,
    artifactSha256: oldDigest,
    source: path.join(r, "original-source"),
    destination: oldApp,
    receipt: oldApp + ".receipt.json",
    overwrite: false,
    legacyMutation: false,
    activation: { userData, drained: true, obligations: [] },
    verifiedDestinationSha256: oldDigest,
  };
  const oldReceipt = JSON.stringify(receipt) + "\n";
  await fs.writeFile(oldApp + ".receipt.json", oldReceipt, { mode: 0o600 });
  const artifact = {
    ...target,
    schema: 7,
    artifactSha256: await treeDigest(candidateApp),
    artifactPath: candidateApp,
  };
  const snapshot = await snapshotInstalledReplacement(home);
  const selection = {
    schema: "farol.installed-replacement-selection/1",
    sourceCommit: target.sourceCommit,
    operationId: "b".repeat(32),
    snapshot,
    helpers: [],
  };
  const deps = {
    home,
    artifact,
    candidate: {
      artifactFile: path.join(r, "fixture-artifact.json"),
      appPath: candidateApp,
    },
    sourceIdentity: () => ({
      commit: target.sourceCommit,
      treeDigest: target.sourceTreeDigest,
      dirty: false,
    }),
    processProof: () => {},
    verify: async (_artifact, app) => {
      expect(await treeDigest(app)).toBe(artifact.artifactSha256);
    },
  };
  return {
    r,
    home,
    userData,
    apps,
    updates,
    oldApp,
    oldReceipt,
    journal,
    selection,
    deps,
    artifact,
    custody: path.join(apps, `.farol-replacement-${selection.operationId}`),
  };
}

describe("one-shot installed replacement", () => {
  it("plans without intent, custody, lock creation or app mutation", async () => {
    const f = await fixture();
    const result = await replaceInstalledPreview(f.selection, false, f.deps);
    expect(result.operation).toBe("plan-only");
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(f.userData, "farol-next-state/promotion.lease")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
  });
  it.each(["occupied", "inode", "digest", "journal", "drain"])(
    "refuses %s before custody",
    async (kind) => {
      const f = await fixture();
      if (kind === "occupied") await fs.mkdir(f.custody);
      if (kind === "inode") f.selection.snapshot.appIdentity = ["0", "0"];
      if (kind === "digest")
        f.selection.snapshot.receiptSha256 = "0".repeat(64);
      if (kind === "journal")
        await fs.writeFile(path.join(f.updates, "pending.json"), "unknown", {
          mode: 0o600,
        });
      if (kind === "drain")
        f.deps.activation = async () => ({
          obligations: ["QUIT_UNCONFIRMED"],
          unreadable: [],
          changed: [],
          drained: false,
        });
      await expect(
        replaceInstalledPreview(f.selection, true, f.deps),
      ).rejects.toThrow();
      expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
        f.oldReceipt,
      );
      await expect(
        fs.lstat(
          path.join(
            f.userData,
            "farol-next-state/installed-replacement.pending",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("refuses a waiting old helper's updater lock even though promotion is available", async () => {
    const f = await fixture();
    const lock = await fs.open(
      path.join(f.updates, "lock"),
      C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
    );
    try {
      await expect(
        replaceInstalledPreview(f.selection, true, f.deps),
      ).rejects.toThrow();
    } finally {
      await lock.close();
    }
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
  });
  it("custodies every original byte and retains an unconfirmed journal through genuine promotion", async () => {
    const f = await fixture();
    const result = await replaceInstalledPreview(f.selection, true, f.deps);
    expect(result.operation).toBe("completed");
    expect(await treeDigest(path.join(f.custody, "previous.app"))).toBe(
      f.selection.snapshot.appSha256,
    );
    expect(
      await fs.readFile(path.join(f.custody, "previous.receipt.json"), "utf8"),
    ).toBe(f.oldReceipt);
    expect(
      await fs.readFile(
        path.join(
          f.custody,
          "installed-updates",
          "a".repeat(32),
          "journal.json",
        ),
        "utf8",
      ),
    ).toBe(f.journal);
    expect(await treeDigest(f.oldApp)).toBe(f.artifact.artifactSha256);
    const receipt = JSON.parse(
      await fs.readFile(f.oldApp + ".receipt.json", "utf8"),
    );
    expect(receipt).toEqual(result.receipt);
    expect(receipt.schema).toBe("farol.next.promotion-plan/1");
    expect(receipt.sourceCommit).toBe(f.artifact.sourceCommit);
    await expect(
      fs.lstat(
        path.join(f.userData, "farol-next-state/installed-replacement.pending"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("unknown promotion retains both original locks until the registered child closes and keeps intent", async () => {
    const f = await fixture();
    let close;
    const closed = new Promise((resolve) => {
      close = resolve;
    });
    f.deps.promotion = async ({ onChildStarted }) => {
      onChildStarted(closed);
      throw Error("fixture original helper unknown");
    };
    await expect(
      replaceInstalledPreview(f.selection, true, f.deps),
    ).rejects.toThrow("fixture original helper unknown");
    expect(await isPromotionLeaseHeld(f.userData)).toBe(true);
    const lock = path.join(f.custody, "installed-updates/lock");
    await expect(
      fs.open(lock, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(
      (
        await fs.lstat(
          path.join(
            f.userData,
            "farol-next-state/installed-replacement.pending",
          ),
        )
      ).isFile(),
    ).toBe(true);
    close({ code: 1, signal: null });
    // Allow the original close continuation, not a retry of any effect.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
