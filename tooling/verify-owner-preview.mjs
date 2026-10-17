import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TREE_DIGEST_VERSION, treeDigest } from "./artifact-digest.mjs";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
} from "./candidate-contract.mjs";
import { ownerLaunchEnvironment } from "./launch-snapshot.mjs";
import {
  OWNER_PREVIEW_SCHEMA,
  OWNER_PREVIEW_APP,
  PREVIEW_ASSET_PATHS,
  PREVIEW_LAUNCHER_PATH,
  PREVIEW_LAUNCHER,
  PREVIEW_RECIPE,
  generationPaths,
  generationFromLink,
  previewPlist,
  requireOwnerPreviewRuntimeIntegration,
} from "./owner-preview-contract.mjs";
import { OWNER_PREVIEW_IDENTITY } from "../src/apps/desktop/desktop-environment.ts";
import {
  assertPreviewAssets,
  renderPreviewAssets,
} from "./owner-preview-assets.mjs";
import { sourceIdentity } from "./source-identity.mjs";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function physicalDirectory(
  directory,
  { privateMode = false } = {},
) {
  const absolute = path.resolve(directory);
  const info = await fs.lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await fs.realpath(absolute)) !== absolute ||
    (privateMode &&
      ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()))
  )
    throw new Error("OWNER_PREVIEW_DIRECTORY_INVALID");
  // realpath equality alone would miss a parent link resolving back into place.
  for (let parent = path.dirname(absolute); ; parent = path.dirname(parent)) {
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("OWNER_PREVIEW_DIRECTORY_INVALID");
    if (parent === path.dirname(parent)) break;
  }
  return info;
}

export async function regularBytes(file, maximum = 1024 * 1024) {
  await physicalDirectory(path.dirname(file));
  const handle = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error("OWNER_PREVIEW_FILE_INVALID");
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    for (const field of [
      "dev",
      "ino",
      "size",
      "mode",
      "nlink",
      "mtimeNs",
      "ctimeNs",
    ])
      if (before[field] !== after[field] || before[field] !== named[field])
        throw new Error("OWNER_PREVIEW_FILE_CHANGED");
    if (BigInt(bytes.length) !== before.size)
      throw new Error("OWNER_PREVIEW_FILE_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

// Content-only verifier with no process/native calls. Its fixtures do not
// authenticate canonical packages: verifyOwnerPreview always does that first.
async function inventory(app) {
  await physicalDirectory(app);
  await treeDigest(app); // rejects escaping/dangling links and special files
  const result = new Map();
  async function walk(relative) {
    const file = path.join(app, relative);
    const stat = await fs.lstat(file);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink())
      result.set(relative, {
        kind: "link",
        mode,
        target: await fs.readlink(file),
      });
    else if (stat.isDirectory()) {
      result.set(relative, { kind: "directory", mode });
      for (const name of (await fs.readdir(file)).sort())
        await walk(path.join(relative, name));
    } else if (stat.isFile())
      result.set(relative, {
        kind: "file",
        mode,
        sha256: sha256(await fs.readFile(file)),
      });
    else throw new Error("OWNER_PREVIEW_TREE_ENTRY_INVALID");
  }
  await walk("");
  return result;
}

export async function assertDerivativeTrees(baseApp, previewApp, assets) {
  assertPreviewAssets(assets);
  const base = await inventory(baseApp);
  const actual = await inventory(previewApp);
  const expected = new Map(base);
  for (const name of ["Contents/Info.plist", PREVIEW_LAUNCHER_PATH]) {
    if (base.get(name)?.kind !== "file")
      throw new Error("OWNER_PREVIEW_BASE_ENTRY_INVALID");
  }
  expected.set("Contents/Info.plist", {
    ...base.get("Contents/Info.plist"),
    sha256: sha256(
      previewPlist(
        await fs.readFile(path.join(baseApp, "Contents/Info.plist"), "utf8"),
      ),
    ),
  });
  expected.set(PREVIEW_LAUNCHER_PATH, {
    ...base.get(PREVIEW_LAUNCHER_PATH),
    sha256: sha256(PREVIEW_LAUNCHER),
  });
  for (const [name, relative] of Object.entries(PREVIEW_ASSET_PATHS)) {
    if (base.has(relative))
      throw new Error("OWNER_PREVIEW_BASE_ASSET_CONFLICT");
    expected.set(relative, {
      kind: "file",
      mode: 0o644,
      sha256: sha256(assets[name]),
    });
  }
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    try {
      assert.deepEqual(actual.get(name), expected.get(name));
    } catch {
      throw new Error(`OWNER_PREVIEW_TREE_DIFFERENCE:${name}`);
    }
  }
  return treeDigest(previewApp);
}

// Darwin applies umask to newly copied symlinks too. Restore only the mode
// of each copied link itself, never chmod its target or the canonical input.
async function preserveCopiedLinkModes(base, copied) {
  for (const name of await fs.readdir(base)) {
    const source = path.join(base, name);
    const target = path.join(copied, name);
    const before = await fs.lstat(source);
    if (before.isSymbolicLink()) {
      const after = await fs.lstat(target);
      if (
        !after.isSymbolicLink() ||
        (await fs.readlink(source)) !== (await fs.readlink(target))
      )
        throw new Error("OWNER_PREVIEW_COPIED_LINK_CHANGED");
      if ((after.mode & 0o7777) !== (before.mode & 0o7777)) {
        if (typeof fs.lchmod !== "function")
          throw new Error("OWNER_PREVIEW_LINK_MODE_UNSUPPORTED");
        await fs.lchmod(target, before.mode & 0o7777);
      }
    } else if (before.isDirectory()) {
      const after = await fs.lstat(target);
      if (!after.isDirectory() || after.isSymbolicLink())
        throw new Error("OWNER_PREVIEW_COPIED_DIRECTORY_CHANGED");
      await preserveCopiedLinkModes(source, target);
    }
  }
}

export async function derivePreviewTree(baseApp, previewApp, assets) {
  assertPreviewAssets(assets);
  const baseInfo = await physicalDirectory(baseApp);
  await treeDigest(baseApp);
  await fs.mkdir(previewApp, { mode: baseInfo.mode & 0o7777 });
  await fs.chmod(previewApp, baseInfo.mode & 0o7777);
  // The root was exclusively created above. Copy each child into an absent
  // destination: Node 24 correctly rejects cp's errorOnExist for an existing
  // root directory. Never relax that guard or merge into an old generation.
  for (const name of (await fs.readdir(baseApp)).sort()) {
    await fs.cp(path.join(baseApp, name), path.join(previewApp, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
  await preserveCopiedLinkModes(baseApp, previewApp);
  const plist = path.join(previewApp, "Contents/Info.plist");
  await fs.writeFile(plist, previewPlist(await fs.readFile(plist, "utf8")));
  await fs.writeFile(
    path.join(previewApp, PREVIEW_LAUNCHER_PATH),
    PREVIEW_LAUNCHER,
  );
  for (const [name, relative] of Object.entries(PREVIEW_ASSET_PATHS)) {
    const file = path.join(previewApp, relative);
    await fs.writeFile(file, assets[name], { flag: "wx", mode: 0o644 });
    // Creation applies the operator's umask. Set only this new file to its
    // exact sealed-recipe mode; all copied canonical modes stay untouched.
    await fs.chmod(file, 0o644);
  }
  return assertDerivativeTrees(baseApp, previewApp, assets);
}

export function derivativeManifest(base, baseBytes, appTreeDigest) {
  return {
    schema: OWNER_PREVIEW_SCHEMA,
    sourceCommit: base.sourceCommit,
    sourceTreeDigest: base.sourceTreeDigest,
    baseManifestSha256: sha256(baseBytes),
    baseArtifactSha256: base.artifactSha256,
    baseBuildId: base.buildId,
    identity: OWNER_PREVIEW_IDENTITY,
    recipe: PREVIEW_RECIPE,
    treeDigestVersion: TREE_DIGEST_VERSION,
    appTreeDigest,
  };
}
export const generationIdentity = (manifest) => sha256(jsonBytes(manifest));

export function verifyCanonicalSnapshot(repositoryRoot, artifactFile, appPath) {
  // Identical supported frozen-input semantics to launch-snapshot: keep the
  // canonical manifest, including artifactPath, unchanged; select copied bytes.
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "tooling/verify-package.mjs"),
      "--artifact",
      artifactFile,
      "--app",
      appPath,
    ],
    {
      cwd: repositoryRoot,
      env: ownerLaunchEnvironment(),
      encoding: "utf8",
      timeout: 120000,
    },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `OWNER_PREVIEW_CANONICAL_VERIFY_FAILED:${result.error?.code ?? result.signal ?? result.status}:${result.stderr ?? ""}`,
    );
  return result.stdout.trim();
}

export async function verifyOwnerPreview(repositoryRoot, generation) {
  requireOwnerPreviewRuntimeIntegration();
  const paths = generationPaths(repositoryRoot, generation);
  await physicalDirectory(path.join(repositoryRoot, "_output/preview"), {
    privateMode: true,
  });
  await physicalDirectory(path.dirname(paths.directory), { privateMode: true });
  await physicalDirectory(paths.directory, { privateMode: true });
  await physicalDirectory(path.join(paths.directory, ".canonical"), {
    privateMode: true,
  });
  assert.deepEqual(
    (await fs.readdir(paths.directory)).sort(),
    [".canonical", OWNER_PREVIEW_APP, "derivative.json"].sort(),
  );
  assert.deepEqual(
    (await fs.readdir(path.join(paths.directory, ".canonical"))).sort(),
    ["Farol.app", "artifact.json"],
  );
  for (const file of [paths.baseArtifact, paths.artifactFile]) {
    const info = await fs.lstat(file);
    if ((info.mode & 0o7777) !== 0o600 || info.uid !== process.getuid?.())
      throw new Error("OWNER_PREVIEW_MANIFEST_MODE_INVALID");
  }
  const baseBytes = await regularBytes(paths.baseArtifact);
  const base = JSON.parse(baseBytes.toString("utf8"));
  assertCanonicalArtifactPath(repositoryRoot, base);
  if (base.schema !== 7) throw new Error("OWNER_PREVIEW_GO_PACKAGE_REQUIRED");
  const source = sourceIdentity(repositoryRoot);
  assertExactSourceIdentity(
    source,
    base,
    "OWNER_PREVIEW_BASE_SOURCE_NOT_EXACT",
  );
  const canonicalReceipt = verifyCanonicalSnapshot(
    repositoryRoot,
    paths.baseArtifact,
    paths.baseApp,
  );
  // Reconstruct assets from the pinned source SVG with fixed local build tools;
  // an artifact's self-reported asset hashes cannot grant extra changed bytes.
  const assets = await renderPreviewAssets(repositoryRoot);
  const digest = await assertDerivativeTrees(
    paths.baseApp,
    paths.appPath,
    assets,
  );
  const manifest = JSON.parse(
    (await regularBytes(paths.artifactFile)).toString("utf8"),
  );
  assert.deepEqual(manifest, derivativeManifest(base, baseBytes, digest));
  if (generationIdentity(manifest) !== generation)
    throw new Error("OWNER_PREVIEW_GENERATION_DIGEST_MISMATCH");
  // Retest both trees after comparison, never just trust manifest hashes.
  if (
    (await treeDigest(paths.baseApp)) !== base.artifactSha256 ||
    (await treeDigest(paths.appPath)) !== digest
  )
    throw new Error("OWNER_PREVIEW_ARTIFACT_CHANGED");
  assertExactSourceIdentity(
    sourceIdentity(repositoryRoot),
    base,
    "OWNER_PREVIEW_SOURCE_CHANGED",
  );
  return { ...paths, manifest, canonicalReceipt };
}

export async function pinCurrentGeneration(repositoryRoot) {
  const preview = path.join(repositoryRoot, "_output/preview");
  await physicalDirectory(preview, { privateMode: true });
  const current = path.join(preview, OWNER_PREVIEW_APP);
  if (!(await fs.lstat(current)).isSymbolicLink())
    throw new Error("OWNER_PREVIEW_CURRENT_LINK_INVALID");
  const generation = generationFromLink(await fs.readlink(current));
  const pinned = generationPaths(repositoryRoot, generation);
  await physicalDirectory(pinned.directory, { privateMode: true });
  if ((await fs.realpath(current)) !== pinned.appPath)
    throw new Error("OWNER_PREVIEW_CURRENT_LINK_INVALID");
  return pinned;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Usage: node tooling/verify-owner-preview.mjs");
    const root = await fs.realpath(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    );
    const pinned = await pinCurrentGeneration(root);
    const result = await verifyOwnerPreview(root, pinned.generation);
    process.stdout.write(
      `verified owner Preview ${result.generation} from ${result.manifest.sourceCommit}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
