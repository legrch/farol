import { PRODUCT_APP_NAME } from "./package-layout.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownerPreviewArguments,
  ownerPreviewLaunchMessage,
  assertOwnerPreviewSource,
  ownerPreviewPlan,
  requireOwnerPreviewRuntimeIntegration,
  generationPaths,
} from "./owner-preview-contract.mjs";
import {
  OWNER_PREVIEW_APP,
  PREVIEW_LAUNCHER_PATH,
  previewLinkTarget,
} from "./owner-preview-contract.mjs";
import {
  physicalDirectory,
  regularBytes,
  derivePreviewTree,
  derivativeManifest,
  generationIdentity,
  jsonBytes,
  verifyCanonicalSnapshot,
  verifyOwnerPreview,
  pinCurrentGeneration,
} from "./verify-owner-preview.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import {
  candidatePaths,
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "./candidate-contract.mjs";
import { ownerLaunchEnvironment } from "./launch-snapshot.mjs";
import { createOwnerLaunchResultCollector } from "./owner-launch-result.mjs";
import { renderPreviewAssets } from "./owner-preview-assets.mjs";
import { readGoBuildInputs } from "./go-build-inputs.mjs";

const root = await fs.realpath(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const gitEnvironment = {
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};
function git(args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }).trim();
}
function observeSource(expectedMain) {
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const localMain = git(["rev-parse", "--verify", "refs/heads/main"]);
  const trackedMain = git([
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main",
  ]);
  // Reject an obvious unaccepted branch before the full source inventory.
  // Exact source/dirty checks still run before network, package or profile IO.
  if (
    head !== localMain ||
    head !== trackedMain ||
    (expectedMain !== undefined && expectedMain !== head)
  )
    throw new Error("OWNER_PREVIEW_CURRENT_MAIN_REQUIRED");
  const source = sourceIdentity(root);
  const initial = {
    expectedMain,
    localMain,
    trackedMain,
    source,
    remoteMain: localMain,
  };
  // Reject dirty/unmerged/stale local state before even the bounded network read.
  assertOwnerPreviewSource(initial);
  const urls = git(["remote", "get-url", "--all", "origin"]).split("\n");
  if (
    urls.length !== 1 ||
    ![
      "https://github.com/legrch/farol.git",
      "git@github.com:legrch/farol.git",
    ].includes(urls[0])
  )
    throw new Error("OWNER_PREVIEW_ORIGIN_INVALID");
  // Exactly one fresh remote main read. No fetch/checkout/pull or ref changes.
  const remote = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
  const match = /^([a-f0-9]{40})\trefs\/heads\/main$/u.exec(remote);
  const observed = { ...initial, remoteMain: match?.[1] };
  assertOwnerPreviewSource(observed);
  return observed;
}
function unchanged(observation) {
  const source = sourceIdentity(root);
  assertOwnerPreviewSource({ ...observation, source });
  if (
    source.treeDigest !== observation.source.treeDigest ||
    git(["rev-parse", "--verify", "refs/heads/main"]) !==
      observation.localMain ||
    git(["rev-parse", "--verify", "refs/remotes/origin/main"]) !==
      observation.trackedMain
  )
    throw new Error("OWNER_PREVIEW_SOURCE_CHANGED");
}
async function privateDirectory(directory) {
  await physicalDirectory(path.dirname(directory));
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await physicalDirectory(directory, { privateMode: true });
}
async function acquireWriter() {
  const output = path.join(root, "_output");
  try {
    await fs.mkdir(output, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await physicalDirectory(output);
  const preview = path.join(output, "preview");
  await privateDirectory(preview);
  await privateDirectory(path.join(preview, "generations"));
  await privateDirectory(path.join(preview, "failed"));
  const lock = path.join(preview, ".writer-lock");
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "OWNER_PREVIEW_WRITER_HELD: preserve and reconcile the existing writer; no stale-lock removal",
    );
  }
  const token = randomBytes(32).toString("hex");
  await fs.writeFile(path.join(lock, "owner"), token, {
    flag: "wx",
    mode: 0o600,
  });
  return async () => {
    await physicalDirectory(lock, { privateMode: true });
    if ((await regularBytes(path.join(lock, "owner"))).toString() !== token)
      throw new Error("OWNER_PREVIEW_WRITER_CHANGED");
    await fs.unlink(path.join(lock, "owner"));
    await fs.rmdir(lock); // refuses any foreign extra entries
  };
}

async function build(observation) {
  const inputs = path.join(root, "_output/go-build-inputs.json");
  // The original operator-approved input file, unchanged. No repinning, install
  // or download. The canonical builder authenticates every compiler/dependency.
  const inputsBefore = await regularBytes(inputs, 16384);
  await readGoBuildInputs([`--go-inputs=${inputs}`]);
  const releaseWriter = await acquireWriter();
  let writerSettled = true;
  try {
    unchanged(observation);
    const packaged = spawnSync(
      "/opt/homebrew/bin/task",
      ["package", "--", `--go-inputs=${inputs}`],
      {
        cwd: root,
        env: {
          ...ownerLaunchEnvironment(),
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        stdio: "inherit",
      },
    );
    if (packaged.error || packaged.signal) writerSettled = false;
    if (packaged.error || packaged.signal || packaged.status !== 0)
      throw new Error(
        `OWNER_PREVIEW_PACKAGE_FAILED:${packaged.error?.code ?? packaged.signal ?? packaged.status}`,
      );
    unchanged(observation);
    if (!(await regularBytes(inputs, 16384)).equals(inputsBefore))
      throw new Error("OWNER_PREVIEW_GO_INPUTS_CHANGED");
    const canonical = candidatePaths(root);
    const baseBytes = await regularBytes(canonical.artifactFile);
    const base = JSON.parse(baseBytes.toString("utf8"));
    assertCanonicalArtifactPath(root, base);
    assertExactSourceIdentity(observation.source, base);
    if (base.schema !== 7) throw new Error("OWNER_PREVIEW_GO_PACKAGE_REQUIRED");
    verifyCanonicalSnapshot(root, canonical.artifactFile, canonical.appPath);
    const preview = path.join(root, "_output/preview");
    // Failed/incomplete assembly attempts remain private and are never reused.
    const attempt = path.join(
      preview,
      "failed",
      randomBytes(32).toString("hex"),
    );
    await fs.mkdir(attempt, { mode: 0o700 });
    const hidden = path.join(attempt, ".canonical");
    await fs.mkdir(hidden, { mode: 0o700 });
    const baseApp = path.join(hidden, PRODUCT_APP_NAME);
    const baseArtifact = path.join(hidden, "artifact.json");
    await fs.writeFile(baseArtifact, baseBytes, { flag: "wx", mode: 0o600 });
    await fs.cp(canonical.appPath, baseApp, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    verifyCanonicalSnapshot(root, baseArtifact, baseApp);
    const assets = await renderPreviewAssets(root);
    const digest = await derivePreviewTree(
      baseApp,
      path.join(attempt, OWNER_PREVIEW_APP),
      assets,
    );
    const manifest = derivativeManifest(base, baseBytes, digest);
    await fs.writeFile(
      path.join(attempt, "derivative.json"),
      jsonBytes(manifest),
      { flag: "wx", mode: 0o600 },
    );
    const generation = generationIdentity(manifest);
    const paths = generationPaths(root, generation);
    // rename must not replace a retained generation, even an incomplete one.
    try {
      await fs.lstat(paths.directory);
      throw new Error("OWNER_PREVIEW_GENERATION_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(attempt, paths.directory);
    await verifyOwnerPreview(root, generation);
    await smoke(generation);
    unchanged(observation);
    await publishCurrent(generation);
    return generation;
  } finally {
    if (writerSettled) await releaseWriter();
    else
      process.stderr.write(
        "OWNER_PREVIEW_WRITER_RETAINED: package outcome unknown; Root must reconcile before another build\n",
      );
  }
}
async function publishCurrent(generation) {
  const preview = path.join(root, "_output/preview");
  const current = path.join(preview, OWNER_PREVIEW_APP);
  let exists = true;
  try {
    await fs.lstat(current);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) await pinCurrentGeneration(root); // also reject broken links
  const temporary = path.join(
    preview,
    `.current-${randomBytes(32).toString("hex")}.app`,
  );
  await fs.symlink(previewLinkTarget(generation), temporary);
  await fs.rename(temporary, current); // same-directory atomic relative .app link
}
async function smoke(generation) {
  // No caller PASS flag or imported receipt: success comes from fresh actual
  // packaged observations. Failed/UNKNOWN attempts block automatic replay.
  const { runOwnerPreviewSmoke } =
    await import("../tests/e2e/owner-preview-smoke.e2e.mjs");
  return runOwnerPreviewSmoke(root, generation);
}
async function launch(generation, observation) {
  const pinned = await verifyOwnerPreview(root, generation);
  unchanged(observation);
  const collector = createOwnerLaunchResultCollector();
  let protocolError;
  const child = spawn(path.join(pinned.appPath, PREVIEW_LAUNCHER_PATH), [], {
    cwd: root,
    env: ownerLaunchEnvironment(),
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    try {
      collector.push(chunk);
    } catch (error) {
      protocolError = error;
    }
  });
  // No app closure, signal forwarding, forced cleanup, or effect settlement.
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  if (protocolError) throw protocolError;
  if (outcome.signal || outcome.status !== 0)
    throw new Error(
      `OWNER_PREVIEW_LAUNCH_UNKNOWN:${outcome.signal ?? outcome.status}`,
    );
  const result = collector.finish();
  process.stdout.write(ownerPreviewLaunchMessage(result, generation));
}

try {
  const { action, expectedMain } = ownerPreviewArguments(process.argv.slice(2));
  // This is the real runtime parser/identity/home contract, never an enabled flag.
  if (action !== "plan") requireOwnerPreviewRuntimeIntegration();
  const observation = observeSource(expectedMain);
  if (action === "plan")
    process.stdout.write(
      `${JSON.stringify(ownerPreviewPlan(root, observation), null, 2)}\n`,
    );
  else if (action === "run") {
    const pinned = await pinCurrentGeneration(root);
    await verifyOwnerPreview(root, pinned.generation);
    await smoke(pinned.generation);
    await launch(pinned.generation, observation);
  } else {
    const generation = await build(observation);
    process.stdout.write(`built owner Preview ${generation}\n`);
    if (action === "build-run") await launch(generation, observation);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "OWNER_PREVIEW_FAILED"}\n`,
  );
  process.exitCode = 1;
}
