import { productName, productBundleName } from "./harness-identity.ts";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
  candidatePaths,
} from "./candidate-contract.mjs";
import {
  assertPromotionDestination,
  trustedOwnerHome,
} from "./promotion-destination.mjs";
import { runPromotionApply } from "./promotion-apply.mjs";
import {
  activationObligations,
  assertActivationDrained,
  promotionUserData,
} from "./promotion-obligations.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = root;
const scope = ".";

// artifact.json is read like every other file this CLI trusts: a regular
// file opened without following a symlink, owned by this user, not writable
// by anyone else, and no larger than a manifest can be. A manifest is a few
// kilobytes; the cap is a limit, not an allocation.
const MAX_ARTIFACT_BYTES = 64 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC = fsConstants.O_CLOEXEC ?? 0;

function option(arguments_, name) {
  const indexes = arguments_
    .map((argument, index) => (argument === name ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) throw new Error(`PROMOTION_OPTION_REPEATED:${name}`);
  if (indexes.length === 0) return null;
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`PROMOTION_OPTION_VALUE_MISSING:${name}`);
  }
  return value;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function verifyPackage(artifactPath, appPath) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "tooling/verify-package.mjs"),
      "--artifact",
      artifactPath,
      "--app",
      appPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stderr}${result.stdout}`.trim(),
  };
}

// The mechanism a remaining open review finding uses to block `--apply`
// while a plan is still shown. Exported so the mechanism itself — not just
// today's empty list — stays under test: a synthetic finding must still
// block, whatever this list names right now.
export function assertNoOpenFindings(apply, findings) {
  if (apply && findings.length > 0) {
    throw new Error(
      `PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:${findings.join(",")}`,
    );
  }
}

// The governing review opened two findings against promotion itself
// (32/Review-Rework-Handoff F3-3: the state projections accepted reduced or
// symlinked stores their owners refuse; F3-4: no lease held from the drain
// check to placement). Both are closed: F3-3 by the private, versioned,
// symlink-refusing reads in `promotion-obligations.mjs`; F3-4 by the
// generation-owned lease acquired above, held from before the drain check
// through placement and shared with the app's own work admission. This
// list, and `assertNoOpenFindings` above, remain the mechanism for any
// future finding against promotion.
export const OPEN_PROMOTION_FINDINGS = Object.freeze([]);

// Reads the candidate manifest under the same discipline as the state files
// promotion trusts, with one closed refusal code per way the read can fail.
export async function readArtifactManifest(file) {
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    const reason =
      error?.code === "ENOENT"
        ? "ABSENT"
        : error?.code === "ELOOP"
          ? "SYMLINK"
          : "UNSAFE";
    throw new Error(`PROMOTION_ARTIFACT_UNREADABLE:${reason}`);
  }
  let text;
  try {
    const info = await handle.stat();
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o022) !== 0
    ) {
      throw new Error("PROMOTION_ARTIFACT_UNREADABLE:UNSAFE");
    }
    if (info.size > MAX_ARTIFACT_BYTES) {
      throw new Error("PROMOTION_ARTIFACT_UNREADABLE:OVERSIZED");
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch {
    throw new Error("PROMOTION_ARTIFACT_UNREADABLE:CORRUPT");
  }
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact)
  ) {
    throw new Error("PROMOTION_ARTIFACT_UNREADABLE:CORRUPT");
  }
  return artifact;
}

// `--user-data` points the drain check at another profile so a test or a
// diagnosis can ask what a throwaway profile owes without touching the
// owner's. It is plan-only by construction: the destination is fixed to the
// owner's Applications folder, and the generation that home runs lives in
// the owner's profile, so an `--apply` that checked some other profile
// would place over a running generation with neither the drain check nor
// the admission lease (both live in the profile) standing in its way. The
// owner's own profile is refused as an explicit value too, so a test that
// seeds the profile it names can never seed the real one.
export function resolvePromotionUserData(option, ownerProfile, apply) {
  if (option === null) return ownerProfile;
  if (!path.isAbsolute(option)) {
    throw new Error("PROMOTION_USER_DATA_NOT_ABSOLUTE");
  }
  const resolved = path.resolve(option);
  const relative = path.relative(ownerProfile, resolved);
  const insideOwnerProfile =
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  if (insideOwnerProfile) {
    throw new Error("PROMOTION_USER_DATA_IS_OWNER_PROFILE");
  }
  if (apply) throw new Error("PROMOTION_USER_DATA_APPLY_REFUSED");
  return resolved;
}

// The whole promotion, as one composition: options, the candidate, the
// source identity, the destination, the lease, verification, the drain
// check, placement. The script entry point runs it with no `dependencies`;
// `tests/integration/promote-preview-cli.test.mjs` runs the same
// composition in a child process with a throwaway candidate, home and
// source identity, because the real entry's checks (exact clean HEAD bytes,
// a sealed Electron package) cannot be satisfied from a test. Nothing on
// the command line or in the environment reaches these seams.
async function promote(arguments_, dependencies, stdout) {
  const destinationOption = option(arguments_, "--destination");
  const userDataOption = option(arguments_, "--user-data");
  const apply = arguments_.includes("--apply");
  const valued = new Set(["--destination", "--user-data"]);
  const known = new Set([...valued, "--apply"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!known.has(argument))
      throw new Error(`PROMOTION_OPTION_INVALID:${argument}`);
    if (valued.has(argument)) index += 1;
  }
  assertNoOpenFindings(apply, OPEN_PROMOTION_FINDINGS);

  const home =
    dependencies.home ?? trustedOwnerHome(os.userInfo(), process.geteuid?.());
  const userData = resolvePromotionUserData(
    userDataOption,
    promotionUserData(home),
    apply,
  );

  const candidateRoot = dependencies.candidateRoot ?? root;
  const { artifactFile, appPath: source } = candidatePaths(candidateRoot);
  const artifact = await readArtifactManifest(artifactFile);
  assertCanonicalArtifactPath(
    candidateRoot,
    artifact,
    "PROMOTION_ARTIFACT_PATH_INVALID",
  );
  const currentSourceIdentity =
    dependencies.sourceIdentity ??
    (() => sourceIdentity(repositoryRoot, scope));
  assertExactSourceIdentity(
    currentSourceIdentity(),
    artifact,
    "PROMOTION_SOURCE_NOT_EXACT",
  );
  const { destination, receipt } = assertPromotionDestination({
    home,
    source,
    destination: destinationOption ?? `/Applications/${productBundleName}`,
  });

  // F3-4: a promotion and the app's own work admission share one lease, so
  // nothing can be admitted in the gap between the drain check below and
  // the placement it authorises. Plan-only never places anything, so it
  // never needs to exclude admission; only `--apply` takes the lease, and
  // holds it through verification, the drain check and placement, releasing
  // only once the authoritative receipt is written (or the attempt fails).
  const lease = apply
    ? await acquirePromotionLease(
        userData,
        artifact.buildId ?? artifact.sourceCommit,
        "promotion",
      )
    : null;
  if (apply && !lease) throw new Error("PROMOTION_LEASE_HELD");
  let originalChildClose;
  let originalChildClosed = false;
  try {
    const verify = dependencies.verify ?? verifyPackage;
    const sourceVerification = await verify(artifactFile, source);
    if (sourceVerification.status !== 0) {
      throw new Error(`PROMOTION_SOURCE_INVALID:${sourceVerification.output}`);
    }
    assertExactSourceIdentity(
      currentSourceIdentity(),
      artifact,
      "PROMOTION_SOURCE_CHANGED_DURING_VERIFICATION",
    );
    if (await exists(destination))
      throw new Error("PROMOTION_DESTINATION_EXISTS");
    if (await exists(receipt)) throw new Error("PROMOTION_RECEIPT_EXISTS");
    // The generation this home runs today must owe nothing before another is
    // placed: a running or unknown turn, an undelivered result, an
    // unconfirmed quit or a still-running app refuses the promotion instead
    // of being drained by it.
    const obligations = await activationObligations(
      userData,
      dependencies.activation ?? {},
    );
    assertActivationDrained(obligations);

    const plan = {
      schema: "farol.promotion-plan/1",
      operation: apply ? "apply" : "plan-only",
      product: artifact.product,
      version: artifact.version,
      sourceCommit: artifact.sourceCommit,
      sourceTreeDigest: artifact.sourceTreeDigest,
      sourceDirty: artifact.sourceDirty,
      artifactSha256: artifact.artifactSha256,
      source,
      destination,
      receipt,
      overwrite: false,
      legacyMutation: false,
      activation: {
        userData: obligations.userData,
        drained: obligations.drained,
        obligations: obligations.obligations,
      },
    };
    if (!apply) {
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }

    const promotionReceipt = {
      ...plan,
      operation: "applied",
      verifiedDestinationSha256: artifact.artifactSha256,
    };
    const receiptText = `${JSON.stringify(promotionReceipt, null, 2)}\n`;
    // Fencing: the lease this run holds must still be the lease on disk at
    // the moment the durable step begins; a holder that proceeded without
    // that check would be one of two.
    //
    // The helper inherits this same kernel lock and validates its identity
    // before placement and receipt publication. Parent death must not admit
    // another generation while the original helper is still mutating.
    if (!(await verifyPromotionLease(lease))) {
      throw new Error("PROMOTION_LEASE_LOST");
    }
    await runPromotionApply({
      home,
      destination,
      source,
      artifactSha256: artifact.artifactSha256,
      receiptText,
      lease,
      onChildStarted: (closed) => {
        originalChildClose = closed;
        void closed.then(() => {
          originalChildClosed = true;
        });
      },
    });
    stdout.write(receiptText);
  } finally {
    if (lease) {
      if (originalChildClose && !originalChildClosed) {
        // The bounded call has refused with an unconfirmed child lifetime.
        // Reconcile only that original close; never retry placement or clear
        // the original kernel lease while the worker may still be alive.
        void originalChildClose.then(() => releasePromotionLease(lease));
      } else {
        await releasePromotionLease(lease);
      }
    }
  }
}

// The command as a process sees it: exit status 0 with the plan or receipt
// on stdout, or 1 with one refusal line on stderr. Returns the status
// instead of setting it so a caller can run it in-process.
export async function runPromotionCli(arguments_, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    await promote(arguments_, dependencies, stdout);
    return 0;
  } catch (error) {
    stderr.write(
      `${productName} promotion refused: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    return 1;
  }
}

// Only the script entry point runs the promotion; a test that imports this
// module for `assertNoOpenFindings` or `OPEN_PROMOTION_FINDINGS` must not
// trigger a real promotion as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPromotionCli(process.argv.slice(2));
}
