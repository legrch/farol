import { spawnSync } from "node:child_process";
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
} from "./promotion-lease.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(root, "..");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");
const { artifactFile, appPath: canonicalAppPath } = candidatePaths(root);

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

function verify(artifactPath, appPath) {
  return spawnSync(
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

async function main() {
  const arguments_ = process.argv.slice(2);
  const destinationOption = option(arguments_, "--destination");
  const apply = arguments_.includes("--apply");
  const known = new Set(["--destination", "--apply"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!known.has(argument))
      throw new Error(`PROMOTION_OPTION_INVALID:${argument}`);
    if (argument === "--destination") index += 1;
  }
  assertNoOpenFindings(apply, OPEN_PROMOTION_FINDINGS);

  const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
  assertCanonicalArtifactPath(
    root,
    artifact,
    "PROMOTION_ARTIFACT_PATH_INVALID",
  );
  assertExactSourceIdentity(
    sourceIdentity(repositoryRoot, scope),
    artifact,
    "PROMOTION_SOURCE_NOT_EXACT",
  );
  const source = canonicalAppPath;
  const home = trustedOwnerHome(os.userInfo(), process.geteuid?.());
  const { destination, receipt } = assertPromotionDestination({
    home,
    source,
    destination:
      destinationOption ??
      path.join(home, "Applications/Farol Next Preview.app"),
  });

  const userData = promotionUserData(home);
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
  try {
    const sourceVerification = verify(artifactFile, source);
    if (sourceVerification.status !== 0) {
      throw new Error(
        `PROMOTION_SOURCE_INVALID:${`${sourceVerification.stderr}${sourceVerification.stdout}`.trim()}`,
      );
    }
    assertExactSourceIdentity(
      sourceIdentity(repositoryRoot, scope),
      artifact,
      "PROMOTION_SOURCE_CHANGED_DURING_VERIFICATION",
    );
    if (await exists(destination))
      throw new Error("PROMOTION_DESTINATION_EXISTS");
    if (await exists(receipt)) throw new Error("PROMOTION_RECEIPT_EXISTS");
    // The generation this home runs today must owe nothing before another is
    // placed: a running or unknown turn, an undelivered result or an
    // unconfirmed quit refuses the promotion instead of being drained by it.
    const obligations = await activationObligations(userData);
    assertActivationDrained(obligations);

    const plan = {
      schema: "farol.next.promotion-plan/1",
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
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }

    const promotionReceipt = {
      ...plan,
      operation: "applied",
      verifiedDestinationSha256: artifact.artifactSha256,
    };
    const receiptText = `${JSON.stringify(promotionReceipt, null, 2)}\n`;
    await runPromotionApply({
      home,
      source,
      artifactSha256: artifact.artifactSha256,
      receiptText,
    });
    process.stdout.write(receiptText);
  } finally {
    if (lease) await releasePromotionLease(lease);
  }
}

// Only the script entry point runs `main()`; a test that imports this
// module for `assertNoOpenFindings` or `OPEN_PROMOTION_FINDINGS` must not
// trigger a real promotion as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Farol Next Preview promotion refused: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  }
}
