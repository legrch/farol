import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { readSupervisedGoCore } from "../../tooling/supervised-update-go-core.mjs";

// Disposable files only. The caller's resource capture has already verified the
// whole package; this reader only selects the target's own Go declaration.
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const identity = createBuildIdentity({
  version: "0.3.0-owner.beta.1",
  updateChannel: "github-owner-beta",
  buildVersion: "18",
  builtAt: "2026-10-20T00:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  sourceDirty: false,
});
const expected = {
  version: identity.version,
  buildVersion: identity.buildVersion,
  buildId: identity.buildId,
  sourceCommit: identity.sourceCommit,
  sourceTreeDigest: identity.sourceTreeDigest,
  artifactSha256: "c".repeat(64),
};
const declaration = (changes = {}) => ({
  schema: "farol-core-artifact/1",
  build: {
    buildId: identity.buildId,
    sourceSHA: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    platform: { goos: "darwin", goarch: "arm64" },
  },
  binary: { path: "farol-backend", size: 4096, sha256: "d".repeat(64) },
  ...changes,
});

async function app({
  manifest = { schema: 4, core: declaration() },
  build = identity,
  mode = 0o600,
} = {}) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-supervised-go-core-"),
  );
  roots.push(root);
  const appPath = path.join(root, "Farol.app");
  const resources = path.join(appPath, "Contents/Resources/app");
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(
    path.join(resources, "build-manifest.json"),
    JSON.stringify(manifest),
    { mode },
  );
  await fs.writeFile(
    path.join(resources, "build-identity.json"),
    JSON.stringify(build),
    { mode },
  );
  // A creation mode is filtered by the umask; set the exact mode explicitly.
  for (const name of ["build-manifest.json", "build-identity.json"])
    await fs.chmod(path.join(resources, name), mode);
  return { appPath, resources };
}

describe("supervised target Go declaration", () => {
  it("returns the package's own declaration and canonical build", async () => {
    const f = await app();
    const result = await readSupervisedGoCore({
      appPath: f.appPath,
      expected,
    });
    expect(result.goCoreArtifact).toEqual(declaration());
    expect(result.goCoreBuild).toEqual(identity);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["a legacy package with no core entry", { manifest: { schema: 3 } }],
    [
      "a schema-3 manifest that claims a core",
      { manifest: { schema: 3, core: declaration() } },
    ],
    ["a null core", { manifest: { schema: 4, core: null } }],
    ["a core-less schema-4 manifest", { manifest: { schema: 4 } }],
    [
      "a group-writable file",
      { manifest: { schema: 4, core: declaration() }, mode: 0o660 },
    ],
  ])("requires a compiled core: %s", async (_name, selection) => {
    const f = await app(selection);
    await expect(
      readSupervisedGoCore({ appPath: f.appPath, expected }),
    ).rejects.toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it.each([
    ["version", { version: "0.3.0-owner.beta.2" }],
    ["build version", { buildVersion: "19" }],
    ["build id", { buildId: "e".repeat(64) }],
    ["source commit", { sourceCommit: "f".repeat(40) }],
    ["source tree", { sourceTreeDigest: "e".repeat(64) }],
  ])("refuses a build that is not the selected %s", async (_name, claim) => {
    const f = await app();
    await expect(
      readSupervisedGoCore({
        appPath: f.appPath,
        expected: { ...expected, ...claim },
      }),
    ).rejects.toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it("refuses a dirty build identity", async () => {
    const dirty = createBuildIdentity({ ...identity, sourceDirty: true });
    const f = await app({ build: dirty });
    await expect(
      readSupervisedGoCore({
        appPath: f.appPath,
        expected: { ...expected, buildId: dirty.buildId },
      }),
    ).rejects.toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it("refuses a non-canonical build identity and a declaration for another build", async () => {
    const f = await app({ build: { ...identity, builtAt: "yesterday" } });
    await expect(
      readSupervisedGoCore({ appPath: f.appPath, expected }),
    ).rejects.toThrow("BUILD_IDENTITY_INVALID");
    const other = await app({
      manifest: {
        schema: 4,
        core: declaration({
          build: { ...declaration().build, sourceSHA: "9".repeat(40) },
        }),
      },
    });
    await expect(
      readSupervisedGoCore({ appPath: other.appPath, expected }),
    ).rejects.toThrow("GO_CORE_ARTIFACT_INVALID");
  });

  it("refuses a symlinked declaration source and a non-canonical app path", async () => {
    const f = await app();
    const file = path.join(f.resources, "build-manifest.json");
    await fs.rename(file, file + ".original");
    await fs.symlink(file + ".original", file);
    await expect(
      readSupervisedGoCore({ appPath: f.appPath, expected }),
    ).rejects.toThrow();
    await expect(
      readSupervisedGoCore({ appPath: f.appPath + "/", expected }),
    ).rejects.toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
    await expect(
      readSupervisedGoCore({ appPath: "relative/Farol.app", expected }),
    ).rejects.toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });
});
