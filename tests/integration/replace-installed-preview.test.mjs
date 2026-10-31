// Native disposable lock/custody/placement evidence, with synthetic package and
// source verification. No Electron package, owner profile or provider qualifies.
import { spawn, spawnSync } from "node:child_process";
import { constants as C } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { promotionUserData } from "../../tooling/promotion-obligations.mjs";
import {
  replaceInstalledPreview,
  prepareCleanReplacementLock,
  replacementApplications,
  snapshotInstalledReplacement,
} from "../../tooling/replace-installed-preview.mjs";
import { isPromotionLeaseHeld } from "../../tooling/promotion-lease.mjs";
const roots = [];
const originalCloses = new Set();
const unconfirmedHelpers = new Set();
function observe(child) {
  let stdout = "",
    stderr = "",
    failure;
  child.stdout.on("data", (part) => {
    stdout += part;
  });
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  child.once("error", (error) => {
    failure = error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      originalCloses.delete(closed);
      resolve({ code, signal, stdout, stderr, failure });
    });
  });
  originalCloses.add(closed);
  return { child, closed, output: () => stdout };
}
async function kernelLockHeld(file) {
  let handle;
  try {
    handle = await fs.open(file, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20);
    return false;
  } catch (error) {
    if (error.code === "EAGAIN") return true;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function waitFor(predicate, deadline = Date.now() + 5000) {
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw Error("REPLACEMENT_FIXTURE_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function exactProcess(pid, column) {
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", `${column}=`], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    encoding: "utf8",
    timeout: 1000,
  });
}
beforeEach(() => {
  // A failed original observation retains custody. Do not create another
  // native replacement fixture while that obligation is still unresolved.
  if (originalCloses.size || unconfirmedHelpers.size)
    throw Error("REPLACEMENT_PRIOR_NATIVE_UNCONFIRMED");
});
afterEach(async () => {
  if (originalCloses.size || unconfirmedHelpers.size)
    throw Error(`REPLACEMENT_FIXTURE_CLOSE_UNCONFIRMED:${roots.join(",")}`);
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
  await fs.mkdir(path.join(userData, "farol-state"), {
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
    schema: "farol.promotion-plan/1",
    operation: "applied",
    product: "Farol",
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

// Finder-installed baselines are not promotion receipts. The selected v3
// maintenance retains their exact record with the whole old updater namespace.
async function adoptedFixture() {
  const f = await fixture();
  const build = JSON.parse(
    await fs.readFile(
      path.join(f.oldApp, "Contents/Resources/app/build-identity.json"),
      "utf8",
    ),
  );
  const receipt = JSON.parse(f.oldReceipt);
  const baseline =
    JSON.stringify({
      schema: "farol.adopted-baseline/1",
      slot: f.oldApp,
      userData: f.userData,
      manifest: {
        schema: "farol.github-release/1",
        repository: "legrch/farol",
        product: build.product,
        bundleId: build.bundleId,
        version: build.version,
        buildVersion: build.buildVersion,
        sourceCommit: build.sourceCommit,
        sourceTreeDigest: build.sourceTreeDigest,
        buildId: build.buildId,
        sourceDirty: false,
        archiveSha256: "a".repeat(64),
        archiveName: `Farol-${build.version}-darwin-arm64.zip`,
        archiveSize: 100,
        platform: "darwin",
        arch: "arm64",
        channel: "owner-beta",
        signing: "unsigned",
        notarized: false,
        artifactSha256: receipt.artifactSha256,
      },
      adoptedAt: "2026-10-31T00:00:00Z",
    }) + "\n";
  await fs.unlink(f.oldApp + ".receipt.json");
  await fs.writeFile(path.join(f.updates, "adopted-baseline.json"), baseline, {
    mode: 0o600,
  });
  await fs.unlink(path.join(f.updates, "ready.json"));
  await fs.writeFile(
    path.join(f.updates, "last-update.json"),
    JSON.stringify({
      schema: "farol.ready-update/1",
      handle: "/unused-fixture-archive",
      manifest: { fixtureOnly: true },
      operation: null,
      helper: null,
      observedAt: "2026-10-31T00:00:00Z",
      phase: "rolled_back",
      runningBuildId: build.buildId,
    }),
    { mode: 0o600 },
  );
  f.selection = {
    ...f.selection,
    schema: "farol.installed-replacement-selection/3",
    installLocation: "legacy",
    baseline: "adopted",
    preserveUnconfirmedUpdates: true,
    candidateRoot: process.cwd(),
    snapshot: await snapshotInstalledReplacement(f.home, "legacy", "adopted"),
  };
  return { ...f, baseline };
}

describe("explicit replacement of an adopted baseline", () => {
  it("retains the exact adopted baseline and unconfirmed history without creating an old promotion receipt", async () => {
    const f = await adoptedFixture();
    const originalLast = await fs.readFile(
      path.join(f.updates, "last-update.json"),
    );
    const result = await replaceInstalledPreview(f.selection, true, f.deps);
    expect(result.operation).toBe("completed");
    expect(result.historicalOperationsReconciled).toBe(false);
    expect(
      await fs.readFile(
        path.join(f.custody, "installed-updates/adopted-baseline.json"),
        "utf8",
      ),
    ).toBe(f.baseline);
    expect(
      await fs.readFile(
        path.join(f.custody, "installed-updates/last-update.json"),
      ),
    ).toEqual(originalLast);
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
    await expect(
      fs.lstat(path.join(f.custody, "previous.receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const newReceipt = JSON.parse(
      await fs.readFile(f.oldApp + ".receipt.json", "utf8"),
    );
    expect(newReceipt.sourceCommit).toBe(f.artifact.sourceCommit);
    expect(newReceipt.verifiedDestinationSha256).toBe(
      f.artifact.artifactSha256,
    );
    await expect(
      fs.lstat(
        path.join(f.userData, "farol-state/installed-replacement.pending"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["slot", "digest", "build", "null", "malformed"])(
    "refuses an invalid adopted baseline (%s) before effects",
    async (kind) => {
      const f = await adoptedFixture();
      const raw = JSON.parse(f.baseline);
      if (kind === "slot") raw.slot += ".foreign";
      if (kind === "digest") raw.manifest.artifactSha256 = "0".repeat(64);
      if (kind === "build") raw.manifest.buildId = "0".repeat(64);
      await fs.writeFile(
        path.join(f.updates, "adopted-baseline.json"),
        kind === "null"
          ? "null"
          : kind === "malformed"
            ? "{"
            : JSON.stringify(raw),
      );
      await expect(
        snapshotInstalledReplacement(f.home, "legacy", "adopted"),
      ).rejects.toThrow();
      await expect(fs.lstat(f.custody)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses simultaneous normal and adopted baselines", async () => {
    const f = await adoptedFixture();
    await fs.writeFile(f.oldApp + ".receipt.json", f.oldReceipt, {
      mode: 0o600,
    });
    await expect(
      snapshotInstalledReplacement(f.home, "legacy", "adopted"),
    ).rejects.toThrow("REPLACEMENT_PENDING_OR_COLLISION");
  });

  it("requires explicit selection of an original helper even for a single retained record", async () => {
    const f = await adoptedFixture();
    const file = path.join(f.updates, "last-update.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.helper = { pid: 2, processStart: "fixture original start" };
    await fs.writeFile(file, JSON.stringify(record));
    f.selection.snapshot = await snapshotInstalledReplacement(
      f.home,
      "legacy",
      "adopted",
    );
    await expect(
      replaceInstalledPreview(f.selection, false, f.deps),
    ).rejects.toThrow("REPLACEMENT_HELPER_SELECTION_MISSING");
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["bytes", "inode"])(
    "refuses adopted baseline %s drift after snapshot",
    async (kind) => {
      const f = await adoptedFixture();
      const file = path.join(f.updates, "adopted-baseline.json");
      if (kind === "bytes") await fs.appendFile(file, "\n");
      else {
        await fs.rename(file, file + ".retained");
        await fs.writeFile(file, f.baseline, { mode: 0o600 });
        await fs.unlink(file + ".retained");
      }
      await expect(
        replaceInstalledPreview(f.selection, false, f.deps),
      ).rejects.toThrow("REPLACEMENT_SNAPSHOT_CHANGED");
      await expect(fs.lstat(f.custody)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("one-shot installed replacement", () => {
  it("prepares only an empty real updater mutex after confirmed closed-app admission", async () => {
    const f = await fixture();
    for (const item of await fs.readdir(f.updates))
      await fs.rm(path.join(f.updates, item), { recursive: true });
    const result = await prepareCleanReplacementLock(
      f.home,
      f.artifact.buildId,
      "legacy",
      { processProof: () => {} },
    );
    expect(result.status).toBe("created");
    expect(await fs.readFile(path.join(f.updates, "lock"), "utf8")).toBe("");
    expect(await kernelLockHeld(path.join(f.updates, "lock"))).toBe(false);
    expect(await isPromotionLeaseHeld(f.userData)).toBe(false);
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
  });
  it("refuses to initialize an absent updater mutex over historical records", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.updates, "lock"));
    await expect(
      prepareCleanReplacementLock(f.home, f.artifact.buildId, "legacy", {
        processProof: () => {},
      }),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(f.updates, "lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await isPromotionLeaseHeld(f.userData)).toBe(false);
  });
  it("selects only an explicit shared installation while retaining the legacy default", () => {
    expect(replacementApplications("/Users/owner")).toBe(
      "/Users/owner/Applications",
    );
    expect(replacementApplications("/Users/owner", "shared")).toBe(
      "/Applications",
    );
    expect(() => replacementApplications("/Users/owner", "/foreign")).toThrow(
      "REPLACEMENT_LOCATION_INVALID",
    );
  });
  it("refuses a shared selector on the frozen version 1 selection before effects", async () => {
    const f = await fixture();
    await expect(
      replaceInstalledPreview(
        { ...f.selection, installLocation: "shared" },
        false,
        f.deps,
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts a version 2 legacy selection and retains accepted execution images with a clean updater", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.updates, "ready.json"));
    await fs.rm(path.join(f.updates, "last-update.json"));
    await fs.rm(path.join(f.updates, "a".repeat(32)), { recursive: true });
    const image = path.join(f.updates, "installed-execution", "c".repeat(64));
    await fs.mkdir(image, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(image, "fixture.txt"),
      "synthetic execution image\n",
      { mode: 0o600 },
    );
    f.selection = {
      ...f.selection,
      schema: "farol.installed-replacement-selection/2",
      installLocation: "legacy",
      snapshot: await snapshotInstalledReplacement(f.home),
    };
    const result = await replaceInstalledPreview(f.selection, true, f.deps);
    expect(result.operation).toBe("completed");
    expect(
      await fs.readFile(
        path.join(
          f.custody,
          "installed-updates/installed-execution",
          "c".repeat(64),
          "fixture.txt",
        ),
        "utf8",
      ),
    ).toBe("synthetic execution image\n");
    expect(result.receipt.destination).toBe(f.oldApp);
  });
  it.each(["launch-Farol.app", "installed-execution"])(
    "refuses custody while an original process uses retained %s resources",
    async (kind) => {
      const f = await fixture();
      const retained =
        kind === "launch-Farol.app"
          ? path.join(f.updates, "d".repeat(32), kind)
          : path.join(f.updates, kind, "c".repeat(64), "Farol.app");
      await fs.mkdir(retained, { recursive: true, mode: 0o700 });
      const entry = path.join(retained, "probe.cjs");
      await fs.writeFile(
        entry,
        'process.stdout.write("READY"); setInterval(() => {}, 1000);',
        { mode: 0o600 },
      );
      f.selection.snapshot = await snapshotInstalledReplacement(f.home);
      delete f.deps.processProof;
      const original = observe(
        spawn(process.execPath, [entry], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        }),
      );
      try {
        await waitFor(() => original.output().includes("READY"));
        await expect(
          replaceInstalledPreview(f.selection, true, f.deps),
        ).rejects.toThrow("REPLACEMENT_PROCESS_ACTIVE");
        expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
          f.oldReceipt,
        );
        await expect(fs.lstat(f.custody)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.lstat(
            path.join(f.userData, "farol-state/installed-replacement.pending"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (
          original.child.exitCode === null &&
          original.child.signalCode === null
        )
          original.child.kill("SIGTERM");
        await original.closed;
      }
    },
  );

  it.each(["ready.json", "last-update.json", "both-with-history"])(
    "refuses missing update records (%s) while historical work remains",
    async (missing) => {
      const f = await fixture();
      for (const name of missing === "both-with-history"
        ? ["ready.json", "last-update.json"]
        : [missing])
        await fs.rm(path.join(f.updates, name));
      f.selection.snapshot = await snapshotInstalledReplacement(f.home);
      await expect(
        replaceInstalledPreview(f.selection, false, f.deps),
      ).rejects.toThrow("REPLACEMENT_UPDATE_RECEIPT_UNCONFIRMED");
      await expect(fs.lstat(f.custody)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
        f.oldReceipt,
      );
    },
  );
  it("keeps the complete local normal receipt schema identical to its runtime owner", async () => {
    const owner = await fs.readFile(
      new URL(
        "../../src/apps/desktop/installed-update-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const tooling = await fs.readFile(
      new URL("../../tooling/replace-installed-preview.mjs", import.meta.url),
      "utf8",
    );
    const ownerShape = owner.match(
      /^const PromotionReceipt = z\.strictObject\(\{[\s\S]*?^\}\);/mu,
    );
    const toolingShape = tooling.match(
      /^const NormalPromotionReceipt = z\.strictObject\(\{[\s\S]*?^\}\);/mu,
    );
    expect(ownerShape).not.toBeNull();
    expect(toolingShape).not.toBeNull();
    expect(
      toolingShape[0].replace("NormalPromotionReceipt", "PromotionReceipt"),
    ).toBe(ownerShape[0]);
    expect(tooling.match(/^const Digest = .*;$/mu)?.[0]).toBe(
      owner.match(/^const Digest = .*;$/mu)?.[0],
    );
  });

  describe.each([false, true])(
    "normal receipt admission in apply=%s",
    (apply) => {
      it.each([
        [
          "missing product",
          (r) => {
            delete r.product;
          },
        ],
        [
          "foreign product",
          (r) => {
            r.product = "Foreign Preview";
          },
        ],
        [
          "unknown outer field",
          (r) => {
            r.repairAuthority = true;
          },
        ],
        [
          "unknown nested field",
          (r) => {
            r.activation.recovery = true;
          },
        ],
        [
          "invalid source type",
          (r) => {
            r.source = { path: r.source };
          },
        ],
        [
          "oversized source",
          (r) => {
            r.source = "x".repeat(4097);
          },
        ],
        [
          "missing source",
          (r) => {
            delete r.source;
          },
        ],
        [
          "missing required activation",
          (r) => {
            delete r.activation.drained;
          },
        ],
        [
          "nonempty obligations",
          (r) => {
            r.activation.obligations = ["unknown"];
          },
        ],
        ["malformed JSON", () => "{"],
        ["null receipt", () => "null"],
      ])(
        "refuses %s before custody or placement and preserves every original byte",
        async (_name, change) => {
          const f = await fixture();
          const receipt = JSON.parse(f.oldReceipt);
          const replacement = change(receipt);
          const raw = Buffer.from(
            replacement ?? JSON.stringify(receipt, null, 2) + "\n",
          );
          await fs.writeFile(f.oldApp + ".receipt.json", raw);
          // Bind the selected bytes too: refusal must be strict receipt admission,
          // not merely the older receipt digest becoming stale.
          f.selection.snapshot.receiptSha256 = createHash("sha256")
            .update(raw)
            .digest("hex");
          const appsDigest = await treeDigest(f.apps);
          const updatesDigest = await treeDigest(f.updates);
          let nativeCalls = 0,
            placementCalls = 0;
          f.deps.native = async () => {
            nativeCalls++;
            throw Error("unexpected native effect");
          };
          f.deps.promotion = async () => {
            placementCalls++;
            throw Error("unexpected placement effect");
          };
          await expect(snapshotInstalledReplacement(f.home)).rejects.toThrow(
            "REPLACEMENT_NORMAL_RECEIPT_UNCONFIRMED",
          );
          await expect(
            replaceInstalledPreview(f.selection, apply, f.deps),
          ).rejects.toThrow("REPLACEMENT_NORMAL_RECEIPT_UNCONFIRMED");
          expect(nativeCalls).toBe(0);
          expect(placementCalls).toBe(0);
          expect(await fs.readFile(f.oldApp + ".receipt.json")).toEqual(raw);
          expect(await treeDigest(f.apps)).toBe(appsDigest);
          expect(await treeDigest(f.updates)).toBe(updatesDigest);
          await expect(fs.lstat(f.custody)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(
            fs.lstat(
              path.join(
                f.userData,
                "farol-state/installed-replacement.pending",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(await isPromotionLeaseHeld(f.userData)).toBe(false);
          expect(await kernelLockHeld(path.join(f.updates, "lock"))).toBe(
            false,
          );
          if (!apply)
            await expect(
              fs.lstat(path.join(f.userData, "farol-state/promotion.lease")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    },
  );

  it("plans without intent, custody, lock creation or app mutation", async () => {
    const f = await fixture();
    const result = await replaceInstalledPreview(f.selection, false, f.deps);
    expect(result.operation).toBe("plan-only");
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(f.userData, "farol-state/promotion.lease")),
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
          path.join(f.userData, "farol-state/installed-replacement.pending"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each([false, true])(
    "refuses oversized intent before any native child in apply=%s",
    async (apply) => {
      const f = await fixture();
      const op = path.join(f.updates, "a".repeat(32));
      // Immediate metadata exceeds the native record cap; no archive contents.
      for (let i = 0; i < 280; i += 1)
        await fs.mkdir(path.join(op, `${"é".repeat(90)}-${i}`), {
          mode: 0o700,
        });
      f.selection.snapshot = await snapshotInstalledReplacement(f.home);
      const metadata = JSON.stringify(f.selection.snapshot);
      expect(metadata.length).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(metadata, "utf8")).toBeGreaterThanOrEqual(
        64 * 1024,
      );
      let placementCalled = false,
        nativeCalled = false;
      f.deps.native = async () => {
        nativeCalled = true;
      };
      f.deps.promotion = async () => {
        placementCalled = true;
      };
      await expect(
        replaceInstalledPreview(f.selection, apply, f.deps),
      ).rejects.toThrow("REPLACEMENT_INTENT_TOO_LARGE");
      expect(placementCalled).toBe(false);
      expect(nativeCalled).toBe(false);
      await expect(fs.lstat(f.custody)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.lstat(
          path.join(f.userData, "farol-state/installed-replacement.pending"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
        f.oldReceipt,
      );
      expect(await treeDigest(f.oldApp)).toBe(f.selection.snapshot.appSha256);
      // No effectsStarted retention interval or unresolved original child exists.
      expect(await isPromotionLeaseHeld(f.userData)).toBe(false);
      const lock = await fs.open(
        path.join(f.updates, "lock"),
        C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
      );
      await lock.close();
    },
  );
  it("keeps both original lock inodes held by the genuine placement child after exact owner death", async () => {
    const f = await fixture();
    const packet = path.join(f.r, "fixture.json");
    await fs.writeFile(
      packet,
      JSON.stringify({ selection: f.selection, deps: f.deps }),
      { mode: 0o600 },
    );
    const runner = path.join(f.r, "owner.mjs");
    const producerUrl = new URL(
      "../../tooling/replace-installed-preview.mjs",
      import.meta.url,
    ).href;
    const promotionUrl = new URL(
      "../../tooling/promotion-apply.mjs",
      import.meta.url,
    ).href;
    // This is the real producer and unmodified, hash-pinned placement helper.
    // Only package/source/process proofs are synthetic. The ordinary helper's
    // existing pre-effect hook gives a deterministic pause, not a copy fault.
    await fs.writeFile(
      runner,
      `
import fs from "node:fs/promises";
import { replaceInstalledPreview } from ${JSON.stringify(producerUrl)};
import { runPromotionApply } from ${JSON.stringify(promotionUrl)};
const { selection, deps } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
deps.sourceIdentity = () => ({ commit: deps.artifact.sourceCommit, treeDigest: deps.artifact.sourceTreeDigest, dirty: false });
deps.verify = async () => {};
deps.processProof = () => {};
deps.promotion = (options) => runPromotionApply({ ...options, onChildStarted: (closed, identity) => {
  options.onChildStarted(closed);
  process.send({ kind: "placement-child-started", pid: identity.pid });
}, afterParentOpened: async () => {
  await options.afterParentOpened();
  process.send({ kind: "placement-child-waiting" });
  await new Promise(() => {});
}});
await replaceInstalledPreview(selection, true, deps);
`,
      { mode: 0o600 },
    );
    const owner = observe(
      spawn(process.execPath, [runner, packet], {
        cwd: process.cwd(),
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    );
    const messages = [];
    let helperPid,
      watcher,
      helperExited = false;
    owner.child.on("message", (message) => {
      messages.push(message);
      if (message.kind === "placement-child-started") {
        helperPid = message.pid;
        unconfirmedHelpers.add(f.r);
      }
    });
    try {
      await waitFor(() =>
        messages.some((message) => message.kind === "placement-child-waiting"),
      );
      expect(
        messages.filter(
          (message) => message.kind === "placement-child-started",
        ),
      ).toHaveLength(1);
      expect(Number.isSafeInteger(helperPid) && helperPid > 1).toBe(true);
      const command = exactProcess(helperPid, "command");
      expect(command.status).toBe(0);
      expect(command.stderr).toBe("");
      expect(command.stdout.trim()).toMatch(/[Pp]ython3? -I -S -B -$/u);
      const initialStart = exactProcess(helperPid, "lstart").stdout;
      process.kill(helperPid, "SIGSTOP");
      await waitFor(() =>
        exactProcess(helperPid, "state").stdout.trim().startsWith("T"),
      );
      // Register a native NOTE_EXIT watcher while the exact original child is
      // stopped/alive. Its kernel exit event is terminal proof, not PID absence.
      watcher = observe(
        spawn(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            String.raw`
import os, select, sys
pid = int(sys.argv[1])
kq = select.kqueue()
kq.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)], 0, 0)
os.write(1, b"WATCHING\n")
events = kq.control(None, 1, 10)
if len(events) != 1 or events[0].ident != pid or not events[0].fflags & select.KQ_NOTE_EXIT:
    raise SystemExit(1)
os.write(1, b"EXIT\n")
`,
            String(helperPid),
          ],
          {
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      await waitFor(() => watcher.output() === "WATCHING\n");
      expect(await isPromotionLeaseHeld(f.userData)).toBe(true);
      const promotionFile = path.join(
        f.userData,
        "farol-state/promotion.lease",
      );
      const updaterFile = path.join(f.custody, "installed-updates/lock");

      const promotionBefore = await fs.lstat(promotionFile, { bigint: true });
      process.kill(owner.child.pid, "SIGKILL");
      expect(await owner.closed).toMatchObject({
        code: null,
        signal: "SIGKILL",
        stderr: "",
        failure: undefined,
      });
      expect(exactProcess(helperPid, "lstart").stdout).toBe(initialStart);
      expect(
        exactProcess(helperPid, "state").stdout.trim().startsWith("T"),
      ).toBe(true);
      const files = [
        [
          promotionFile,
          [String(promotionBefore.dev), String(promotionBefore.ino)],
        ],
        [updaterFile, f.selection.snapshot.updaterLockIdentity],
      ];
      for (const [file, expected] of files) {
        const named = await fs.lstat(file, { bigint: true });
        expect([String(named.dev), String(named.ino)]).toEqual(expected);
        expect(await kernelLockHeld(file)).toBe(true);
      }
      expect(watcher.output()).toBe("WATCHING\n");
      // Parent pipes closed on death. Resuming this original child makes its
      // hook refuse EOF and close; no replacement or replay child is started.
      process.kill(helperPid, "SIGCONT");
      const exit = await watcher.closed;
      if (
        exit.code === 0 &&
        exit.stdout === "WATCHING\nEXIT\n" &&
        !exit.stderr &&
        !exit.failure
      ) {
        helperExited = true;
        unconfirmedHelpers.delete(f.r);
      }
      expect(exit).toEqual({
        code: 0,
        signal: null,
        stdout: "WATCHING\nEXIT\n",
        stderr: "",
        failure: undefined,
      });
      for (const [file, expected] of files) {
        const lock = await fs.open(
          file,
          C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
        );
        try {
          const opened = await lock.stat({ bigint: true });
          expect([String(opened.dev), String(opened.ino)]).toEqual(expected);
        } finally {
          await lock.close();
        }
      }
      expect(
        (
          await fs.lstat(
            path.join(f.userData, "farol-state/installed-replacement.pending"),
          )
        ).isFile(),
      ).toBe(true);
      await expect(fs.lstat(f.oldApp)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await fs.readFile(
          path.join(f.custody, "previous.receipt.json"),
          "utf8",
        ),
      ).toBe(f.oldReceipt);
    } finally {
      if (owner.child.exitCode === null && owner.child.signalCode === null)
        owner.child.kill("SIGKILL");
      await owner.closed;
      if (helperPid && !helperExited) {
        // Exact fixture child only; use the already-registered exit observer.
        try {
          process.kill(helperPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (watcher) {
          const exit = await watcher.closed;
          if (
            exit.code !== 0 ||
            exit.stdout !== "WATCHING\nEXIT\n" ||
            exit.stderr
          )
            throw Error("REPLACEMENT_FIXTURE_HELPER_EXIT_UNCONFIRMED");
          unconfirmedHelpers.delete(f.r);
        } else throw Error("REPLACEMENT_FIXTURE_HELPER_EXIT_UNCONFIRMED");
      }
    }
  }, 15000);
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
    expect(receipt.schema).toBe("farol.promotion-plan/1");
    expect(receipt.sourceCommit).toBe(f.artifact.sourceCommit);
    await expect(
      fs.lstat(
        path.join(f.userData, "farol-state/installed-replacement.pending"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(
    [
      "partial-intent",
      "custody-substituted-before-open",
      "retirement-and-uncertainty",
      "placement-lost-result",
      "completion-lost-result",
      "app-displaced-during-digest",
      "receipt-displaced-during-digest",
      "custody-displaced-during-digest",
      "app-displaced-after-retirement",
    ]
      .map((fault) => [fault, false])
      .concat([
        ["partial-intent", true],
        ["placement-lost-result", true],
        ["completion-lost-result", true],
      ]),
  )(
    "retains both original locks and live owner after %s (adopted=%s), regardless of pending presence after original child close",
    async (fault, adopted) => {
      // Observe within this case's existing 15 s lifetime budget. A separate
      // 5 s poll deadline could kill the owner before its original native
      // child reported closure on a loaded host. Leave 1 s for assertions.
      const observationDeadline = Date.now() + 14_000;
      const f = adopted ? await adoptedFixture() : await fixture();
      if (fault === "custody-substituted-before-open")
        await fs.chmod(f.oldApp, 0o700);
      const packet = path.join(f.r, "fault-fixture.json");
      await fs.writeFile(
        packet,
        JSON.stringify({ selection: f.selection, deps: f.deps }),
        { mode: 0o600 },
      );
      const runner = path.join(f.r, "fault-owner.mjs");
      const producerUrl = new URL(
        "../../tooling/replace-installed-preview.mjs",
        import.meta.url,
      ).href;
      const promotionUrl = new URL(
        "../../tooling/promotion-apply.mjs",
        import.meta.url,
      ).href;
      const leaseUrl = new URL(
        "../../tooling/promotion-lease.mjs",
        import.meta.url,
      ).href;
      const helperFile = new URL(
        "../../tooling/replace-installed-preview.py",
        import.meta.url,
      ).pathname;
      const libraryFile = new URL(
        "../../tooling/promotion-apply.py",
        import.meta.url,
      ).pathname;
      // Code-attested fixture only. It executes exact hash-pinned helper bytes
      // with two local fsync faults; the CLI has no seam/flag to select this.
      const prefix = String.raw`
import errno, os, stat
real_sync = os.fsync
retirement_failed = False
custody_substituted = False
state = STATE_PATH
pending = os.path.join(state, "installed-replacement.pending")
retired = RETIRED_PATH
fault = FAULT_KIND
def fault_sync(fd):
    global retirement_failed, custody_substituted
    info = os.fstat(fd)
    if fault == "custody-substituted-before-open" and not custody_substituted and stat.S_ISDIR(info.st_mode) and os.path.exists(custody_path) and os.path.exists(installed_app) and os.path.exists(pending):
        named_apps = os.stat(os.path.dirname(installed_app), follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named_apps.st_dev, named_apps.st_ino):
            custody_substituted = True
            os.rename(custody_path, custody_path + ".allocated")
            os.rename(installed_app, custody_path)
            os.write(9, b"PUBLIC_CUSTODY_SUBSTITUTED\n")
    if fault == "app-displaced-after-retirement" and stat.S_ISDIR(info.st_mode) and os.path.exists(retired):
        named_state = os.stat(state, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named_state.st_dev, named_state.st_ino) and os.path.exists(installed_app):
            os.rename(installed_app, installed_app + ".displaced")
            os.write(9, b"NAMED_APP_DISPLACED_AFTER_RETIREMENT\n")
    if fault == "partial-intent" and stat.S_ISREG(info.st_mode) and os.path.exists(pending):
        named = os.stat(pending, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino):
            os.write(9, b"INITIAL_INTENT_FILE_FSYNC_FAILED\n")
            raise OSError(errno.EIO, "fixture initial intent fsync")
    if fault == "retirement-and-uncertainty" and stat.S_ISDIR(info.st_mode) and os.path.exists(retired):
        named = os.stat(state, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino):
            if not retirement_failed and not os.path.lexists(pending):
                retirement_failed = True
                os.write(9, b"RETIREMENT_DIRECTORY_FSYNC_FAILED\n")
                raise OSError(errno.EIO, "fixture retirement fsync")
            if retirement_failed and os.path.lexists(pending):
                os.write(9, b"UNCERTAINTY_DIRECTORY_FSYNC_FAILED\n")
                raise OSError(errno.EIO, "fixture uncertainty fsync")
    return real_sync(fd)
os.fsync = fault_sync
real_listdir = os.listdir
displaced = False
installed_app = INSTALLED_APP
custody_path = CUSTODY_PATH
installed_receipt = installed_app + ".receipt.json"
def fault_listdir(fd):
    global displaced
    if not displaced and isinstance(fd, int) and fault in ("app-displaced-during-digest", "receipt-displaced-during-digest", "custody-displaced-during-digest"):
        info = os.fstat(fd)
        named = os.stat(installed_app, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino):
            displaced = True
            if fault == "app-displaced-during-digest":
                os.rename(installed_app, installed_app + ".displaced")
                os.write(9, b"NAMED_APP_DISPLACED\n")
            elif fault == "custody-displaced-during-digest":
                os.rename(custody_path, custody_path + ".displaced")
                os.write(9, b"NAMED_CUSTODY_DISPLACED\n")
            else:
                with open(installed_receipt, "rb") as original:
                    raw = original.read()
                os.rename(installed_receipt, installed_receipt + ".displaced")
                replacement = os.open(installed_receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.write(replacement, raw)
                    os.fsync(replacement)
                finally:
                    os.close(replacement)
                os.write(9, b"NEW_RECEIPT_DISPLACED\n")
    return real_listdir(fd)
os.listdir = fault_listdir
`;
      const nativePrefix = prefix
        .replace(
          "STATE_PATH",
          JSON.stringify(path.join(f.userData, "farol-state")),
        )
        .replace(
          "RETIRED_PATH",
          JSON.stringify(path.join(f.custody, "completed-intent.json")),
        )
        .replace("FAULT_KIND", JSON.stringify(fault))
        .replace("INSTALLED_APP", JSON.stringify(f.oldApp))
        .replace("CUSTODY_PATH", JSON.stringify(f.custody));
      await fs.writeFile(
        runner,
        `
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { replaceInstalledPreview, runReplacementNative } from ${JSON.stringify(producerUrl)};
import { runPromotionApply } from ${JSON.stringify(promotionUrl)};
import { promotionLeaseDescriptor } from ${JSON.stringify(leaseUrl)};
const { selection, deps } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
deps.sourceIdentity = () => ({ commit: deps.artifact.sourceCommit, treeDigest: deps.artifact.sourceTreeDigest, dirty: false });
deps.verify = async () => {};
deps.processProof = () => {};
const fault = ${JSON.stringify(fault)};
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
deps.native = async (request, lease, updater, register) => {
  if (fault === "completion-lost-result") {
    const result = await runReplacementNative(request, lease, updater, register);
    if (request.action === "complete") {
      process.send({ kind: "original-completion-child-closed" });
      throw Error("FIXTURE_COMPLETION_RESULT_LOST");
    }
    return result;
  }
  if ((["partial-intent", "custody-substituted-before-open"].includes(fault) && request.action !== "custody") ||
      (!["partial-intent", "custody-substituted-before-open"].includes(fault) && request.action !== "complete") ||
      fault === "placement-lost-result")
    return runReplacementNative(request, lease, updater, register);
  const helper = await fs.readFile(${JSON.stringify(helperFile)});
  const library = await fs.readFile(${JSON.stringify(libraryFile)});
  if (sha(helper) !== "08212da5ae0b8b4a78692aea01acc9ea74c5148eb67b761475fcb765e1e59997" ||
      sha(library) !== "be78ebefca9280329b766c0aee9dbfdd9adfdab2020f373df236441fdb476ec6")
    throw Error("FIXTURE_HELPER_ATTESTATION_FAILED");
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "ignore", "ignore", promotionLeaseDescriptor(lease), updater.fd, "pipe", "pipe"],
  });
  let stdout = "", stderr = "", failure;
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  child.stdio[9].on("data", (part) => process.send({ kind: "fixture-native-fault", text: part.toString("utf8") }));
  child.once("error", (error) => { failure = error; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  register(closed);
  for (const stream of [child.stdin, child.stdio[3], child.stdio[8]]) stream.on("error", (error) => { failure = error; });
  child.stdin.end(Buffer.concat([Buffer.from(${JSON.stringify(nativePrefix)}), helper]));
  child.stdio[8].end(library);
  child.stdio[3].end(JSON.stringify(request));
  const outcome = await closed;
  process.send({ kind: "original-native-child-closed", outcome, stderr, stdout });
  if (failure || outcome.code !== 0 || outcome.signal || stderr)
    throw Error(stderr.trim() || "FIXTURE_NATIVE_FAILURE");
  return JSON.parse(stdout);
};
if (fault === "placement-lost-result") deps.promotion = async (options) => {
  await runPromotionApply(options);
  process.send({ kind: "original-placement-child-closed" });
  throw Error("FIXTURE_PLACEMENT_RESULT_LOST");
};
try { await replaceInstalledPreview(selection, true, deps); }
catch (error) { process.send({ kind: "replacement-failed", message: error.message }); }
`,
        { mode: 0o600 },
      );
      const owner = observe(
        spawn(process.execPath, [runner, packet], {
          cwd: process.cwd(),
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        }),
      );
      const messages = [];
      unconfirmedHelpers.add(f.r);
      owner.child.on("message", (message) => {
        messages.push(message);
        if (
          message.kind === "original-native-child-closed" ||
          message.kind === "original-placement-child-closed" ||
          message.kind === "original-completion-child-closed"
        )
          unconfirmedHelpers.delete(f.r);
      });
      try {
        await waitFor(
          () =>
            messages.some((message) => message.kind === "replacement-failed"),
          observationDeadline,
        );
        expect(owner.child.exitCode).toBe(null);
        expect(owner.child.signalCode).toBe(null);
        const pending = path.join(
          f.userData,
          "farol-state/installed-replacement.pending",
        );
        if (fault === "completion-lost-result")
          await expect(fs.lstat(pending)).rejects.toMatchObject({
            code: "ENOENT",
          });
        else expect((await fs.lstat(pending)).isFile()).toBe(true);
        const text = messages
          .filter((message) => message.kind === "fixture-native-fault")
          .map((message) => message.text)
          .join("");
        if (fault === "partial-intent") {
          expect(text).toBe("INITIAL_INTENT_FILE_FSYNC_FAILED\n");
          expect(await treeDigest(f.oldApp)).toBe(
            f.selection.snapshot.appSha256,
          );
          expect(
            await fs.readFile(
              adopted
                ? path.join(f.updates, "adopted-baseline.json")
                : f.oldApp + ".receipt.json",
              "utf8",
            ),
          ).toBe(adopted ? f.baseline : f.oldReceipt);
          await expect(fs.lstat(f.custody)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else if (fault === "custody-substituted-before-open") {
          expect(text).toBe("PUBLIC_CUSTODY_SUBSTITUTED\n");
          expect(await treeDigest(f.custody)).toBe(
            f.selection.snapshot.appSha256,
          );
          await expect(
            fs.lstat(path.join(f.custody, "intent.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            (
              await fs.lstat(path.join(f.custody + ".allocated", "intent.json"))
            ).isFile(),
          ).toBe(true);
        } else if (
          fault === "app-displaced-during-digest" ||
          fault === "receipt-displaced-during-digest" ||
          fault === "custody-displaced-during-digest" ||
          fault === "app-displaced-after-retirement"
        ) {
          const displacedApp =
            fault === "app-displaced-during-digest" ||
            fault === "app-displaced-after-retirement";
          expect(
            await treeDigest(displacedApp ? f.oldApp + ".displaced" : f.oldApp),
          ).toBe(f.artifact.artifactSha256);
          const tokens = {
            "app-displaced-during-digest": "NAMED_APP_DISPLACED\n",
            "receipt-displaced-during-digest": "NEW_RECEIPT_DISPLACED\n",
            "custody-displaced-during-digest": "NAMED_CUSTODY_DISPLACED\n",
            "app-displaced-after-retirement":
              "NAMED_APP_DISPLACED_AFTER_RETIREMENT\n",
          };
          expect(text).toBe(tokens[fault]);
          const pendingRecord = JSON.parse(await fs.readFile(pending, "utf8"));
          if (fault === "app-displaced-after-retirement") {
            expect(pendingRecord.schema).toBe(
              "farol.installed-replacement-unknown/1",
            );
            expect(
              (
                await fs.lstat(path.join(f.custody, "completed-intent.json"))
              ).isFile(),
            ).toBe(true);
          } else {
            expect(pendingRecord.operationId).toBe(f.selection.operationId);
            await expect(
              fs.lstat(
                path.join(
                  fault === "custody-displaced-during-digest"
                    ? f.custody + ".displaced"
                    : f.custody,
                  "completed-intent.json",
                ),
              ),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
        } else {
          expect(await treeDigest(f.oldApp)).toBe(f.artifact.artifactSha256);
          if (fault === "retirement-and-uncertainty") {
            expect(text).toBe(
              "RETIREMENT_DIRECTORY_FSYNC_FAILED\nUNCERTAINTY_DIRECTORY_FSYNC_FAILED\n",
            );
            expect(
              messages.find((message) => message.kind === "replacement-failed")
                .message,
            ).toBe("REPLACEMENT_COMPLETION_AND_FENCE_UNKNOWN");
            expect(JSON.parse(await fs.readFile(pending, "utf8")).schema).toBe(
              "farol.installed-replacement-unknown/1",
            );
          } else
            expect(
              messages.some(
                (message) =>
                  message.kind ===
                  (fault === "completion-lost-result"
                    ? "original-completion-child-closed"
                    : "original-placement-child-closed"),
              ),
            ).toBe(true);
        }
        if (
          fault !== "placement-lost-result" &&
          fault !== "completion-lost-result"
        ) {
          const closed = messages.find(
            (message) => message.kind === "original-native-child-closed",
          );
          expect(closed.outcome).toEqual({ code: 1, signal: null });
          expect(closed.stderr).toMatch(/^REPLACEMENT_[A-Z_]+\n$/u);
        }
        const lockFile = path.join(
          ["partial-intent", "custody-substituted-before-open"].includes(fault)
            ? f.updates
            : path.join(
                fault === "custody-displaced-during-digest"
                  ? f.custody + ".displaced"
                  : f.custody,
                "installed-updates",
              ),
          "lock",
        );
        const named = await fs.lstat(lockFile, { bigint: true });
        expect([String(named.dev), String(named.ino)]).toEqual(
          f.selection.snapshot.updaterLockIdentity,
        );
        expect(await kernelLockHeld(lockFile)).toBe(true);
        expect(
          await kernelLockHeld(
            path.join(f.userData, "farol-state/promotion.lease"),
          ),
        ).toBe(true);
        process.kill(owner.child.pid, "SIGKILL");
        const exit = await owner.closed;
        expect(exit.signal).toBe("SIGKILL");
        expect(exit.stderr).toBe(
          "REPLACEMENT_UNKNOWN_RETAINS_LOCKS_OWNER_REQUIRED\n",
        );
        expect(await kernelLockHeld(lockFile)).toBe(false);
        expect(
          await kernelLockHeld(
            path.join(f.userData, "farol-state/promotion.lease"),
          ),
        ).toBe(false);
      } finally {
        if (unconfirmedHelpers.has(f.r)) {
          // Keep the original owner, locks and files. A timeout is not proof
          // that its native child stopped, so do not signal the owner away.
          await fs.writeFile(
            path.join(f.r, "unconfirmed-test-owner.json"),
            JSON.stringify({
              schema: 1,
              ownerPid: owner.child.pid,
              fault,
              originalNativeTerminal: "unknown",
            }) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          throw Error("REPLACEMENT_FIXTURE_NATIVE_CLOSE_UNCONFIRMED");
        }
        if (owner.child.exitCode === null && owner.child.signalCode === null)
          owner.child.kill("SIGKILL");
        await owner.closed;
      }
    },
    15000,
  );
});
async function completedUpdateFixture() {
  const f = await fixture();
  const build = JSON.parse(
    await fs.readFile(
      path.join(f.oldApp, "Contents/Resources/app/build-identity.json"),
      "utf8",
    ),
  );
  const previousBuild = createBuildIdentity({
    version: "0.2.0-owner.beta.4",
    buildVersion: "18",
    updateChannel: "github-owner-beta",
    builtAt: "2026-10-10T00:00:00.000Z",
    sourceCommit: "4".repeat(40),
    sourceTreeDigest: "4".repeat(64),
    sourceDirty: false,
  });
  const directory = path.join(f.updates, "c".repeat(32));
  const previous = path.join(directory, "previous.app");
  await fs.mkdir(path.join(previous, "Contents/Resources/app"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(previous, "Contents/Resources/app/build-identity.json"),
    JSON.stringify(previousBuild),
    { mode: 0o644 },
  );
  const previousDigest = await treeDigest(previous);
  const initial = JSON.parse(f.oldReceipt);
  Object.assign(initial, {
    version: previousBuild.version,
    sourceCommit: previousBuild.sourceCommit,
    sourceTreeDigest: previousBuild.sourceTreeDigest,
    artifactSha256: previousDigest,
    verifiedDestinationSha256: previousDigest,
  });
  f.oldReceipt = JSON.stringify(initial) + "\n";
  await fs.writeFile(f.oldApp + ".receipt.json", f.oldReceipt);
  const operation = {
    operationId: "c".repeat(32),
    source: {
      digest: previousDigest,
      version: previousBuild.version,
      buildId: previousBuild.buildId,
    },
    target: {
      digest: await treeDigest(f.oldApp),
      version: build.version,
      buildId: build.buildId,
    },
  };
  const manifest = {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: build.product,
    bundleId: build.bundleId,
    version: build.version,
    buildVersion: build.buildVersion,
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    buildId: build.buildId,
    artifactSha256: operation.target.digest,
    archiveSha256: "a".repeat(64),
    archiveName: "fixture.zip",
    archiveSize: 1024,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  };
  const saved = {
    schema: "farol.ready-update/1",
    handle: path.join(f.updates, "fixture.zip"),
    manifest,
    operation,
    observedAt: "2026-10-10T00:00:00.000Z",
    phase: "completed",
    runningBuildId: build.buildId,
  };
  const journal = {
    ...operation,
    schema: "farol.installed-update-journal/1",
    phase: "completed",
  };
  await fs.writeFile(
    path.join(f.updates, "last-update.json"),
    JSON.stringify(saved),
  );
  await fs.writeFile(
    path.join(directory, "journal.json"),
    JSON.stringify(journal),
    { mode: 0o600 },
  );
  f.selection.snapshot = await snapshotInstalledReplacement(f.home);
  return { ...f, saved, journal, directory, previous };
}

describe("closed replacement after ordinary OTA", () => {
  it("retains the original promotion receipt and completed update chain", async () => {
    const f = await completedUpdateFixture();
    const result = await replaceInstalledPreview(f.selection, true, f.deps);
    expect(result.operation).toBe("completed");
    expect(
      await fs.readFile(path.join(f.custody, "previous.receipt.json"), "utf8"),
    ).toBe(f.oldReceipt);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(f.custody, "installed-updates/last-update.json"),
          "utf8",
        ),
      ),
    ).toEqual(f.saved);
    expect(await treeDigest(path.join(f.custody, "previous.app"))).toBe(
      f.selection.snapshot.appSha256,
    );
    expect(await treeDigest(f.oldApp)).toBe(f.artifact.artifactSha256);
  });
  it.each([
    "receipt-phase",
    "receipt-extra",
    "target",
    "manifest",
    "journal-phase",
    "journal-operation",
    "journal-note",
    "predecessor",
  ])("refuses %s without moving installed bytes", async (kind) => {
    const f = await completedUpdateFixture();
    if (kind === "receipt-phase") f.saved.phase = "launch_requested";
    if (kind === "receipt-extra") f.saved.unexpected = true;
    if (kind === "target") f.saved.operation.target.digest = "0".repeat(64);
    if (kind === "manifest") f.saved.manifest.sourceCommit = "0".repeat(40);
    if (kind === "journal-phase") f.journal.phase = "launch_requested";
    if (kind === "journal-operation") f.journal.operationId = "d".repeat(32);
    if (kind === "journal-note")
      f.journal.note = "predecessor_drain_unconfirmed";
    if (kind === "predecessor")
      await fs.writeFile(path.join(f.previous, "modified"), "changed");
    await fs.writeFile(
      path.join(f.updates, "last-update.json"),
      JSON.stringify(f.saved),
    );
    await fs.writeFile(
      path.join(f.directory, "journal.json"),
      JSON.stringify(f.journal),
    );
    await expect(snapshotInstalledReplacement(f.home)).rejects.toThrow();
    expect(await treeDigest(f.oldApp)).toBe(f.selection.snapshot.appSha256);
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses the owning updater's complete persisted DTO shapes", async () => {
    const owner = await fs.readFile(
      new URL(
        "../../src/apps/desktop/installed-update-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const tool = await fs.readFile(
      new URL("../../tooling/replace-installed-preview.mjs", import.meta.url),
      "utf8",
    );
    for (const name of [
      "AcceptedBuild",
      "Operation",
      "Retained",
      "Journal",
      "SavedReceipt",
    ]) {
      const pattern = new RegExp(
        "^const " + name + " = [\\s\\S]*?^\\}\\);",
        "m",
      );
      expect(tool.match(pattern)?.[0]).toBe(owner.match(pattern)?.[0]);
    }
  });
});
