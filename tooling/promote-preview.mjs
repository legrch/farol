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
  preparePromotionParent,
} from "./promotion-destination.mjs";
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

async function copyContents(source, destination) {
  for (const name of (await fs.readdir(source)).sort()) {
    await fs.cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

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
  const home = os.homedir();
  const { destination, parent, receipt } = assertPromotionDestination({
    home,
    source,
    destination:
      destinationOption ??
      path.join(home, "Applications/Farol Next Preview.app"),
  });

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
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  await preparePromotionParent(home, parent);
  if (await exists(destination))
    throw new Error("PROMOTION_DESTINATION_EXISTS");
  if (await exists(receipt)) throw new Error("PROMOTION_RECEIPT_EXISTS");

  let ownsDestination = false;
  try {
    await fs.mkdir(destination, { mode: 0o755 });
    ownsDestination = true;
    await copyContents(source, destination);
    const destinationVerification = verify(artifactFile, destination);
    if (destinationVerification.status !== 0) {
      throw new Error(
        `PROMOTION_DESTINATION_INVALID:${`${destinationVerification.stderr}${destinationVerification.stdout}`.trim()}`,
      );
    }
    assertExactSourceIdentity(
      sourceIdentity(repositoryRoot, scope),
      artifact,
      "PROMOTION_SOURCE_CHANGED_DURING_COPY",
    );
    const promotionReceipt = {
      ...plan,
      operation: "applied",
      verifiedDestinationSha256: artifact.artifactSha256,
    };
    await fs.writeFile(
      receipt,
      `${JSON.stringify(promotionReceipt, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    process.stdout.write(destinationVerification.stdout);
    process.stdout.write(`${JSON.stringify(promotionReceipt, null, 2)}\n`);
  } catch (error) {
    if (ownsDestination) {
      await fs.rm(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Farol Next Preview promotion refused: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
}
