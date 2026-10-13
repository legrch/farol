// Owner maintenance only. No launch, rollback, retry, profile copy or repair receipt.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { treeDigest } from "./artifact-digest.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import {
  candidatePaths,
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "./candidate-contract.mjs";
import { readArtifactManifest } from "./promote-preview.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import {
  activationObligations,
  assertActivationDrained,
  promotionUserData,
} from "./promotion-obligations.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
  promotionLeaseDescriptor,
} from "./promotion-lease.mjs";
import { runPromotionApply } from "./promotion-apply.mjs";
import { compareReleaseVersions } from "../src/modules/release/domain/github-version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_SHA256 =
  "748f3975397ad25c457e0d26db64ea8e60e1899343dadd7b475cc51cd86dd020";
const LIBRARY_SHA256 =
  "ca7871cf359faecc0ecba035ce1e49a2a689c964d50c6c27b36e9f519246aed2";
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
// Same normal receipt DTO as the installed-update owner; keep strict shape parity.
const NormalPromotionReceipt = z.strictObject({
  schema: z.literal("farol.next.promotion-plan/1"),
  operation: z.literal("applied"),
  product: z.literal("Farol Next Preview"),
  version: z.string().max(128),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: Digest,
  sourceDirty: z.literal(false),
  artifactSha256: Digest,
  source: z.string().max(4096),
  destination: z.string().max(4096),
  receipt: z.string().max(4096),
  overwrite: z.literal(false),
  legacyMutation: z.literal(false),
  activation: z.strictObject({
    userData: z.string().max(4096),
    drained: z.literal(true),
    obligations: z.array(z.never()).length(0),
  }),
  verifiedDestinationSha256: Digest,
});

// Strict persisted DTOs remain identical to the installed updater owner.
const AcceptedBuild = z.strictObject({
  digest: Digest,
  version: z.string().max(128),
  buildId: Digest,
});
const Operation = z.strictObject({
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  source: AcceptedBuild,
  target: AcceptedBuild,
});
const Retained = z.strictObject({
  schema: z.literal("farol.ready-update/1"),
  handle: z.string().max(4096),
  manifest: z.unknown(),
  notes: z.string().max(4096).optional(),
  operation: Operation.nullable(),
  downloadId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  preparation: Operation.optional(),
  archiveReleased: z.boolean().optional(),
  helper: z
    .strictObject({
      pid: z.number().int().min(2),
      processStart: z.string().min(1).max(128).nullable(),
    })
    .nullable()
    .optional(),
});
const Journal = Operation.extend({
  schema: z.literal("farol.installed-update-journal/1"),
  phase: z.enum([
    "prepared",
    "predecessor_saved",
    "new_installed",
    "verified",
    "rollback_started",
    "rolled_back",
    "launch_requested",
    "completed",
    "cancelled",
    "cancel_launch_requested",
    "cancel_completed",
    "rollback_launch_requested",
    "rollback_completed",
  ]),
});
const SavedReceipt = Retained.extend({
  observedAt: z.string().max(64),
  phase: Journal.shape.phase,
  runningBuildId: Digest,
});
const Selection = z.strictObject({
  schema: z.literal("farol.installed-replacement-selection/1"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  snapshot: z.unknown(),
  helpers: z
    .array(
      z.strictObject({
        pid: z.number().int().min(2),
        processStart: z.string().min(1).max(128),
      }),
    )
    .max(32),
});
const fail = (code) => {
  throw Error(code);
};
const identity = (info) => [String(info.dev), String(info.ino)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = (info) => ({
  identity: identity(info),
  mode: String(info.mode),
  uid: String(info.uid),
  gid: String(info.gid),
  size: info.isFile() ? String(info.size) : null,
});

async function safeDirectory(file, privateMode = false) {
  const info = await fs.lstat(file, { bigint: true });
  if (
    !info.isDirectory() ||
    info.uid !== BigInt(process.geteuid()) ||
    (info.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
    (await fs.realpath(file)) !== file
  )
    fail("REPLACEMENT_DIRECTORY_UNSAFE");
  return info;
}

async function bytes(file, maximum = 65536, privateMode = true) {
  const f = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = await f.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.geteuid()) ||
      (before.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
      before.size > BigInt(maximum)
    )
      fail("REPLACEMENT_FILE_UNSAFE");
    const raw = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await f.read(raw, 0, raw.length, 0);
    const after = await f.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (
      bytesRead !== Number(before.size) ||
      !same(identity(before), identity(named)) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size
    )
      fail("REPLACEMENT_FILE_CHANGED");
    return raw.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

async function absent(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail("REPLACEMENT_PENDING_OR_COLLISION");
}

async function updaterSnapshot(updates) {
  const names = await fs.readdir(updates);
  const known = new Set([
    "ready.json",
    "last-update.json",
    "lock",
    "notice-preferences.json",
    "preferences.json",
    "automatic-update-preference.json",
    "install-on-quit-preference.json",
  ]);
  const items = [];
  for (const name of names.sort()) {
    if (!known.has(name) && !/^(?:download-)?[a-f0-9]{32}$/u.test(name))
      fail("REPLACEMENT_UPDATER_UNEXPECTED");
    const file = path.join(updates, name);
    const info = await fs.lstat(file, { bigint: true });
    if (
      info.uid !== BigInt(process.geteuid()) ||
      (info.mode & 0o022n) !== 0n ||
      (!info.isFile() && !info.isDirectory())
    )
      fail("REPLACEMENT_UPDATER_UNSAFE");
    const item = { name, ...stamp(info) };
    if (info.isDirectory()) {
      await safeDirectory(file, true);
      item.children = [];
      for (const leaf of (await fs.readdir(file)).sort()) {
        const meta = await fs.lstat(path.join(file, leaf), { bigint: true });
        if (
          meta.uid !== BigInt(process.geteuid()) ||
          (meta.mode & 0o022n) !== 0n ||
          (!meta.isFile() && !meta.isDirectory())
        )
          fail("REPLACEMENT_UPDATER_UNSAFE");
        const child = { name: leaf, ...stamp(meta) };
        if (leaf === "journal.json")
          child.sha256 = sha(await bytes(path.join(file, leaf)));
        item.children.push(child);
      }
    } else if (name.endsWith(".json")) item.sha256 = sha(await bytes(file));
    items.push(item);
  }
  return items;
}

// Installed package and updater records only; no browser or auth contents.
// An ordinary OTA leaves the original promotion receipt untouched. Accept
// its completed, matching target only through the updater's retained record,
// exact journal and physically retained predecessor. Never rewrite history.
async function confirmCompletedUpdate(updates, appSha256, build) {
  const raw = await bytes(path.join(updates, "last-update.json"));
  const parsed = SavedReceipt.safeParse(JSON.parse(raw));
  if (!parsed.success) fail("REPLACEMENT_UPDATE_RECEIPT_UNCONFIRMED");
  const saved = parsed.data;
  const op = saved.operation;
  const manifest = saved.manifest;
  if (
    saved.phase !== "completed" ||
    !op ||
    saved.preparation ||
    saved.runningBuildId !== build.buildId ||
    !same(op.target, {
      digest: appSha256,
      version: build.version,
      buildId: build.buildId,
    }) ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema !== "farol.github-release/1" ||
    !["legrch/farol", "legrch/farol-releases"].includes(manifest.repository) ||
    manifest.product !== build.product ||
    manifest.bundleId !== build.bundleId ||
    manifest.sourceDirty !== false ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.signing !== "unsigned" ||
    manifest.notarized !== false ||
    manifest.artifactSha256 !== appSha256 ||
    manifest.buildId !== build.buildId ||
    manifest.version !== build.version ||
    manifest.buildVersion !== build.buildVersion ||
    manifest.sourceCommit !== build.sourceCommit ||
    manifest.sourceTreeDigest !== build.sourceTreeDigest ||
    `github-${manifest.channel}` !== build.updateChannel
  )
    fail("REPLACEMENT_UPDATE_RECEIPT_UNCONFIRMED");
  await safeDirectory(updates, true);
  const operationRoot = path.join(updates, op.operationId);
  await safeDirectory(operationRoot, true);
  const journal = Journal.parse(
    JSON.parse(await bytes(path.join(operationRoot, "journal.json"))),
  );
  if (
    journal.phase !== "completed" ||
    !same(
      {
        operationId: journal.operationId,
        source: journal.source,
        target: journal.target,
      },
      op,
    )
  )
    fail("REPLACEMENT_UPDATE_JOURNAL_UNCONFIRMED");
  const previous = path.join(operationRoot, "previous.app");
  await safeDirectory(previous);
  const previousBuild = assertBuildIdentity(
    JSON.parse(
      await bytes(
        path.join(previous, "Contents/Resources/app/build-identity.json"),
        65536,
        false,
      ),
    ),
  );
  if (
    !same(op.source, {
      digest: await treeDigest(previous),
      version: previousBuild.version,
      buildId: previousBuild.buildId,
    })
  )
    fail("REPLACEMENT_UPDATE_PREDECESSOR_CHANGED");
}

export async function snapshotInstalledReplacement(home) {
  const userData = promotionUserData(home);
  const apps = path.join(home, "Applications");
  const state = path.join(userData, "farol-next-state");
  const updates = path.join(userData, "installed-updates");
  await safeDirectory(home);
  const app = path.join(apps, "Farol.app");
  await absent(path.join(state, "installed-replacement.pending"));
  await absent(path.join(apps, "Farol.app.repair.json"));
  await absent(path.join(apps, ".farol-closed-repair.json"));
  const receipt = await bytes(app + ".receipt.json");
  let r;
  try {
    r = JSON.parse(receipt);
  } catch {
    fail("REPLACEMENT_NORMAL_RECEIPT_UNCONFIRMED");
  }
  // Validate only; retain the original JSON value and exact stored bytes.
  if (!NormalPromotionReceipt.safeParse(r).success)
    fail("REPLACEMENT_NORMAL_RECEIPT_UNCONFIRMED");
  const build = assertBuildIdentity(
    JSON.parse(
      await bytes(
        path.join(app, "Contents/Resources/app/build-identity.json"),
        65536,
        false,
      ),
    ),
  );
  const appSha256 = await treeDigest(app);
  if (
    r.destination !== app ||
    r.receipt !== app + ".receipt.json" ||
    r.activation.userData !== userData ||
    r.artifactSha256 !== r.verifiedDestinationSha256
  )
    fail("REPLACEMENT_NORMAL_RECEIPT_UNCONFIRMED");
  const initialInstall =
    r.artifactSha256 === appSha256 &&
    r.sourceCommit === build.sourceCommit &&
    r.sourceTreeDigest === build.sourceTreeDigest &&
    r.version === build.version;
  if (!initialInstall) await confirmCompletedUpdate(updates, appSha256, build);
  return {
    applicationsIdentity: identity(await safeDirectory(apps)),
    profileIdentity: identity(await safeDirectory(userData, true)),
    stateIdentity: identity(await safeDirectory(state, true)),
    appIdentity: identity(await safeDirectory(app)),
    receiptIdentity: identity(
      await fs.lstat(app + ".receipt.json", { bigint: true }),
    ),
    appSha256,
    receiptSha256: sha(receipt),
    installedBuild: build,
    updaterIdentity: identity(await safeDirectory(updates, true)),
    updaterLockIdentity: identity(
      await fs.lstat(path.join(updates, "lock"), { bigint: true }),
    ),
    updater: await updaterSnapshot(updates),
  };
}

function processProof(home, helpers) {
  const env = { PATH: "/usr/bin:/bin", LANG: "C" };
  const table = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (table.error || table.status !== 0 || table.stderr)
    fail("REPLACEMENT_PROCESS_PROBE_UNKNOWN");
  const scopes = [
    path.join(home, "Applications/Farol.app/"),
    path.join(promotionUserData(home), "farol-next-state/go-core"),
    path.join(promotionUserData(home), "farol-next-state/secure-mcp-connector"),
  ];
  for (const line of table.stdout.split("\n")) {
    if (
      Number(line.trim().split(/\s+/u)[0]) !== process.pid &&
      scopes.some((scope) => line.includes(scope))
    )
      fail("REPLACEMENT_PROCESS_ACTIVE");
  }
  for (const helper of helpers) {
    const result = spawnSync(
      "/bin/ps",
      ["-p", String(helper.pid), "-o", "lstart="],
      { env, encoding: "utf8", timeout: 3000, maxBuffer: 4096 },
    );
    if (
      result.error ||
      result.status !== 1 ||
      result.stdout !== "" ||
      result.stderr !== ""
    )
      fail("REPLACEMENT_HELPER_NOT_CONFIRMED_ENDED");
  }
}

function verifyPackage(artifact, app) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      artifact,
      "--app",
      app,
    ],
    { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 65536 },
  );
  if (result.error || result.status !== 0) fail("REPLACEMENT_PACKAGE_INVALID");
}

// Module-only seam. Registration precedes all program/request bytes; no CLI
// helper, home, environment or executable overrides reach this launcher.
export async function runReplacementNative(
  request,
  lease,
  updaterLock,
  register,
  { timeoutMs = 180000 } = {},
) {
  const helper = await bytes(
    path.join(root, "tooling/replace-installed-preview.py"),
    65536,
    false,
  );
  const library = await bytes(
    path.join(root, "tooling/promotion-apply.py"),
    65536,
    false,
  );
  if (sha(helper) !== HELPER_SHA256 || sha(library) !== LIBRARY_SHA256)
    fail("REPLACEMENT_HELPER_INVALID");
  if (!(await verifyPromotionLease(lease))) fail("REPLACEMENT_LEASE_LOST");
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: [
      "pipe",
      "pipe",
      "pipe",
      "pipe",
      "ignore",
      "ignore",
      promotionLeaseDescriptor(lease),
      updaterLock.fd,
      "pipe",
    ],
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const out = [],
    err = [];
  let size = 0,
    fault,
    timer;
  const stop = (error) => {
    fault ??= error;
    child.kill("SIGKILL");
  };
  child.once("error", stop);
  for (const stream of [
    child.stdin,
    child.stdout,
    child.stderr,
    child.stdio[3],
    child.stdio[8],
  ])
    stream.on("error", stop);
  for (const [stream, chunks] of [
    [child.stdout, out],
    [child.stderr, err],
  ])
    stream.on("data", (part) => {
      size += part.length;
      if (size > 65536) stop(Error("REPLACEMENT_OUTPUT_INVALID"));
      else chunks.push(part);
    });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      stop(Error("REPLACEMENT_HELPER_TIMEOUT"));
      resolve(null);
    }, timeoutMs);
  });
  try {
    if (register(closed) !== undefined) fail("REPLACEMENT_OWNER_INVALID");
    child.stdin.end(helper);
    child.stdio[8].end(library);
    child.stdio[3].end(JSON.stringify(request));
  } catch (error) {
    stop(error);
  }
  const result = await Promise.race([closed, deadline]).finally(() =>
    clearTimeout(timer),
  );
  if (!result) fail("REPLACEMENT_HELPER_OUTCOME_UNKNOWN");
  if (fault || result.code !== 0 || result.signal || err.length)
    throw Error(
      "REPLACEMENT_NATIVE_REFUSED:" +
        Buffer.concat(err).toString("utf8").trim(),
    );
  return JSON.parse(Buffer.concat(out).toString("utf8"));
}

export async function replaceInstalledPreview(
  selection,
  apply,
  dependencies = {},
) {
  selection = Selection.parse(selection);
  const home = dependencies.home ?? "/Users/ac";
  if (
    !dependencies.home &&
    (os.userInfo().homedir !== home ||
      os.userInfo().uid !== process.geteuid() ||
      process.platform !== "darwin" ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      process.execArgv.length)
  )
    fail("REPLACEMENT_HOST_UNTRUSTED");
  const userData = promotionUserData(home),
    apps = path.join(home, "Applications"),
    custody = path.join(apps, `.farol-replacement-${selection.operationId}`);
  const current = dependencies.sourceIdentity ?? (() => sourceIdentity(root));
  const candidate = dependencies.candidate ?? candidatePaths(root);
  const artifact =
    dependencies.artifact ??
    (await readArtifactManifest(candidate.artifactFile));
  if (artifact.schema !== 7 || artifact.sourceCommit !== selection.sourceCommit)
    fail("REPLACEMENT_SCHEMA_OR_SOURCE_INVALID");
  if (!dependencies.candidate) assertCanonicalArtifactPath(root, artifact);
  assertExactSourceIdentity(current(), artifact);
  let lease,
    updaterLock,
    effectsStarted = false,
    completed = false;
  const children = new Set();
  const register = (closed) => {
    children.add(closed);
    void closed.then(() => children.delete(closed));
  };
  const release = async () => {
    if (updaterLock) await updaterLock.close();
    if (lease) await releasePromotionLease(lease);
  };
  const settle = async () => {
    if (effectsStarted && !completed) {
      // Presence is not durable publication proof. A killed/lost helper or a
      // failed fsync/readback can leave an inode without a durable fence. Keep
      // both original locks and this owner alive after EVERY effect failure,
      // even after every registered original child has closed. Only confirmed
      // complete permits release; conductor reconciliation owns this limit.
      setInterval(() => {}, 60000);
      process.stderr.write(
        "REPLACEMENT_UNKNOWN_RETAINS_LOCKS_OWNER_REQUIRED\n",
      );
      return;
    }
    await release();
  };
  try {
    // Check safe parents before the existing lease's mkdir behavior can run.
    await safeDirectory(userData, true);
    await safeDirectory(path.join(userData, "farol-next-state"), true);
    if (apply) {
      lease = await acquirePromotionLease(
        userData,
        artifact.buildId,
        "promotion",
      );
      if (!lease) fail("REPLACEMENT_PROMOTION_BUSY");
      await safeDirectory(path.join(userData, "installed-updates"), true);
      updaterLock = await fs.open(
        path.join(userData, "installed-updates/lock"),
        C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
      );
      const info = await updaterLock.stat({ bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.uid !== BigInt(process.geteuid()) ||
        (info.mode & 0o077n) !== 0n ||
        !same(identity(info), selection.snapshot.updaterLockIdentity)
      )
        fail("REPLACEMENT_UPDATER_LOCK_UNSAFE");
    }
    const fresh = await snapshotInstalledReplacement(home);
    if (!same(fresh, selection.snapshot)) fail("REPLACEMENT_SNAPSHOT_CHANGED");
    await absent(custody);
    const checkProcesses = dependencies.processProof ?? processProof;
    checkProcesses(home, selection.helpers);
    // Every recorded helper must be selected; its phase is never made terminal.
    for (const name of ["ready.json", "last-update.json"]) {
      const record = JSON.parse(
        await bytes(path.join(userData, "installed-updates", name)),
      );
      if (
        record.helper &&
        !selection.helpers.some(
          (h) =>
            h.pid === record.helper.pid &&
            h.processStart === record.helper.processStart,
        )
      )
        fail("REPLACEMENT_HELPER_SELECTION_MISSING");
    }
    const drain = await (dependencies.activation ?? activationObligations)(
      userData,
    );
    assertActivationDrained(drain);
    await (dependencies.verify ?? verifyPackage)(
      candidate.artifactFile,
      candidate.appPath,
    );
    assertExactSourceIdentity(current(), artifact);
    if (
      BigInt(artifact.buildVersion) <=
        BigInt(fresh.installedBuild.buildVersion) ||
      compareReleaseVersions(artifact.version, fresh.installedBuild.version) !==
        1
    )
      fail("REPLACEMENT_NOT_INCREASING");
    if (!same(await snapshotInstalledReplacement(home), fresh))
      fail("REPLACEMENT_SNAPSHOT_CHANGED");
    checkProcesses(home, selection.helpers);
    assertActivationDrained(
      await (dependencies.activation ?? activationObligations)(userData),
    );
    const plan = {
      schema: "farol.installed-replacement-plan/1",
      operation: apply ? "apply" : "plan-only",
      sourceCommit: artifact.sourceCommit,
      candidateSha256: artifact.artifactSha256,
      custody,
      snapshot: fresh,
      historicalOperationsReconciled: false,
    };
    const intentText =
      JSON.stringify({
        ...plan,
        operation: "intent",
        operationId: selection.operationId,
      }) + "\n";
    // The native record reader caps intent at 64 KiB. Refuse before marking
    // effects started or spawning an effect child, including during planning.
    if (Buffer.byteLength(intentText, "utf8") >= 64 * 1024)
      fail("REPLACEMENT_INTENT_TOO_LARGE");
    if (!apply) return plan;
    if (!(await verifyPromotionLease(lease))) fail("REPLACEMENT_LEASE_LOST");
    const leaseInfo = await fs.lstat(lease.file, { bigint: true });
    const request = {
      schema: "farol.installed-replacement-native/1",
      action: "custody",
      home,
      userData,
      operationId: selection.operationId,
      snapshot: fresh,
      promotionIdentity: identity(leaseInfo),
      intentText,
    };
    effectsStarted = true;
    const retained = await (dependencies.native ?? runReplacementNative)(
      request,
      lease,
      updaterLock,
      register,
    );
    const lockFile = path.join(custody, "installed-updates/lock");
    if (
      !same(
        identity(await fs.lstat(lockFile, { bigint: true })),
        fresh.updaterLockIdentity,
      )
    )
      fail("REPLACEMENT_UPDATER_LOCK_CHANGED");
    const receipt = {
      schema: "farol.next.promotion-plan/1",
      operation: "applied",
      product: artifact.product,
      version: artifact.version,
      sourceCommit: artifact.sourceCommit,
      sourceTreeDigest: artifact.sourceTreeDigest,
      sourceDirty: false,
      artifactSha256: artifact.artifactSha256,
      source: candidate.appPath,
      destination: path.join(apps, "Farol.app"),
      receipt: path.join(apps, "Farol.app.receipt.json"),
      overwrite: false,
      legacyMutation: false,
      activation: { userData, drained: true, obligations: [] },
      verifiedDestinationSha256: artifact.artifactSha256,
    };
    const receiptText = JSON.stringify(receipt, null, 2) + "\n";
    const assertParents = async () => {
      if (
        !same(
          identity(await safeDirectory(apps)),
          fresh.applicationsIdentity,
        ) ||
        !same(
          identity(await safeDirectory(userData, true)),
          fresh.profileIdentity,
        ) ||
        !same(
          identity(await fs.lstat(lockFile, { bigint: true })),
          fresh.updaterLockIdentity,
        ) ||
        !(await verifyPromotionLease(lease))
      )
        fail("REPLACEMENT_PARENT_OR_LOCK_CHANGED");
    };
    await assertParents();
    await (dependencies.promotion ?? runPromotionApply)({
      home,
      source: candidate.appPath,
      artifactSha256: artifact.artifactSha256,
      receiptText,
      lease,
      updaterLockDescriptor: updaterLock.fd,
      onChildStarted: register,
      afterParentOpened: assertParents,
    });
    await assertParents();
    await (dependencies.verify ?? verifyPackage)(
      candidate.artifactFile,
      receipt.destination,
    );
    assertExactSourceIdentity(current(), artifact);
    if (!(await bytes(receipt.receipt)).equals(Buffer.from(receiptText)))
      fail("REPLACEMENT_NEW_RECEIPT_CHANGED");
    const completion = await (dependencies.native ?? runReplacementNative)(
      {
        ...request,
        action: "complete",
        custodyIdentity: retained.custodyIdentity,
        pendingIdentity: retained.pendingIdentity,
        candidateSha256: artifact.artifactSha256,
        newReceiptSha256: sha(receiptText),
        completionText:
          JSON.stringify({
            schema: "farol.installed-replacement-completed/1",
            operationId: selection.operationId,
            receiptSha256: sha(receiptText),
            historicalOperationsReconciled: false,
          }) + "\n",
      },
      lease,
      updaterLock,
      register,
    );
    if (!same(completion, { completed: true }))
      fail("REPLACEMENT_COMPLETION_UNCONFIRMED");
    completed = true;
    return { ...plan, operation: "completed", receipt };
  } finally {
    // Never release either inode while any original effect child is unresolved.
    if (children.size) void Promise.all([...children]).then(settle);
    else await settle();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (
      (args.length !== 4 && args.length !== 5) ||
      args[0] !== "--selection" ||
      args[2] !== "--selection-sha" ||
      (args.length === 5 && args[4] !== "--apply") ||
      !path.isAbsolute(args[1] ?? "") ||
      !Digest.safeParse(args[3]).success
    )
      fail("REPLACEMENT_OPTIONS_INVALID");
    const selected = await bytes(args[1], 4 * 1024 * 1024);
    if (sha(selected) !== args[3]) fail("REPLACEMENT_SELECTION_CHANGED");
    process.stdout.write(
      JSON.stringify(
        await replaceInstalledPreview(JSON.parse(selected), args.length === 5),
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error && /^REPLACEMENT_[A-Z_:]+$/u.test(error.message)
        ? error.message
        : "REPLACEMENT_REFUSED_OR_UNKNOWN") + "\n",
    );
    process.exitCode = 1;
  }
}
