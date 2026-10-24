// Dev resource preparation only. No package publication, profile or credential IO.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareDevRuntime, verifyDevSignature } from "./dev-runtime.mjs";
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
  return info;
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

async function publishReceipt(output, destination, value) {
  const temporary = path.join(output, `.dev-core-receipt-${randomUUID()}.json`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeRetiredImage(output, receipt) {
  if (receipt?.schema !== 3 || receipt.retired === null) return;
  const retired = receipt.retired;
  if (
    !retired ||
    typeof retired.name !== "string" ||
    !/^\.dev-core-retired-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
      retired.name,
    ) ||
    !/^[0-9]+$/u.test(retired.device) ||
    !/^[0-9]+$/u.test(retired.inode)
  )
    throw new Error("DEV_CORE_RETIRED_INVALID");
  const directory = path.join(output, retired.name);
  let info;
  try {
    info = await ownedDirectory(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (String(info.dev) !== retired.device || String(info.ino) !== retired.inode)
    throw new Error("DEV_CORE_RETIRED_CHANGED");
  // The complete image was atomically moved here before cleanup. Its retained
  // directory identity permits resuming a partially completed recursive removal.
  await fs.rm(directory, { recursive: true });
}

function settledReceipt(previous) {
  const {
    previousTreeDigest: _previous,
    retired: _retired,
    ...settled
  } = previous;
  return { ...settled, schema: 1 };
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
  const observedDigest = present ? await treeDigest(bundle) : null;
  if (present) {
    // A pending publication records both complete images BEFORE retiring the
    // old one. Only either recorded image is recoverable; other edits refuse.
    if (
      ![1, 2, 3].includes(previous?.schema) ||
      previous.root !== bundle ||
      (observedDigest !== previous.treeDigest &&
        !(
          [2, 3].includes(previous.schema) &&
          observedDigest === previous.previousTreeDigest
        ))
    )
      throw new Error("DEV_CORE_RESOURCES_CHANGED");
    if (
      previous.buildId === build.buildId &&
      previous.vendorDigest === runtime.extractedTreeDigest &&
      observedDigest === previous.treeDigest
    ) {
      await verifyBuildEntries(destination, manifest.entrySha256, entries);
      await verifyInputManifest(destination, manifest);
      await verifyGoCoreArtifact(destination, manifest.core, build);
      assertEmbeddedRuntime(
        await observeEmbeddedRuntime(
          path.join(bundle, "Contents/Frameworks/Electron Runtime.app"),
        ),
      );
      verifyDevSignature(
        path.join(bundle, "Contents/Frameworks/Farol Dev.app"),
      );
      await removeRetiredImage(output, previous);
      if ([2, 3].includes(previous.schema)) {
        await publishReceipt(output, receiptPath, settledReceipt(previous));
      }
      return destination;
    }
  } else if (
    previous &&
    (![2, 3].includes(previous.schema) || previous.root !== bundle)
  ) {
    throw new Error("DEV_CORE_RESOURCES_MISSING");
  }
  await removeRetiredImage(output, previous);
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
    // Build the actual branded host from independently pinned vendor inputs
    // inside the protected image; never import the mutable legacy runtime cache.
    await prepareDevRuntime(root, path.join(staging, "Contents/Frameworks"));
    await verifyBuildEntries(resources, manifest.entrySha256, entries);
    await verifyInputManifest(resources, manifest);
    await verifyGoCoreArtifact(resources, manifest.core, build);
    const digest = await treeDigest(staging);
    // Publish the recoverable transition before removing any complete image.
    // This covers process interruption, not a power-loss durability claim.
    const receipt = {
      schema: 1,
      root: bundle,
      buildId: build.buildId,
      sourceCommit: build.sourceCommit,
      vendorDigest: runtime.extractedTreeDigest,
      treeDigest: digest,
    };
    if (present) {
      await ownedDirectory(bundle);
      if ((await treeDigest(bundle)) !== observedDigest)
        throw new Error("DEV_CORE_RESOURCES_CHANGED");
    }
    let retired = null;
    if (present) {
      const info = await ownedDirectory(bundle);
      retired = {
        name: `.dev-core-retired-${randomUUID()}`,
        device: String(info.dev),
        inode: String(info.ino),
      };
    }
    const transition = {
      ...receipt,
      schema: 3,
      previousTreeDigest: observedDigest,
      retired,
    };
    await publishReceipt(output, receiptPath, transition);
    if (present) {
      const info = await ownedDirectory(bundle);
      if (
        (await treeDigest(bundle)) !== observedDigest ||
        String(info.dev) !== retired.device ||
        String(info.ino) !== retired.inode
      )
        throw new Error("DEV_CORE_RESOURCES_CHANGED");
      await fs.rename(bundle, path.join(output, retired.name));
    }
    await fs.rename(staging, bundle);
    published = true;
    await removeRetiredImage(output, transition);
    await publishReceipt(output, receiptPath, receipt);
    return destination;
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
}
