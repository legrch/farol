// Dev resource preparation only. No package publication, profile or credential IO.
import fs from "node:fs/promises";
import path from "node:path";
import { desktopCoreArtifactRoot } from "../apps/desktop/dev-core-layout.ts";
import { treeDigest } from "./artifact-digest.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "./build-contract.mjs";
import { GO_CORE_ENTRIES, verifyGoCoreArtifact } from "./go-core-artifact.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { assertExactSourceIdentity } from "./candidate-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import {
  assertEmbeddedRuntime,
  observeEmbeddedRuntime,
} from "./runtime-contract.mjs";

async function ownedDirectory(directory) {
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o022) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error("DEV_CORE_DIRECTORY_UNSAFE");
}

async function readOwnedFile(file, maximum) {
  const handle = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid()) ||
      (before.mode & 0o022n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error("DEV_CORE_FILE_UNSAFE");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("DEV_CORE_FILE_CHANGED");
    return { bytes, mode: Number(before.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

export async function prepareDevCoreResources(root) {
  await ownedDirectory(root);
  const output = path.join(root, "_output");
  await ownedDirectory(output);
  const source = path.join(output, "build/app");
  await ownedDirectory(path.dirname(source));
  await ownedDirectory(source);
  const json = async (name) =>
    JSON.parse(
      (
        await readOwnedFile(path.join(source, name), 32 * 1024 * 1024)
      ).bytes.toString("utf8"),
    );
  const build = assertBuildIdentity(await json("build-identity.json"));
  const manifest = await json("build-manifest.json");
  assertExactSourceIdentity(sourceIdentity(root), build);
  const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
  if (
    manifest.schema !== 4 ||
    manifest.dirty ||
    !manifest.inputExact ||
    manifest.sourceMode !== "head-exact" ||
    manifest.buildId !== build.buildId ||
    JSON.stringify(manifest.entries) !== JSON.stringify(entries)
  )
    throw new Error("DEV_CORE_BUILD_INVALID");
  await verifyBuildEntries(source, manifest.entrySha256, entries);
  await verifyInputManifest(source, manifest);
  await verifyGoCoreArtifact(source, manifest.core, build);
  const vendor = path.join(root, "node_modules/electron/dist/Electron.app");
  const runtime = await observeEmbeddedRuntime(vendor);
  assertEmbeddedRuntime(runtime);
  const destination = desktopCoreArtifactRoot(source, "dev");
  const bundle = path.resolve(destination, "../../..");
  const receiptPath = path.join(output, "dev-core-resources.json");
  let previous;
  try {
    previous = JSON.parse(
      (await readOwnedFile(receiptPath, 8192)).bytes.toString("utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let present = false;
  try {
    await ownedDirectory(bundle);
    present = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (present) {
    // Unexpected edits are evidence, not permission to overwrite a runtime.
    if (
      previous?.schema !== 1 ||
      previous.root !== bundle ||
      (await treeDigest(bundle)) !== previous.treeDigest
    )
      throw new Error("DEV_CORE_RESOURCES_CHANGED");
    if (
      previous.buildId === build.buildId &&
      previous.vendorDigest === runtime.extractedTreeDigest
    ) {
      await verifyBuildEntries(destination, manifest.entrySha256, entries);
      await verifyInputManifest(destination, manifest);
      await verifyGoCoreArtifact(destination, manifest.core, build);
      assertEmbeddedRuntime(
        await observeEmbeddedRuntime(
          path.join(bundle, "Contents/Frameworks/Electron Runtime.app"),
        ),
      );
      return destination;
    }
  } else if (previous) {
    throw new Error("DEV_CORE_RESOURCES_MISSING");
  }
  const staging = await fs.mkdtemp(path.join(output, ".dev-core-"));
  let published = false;
  try {
    const resources = path.join(staging, "Contents/Resources/app");
    await fs.mkdir(resources, { recursive: true, mode: 0o700 });
    for (const name of [...entries, "build-manifest.json"]) {
      const { bytes, mode } = await readOwnedFile(
        path.join(source, name),
        128 * 1024 * 1024,
      );
      await fs.writeFile(path.join(resources, name), bytes, {
        flag: "wx",
        mode,
      });
    }
    const nested = path.join(
      staging,
      "Contents/Frameworks/Electron Runtime.app",
    );
    await fs.mkdir(path.dirname(nested), { recursive: true, mode: 0o700 });
    await fs.cp(vendor, nested, { recursive: true, verbatimSymlinks: true });
    assertEmbeddedRuntime(await observeEmbeddedRuntime(nested));
    await verifyBuildEntries(resources, manifest.entrySha256, entries);
    await verifyInputManifest(resources, manifest);
    await verifyGoCoreArtifact(resources, manifest.core, build);
    const digest = await treeDigest(staging);
    // Build admission has already settled the exact earlier Dev before a new
    // build. Same-build checks return above without replacing live resources.
    if (present) {
      await ownedDirectory(bundle);
      if ((await treeDigest(bundle)) !== previous.treeDigest)
        throw new Error("DEV_CORE_RESOURCES_CHANGED");
      await fs.rm(bundle, { recursive: true });
    }
    await fs.rename(staging, bundle);
    published = true;
    const stagedReceipt = path.join(output, path.basename(staging) + ".json");
    await fs.writeFile(
      stagedReceipt,
      JSON.stringify({
        schema: 1,
        root: bundle,
        buildId: build.buildId,
        sourceCommit: build.sourceCommit,
        vendorDigest: runtime.extractedTreeDigest,
        treeDigest: digest,
      }) + "\n",
      { mode: 0o600 },
    );
    await fs.rename(stagedReceipt, receiptPath);
    return destination;
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
}
