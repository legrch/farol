import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  treeDigest,
  TREE_DIGEST_VERSION,
} from "../../tooling/artifact-digest.mjs";
import { verifyPackageContent } from "../../tooling/verify-package-content.mjs";
import { captureSupervisedUpdateResources } from "../../tooling/supervised-update-resources.mjs";

// Only the full package verifier is mocked. These are disposable native-FS
// identity/adapter tests, not real package, executable, or installed evidence.
vi.mock("../../tooling/verify-package-content.mjs", () => ({
  verifyPackageContent: vi.fn(),
}));
const roots = [];
function identity({ artifact }) {
  return {
    product: artifact.product,
    bundleId: artifact.bundleId,
    version: artifact.version,
    buildVersion: artifact.buildVersion,
    buildId: artifact.buildId,
    updateChannel: artifact.updateChannel,
    sourceCommit: artifact.sourceCommit,
    sourceTreeDigest: artifact.sourceTreeDigest,
    artifactSha256: artifact.artifactSha256,
    signing: "unsigned",
    notarized: false,
  };
}
beforeEach(() => {
  vi.mocked(verifyPackageContent)
    .mockReset()
    .mockImplementation(async (options) => identity(options));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-supervised-resources-"),
  );
  roots.push(root);
  const parent = path.join(root, "candidate");
  await fs.mkdir(parent, { mode: 0o700 });
  const appPath = path.join(parent, "Farol.app");
  await fs.mkdir(path.join(appPath, "Contents/Resources/app"), {
    recursive: true,
    mode: 0o755,
  });
  const payload = path.join(appPath, "Contents/payload");
  await fs.writeFile(payload, "adapter fixture, not a package", {
    mode: 0o644,
  });
  await fs.writeFile(
    path.join(appPath, "Contents/Resources/app/update-package.mjs"),
    "throw new Error('CANDIDATE_MUST_NEVER_EXECUTE');\n",
    { mode: 0o644 },
  );
  const expected = {
    version: "0.2.0-owner.beta.1",
    buildVersion: "15",
    buildId: "b".repeat(64),
    sourceCommit: "c".repeat(40),
    sourceTreeDigest: "d".repeat(64),
    artifactSha256: await treeDigest(appPath),
  };
  const artifact = {
    schema: 7,
    treeDigestVersion: TREE_DIGEST_VERSION,
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    ...expected,
    builtAt: "2026-10-05T00:00:00.000Z",
    sourceDirty: false,
    // A relocated manifest retains this provenance. It never selects the read path.
    artifactPath: "/private/never-read-this-provenance/Farol.app",
    electronSourceSha256: "e".repeat(64),
    runtime: { distribution: { asset: "fixture.zip", sha256: "f".repeat(64) } },
    signing: {
      kind: "unsigned",
      reason: "owner-beta-distribution",
      runtimeBytes: "unmodified-vendor-bundle",
    },
    notarized: false,
    updateChannel: "github-owner-beta",
  };
  const artifactFile = path.join(parent, "artifact.json");
  const bytes = JSON.stringify(artifact) + "\n";
  await fs.writeFile(artifactFile, bytes, { mode: 0o600 });
  return {
    root,
    parent,
    appPath,
    payload,
    artifactFile,
    expected,
    artifact,
    bytes,
  };
}
const capture = (f) =>
  captureSupervisedUpdateResources({
    appPath: f.appPath,
    artifactFile: f.artifactFile,
    expected: f.expected,
  });
async function writeArtifact(f, value) {
  await fs.writeFile(f.artifactFile, JSON.stringify(value), { mode: 0o600 });
}
async function replaceApp(f) {
  const old = path.join(f.root, "old.app");
  await fs.rename(f.appPath, old);
  await fs.cp(old, f.appPath, { recursive: true, preserveTimestamps: true });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("supervised resources (native FS, mocked package verifier)", () => {
  it("uses the selected app and full trusted verifier, freezes claims, and revalidates read-only", async () => {
    const f = await fixture();
    // Owner-safe public-readable package output is allowed; state need not be created.
    await fs.chmod(f.parent, 0o755);
    await fs.chmod(f.artifactFile, 0o644);
    const result = await capture(f);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.artifact.runtime.distribution)).toBe(true);
    expect(Object.isFrozen(result.artifact.signing)).toBe(true);
    expect(result.app).toBe(f.appPath);
    expect(result.artifact).toEqual(f.artifact);
    expect(verifyPackageContent).toHaveBeenCalledExactlyOnceWith({
      artifact: result.artifact,
      appPath: f.appPath,
      expectedVersion: f.expected.version,
      expectedBuildVersion: f.expected.buildVersion,
      expectedChannel: "github-owner-beta",
      onVerifiedGoCore: expect.any(Function),
    });
    f.expected.buildId = "0".repeat(64);
    expect(await result.verify()).toBe(true);
    expect(verifyPackageContent).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(f.artifactFile, "utf8")).toBe(f.bytes);
    expect((await fs.readdir(f.parent)).sort()).toEqual([
      "Farol.app",
      "artifact.json",
    ]);
  });

  it("accepts the exact 64 KiB read bound without changing artifact bytes", async () => {
    const f = await fixture();
    const bytes = f.bytes.padEnd(65536, " ");
    await fs.writeFile(f.artifactFile, bytes);
    const result = await capture(f);
    expect(await result.verify()).toBe(true);
    expect(await fs.readFile(f.artifactFile, "utf8")).toBe(bytes);
  });

  it("allows unrelated sibling activity while retaining canonical parent identities", async () => {
    const f = await fixture();
    const result = await capture(f);
    await fs.mkdir(path.join(f.parent, "sibling"), { mode: 0o700 });
    await fs.writeFile(path.join(f.parent, "sibling/receipt.json"), "{}", {
      mode: 0o600,
    });
    expect(await result.verify()).toBe(true);
  });

  it.each([
    "relative-app",
    "relative-artifact",
    "dot-segment",
    "trailing-slash",
    "nul",
    "wrong-app-name",
  ])("refuses %s before invoking package verification", async (kind) => {
    const f = await fixture();
    if (kind === "relative-app") f.appPath = "Farol.app";
    if (kind === "relative-artifact") f.artifactFile = "artifact.json";
    if (kind === "dot-segment") f.appPath = f.parent + "/./Farol.app";
    if (kind === "trailing-slash") f.appPath += "/";
    if (kind === "nul") f.artifactFile += "\0";
    if (kind === "wrong-app-name") f.appPath = path.join(f.parent, "Other.app");
    await expect(capture(f)).rejects.toThrow("PATH_INVALID");
    expect(verifyPackageContent).not.toHaveBeenCalled();
  });

  it.each([
    "parent-symlink",
    "artifact-symlink",
    "app-symlink",
    "artifact-hardlink",
    "artifact-directory",
    "shared-parent",
    "shared-artifact",
    "shared-app",
  ])("refuses native %s paths before invoking the verifier", async (kind) => {
    const f = await fixture();
    if (kind === "parent-symlink") {
      await fs.rename(f.parent, f.parent + ".original");
      await fs.symlink(f.parent + ".original", f.parent);
    }
    if (kind === "artifact-symlink") {
      await fs.rename(f.artifactFile, f.artifactFile + ".original");
      await fs.symlink(f.artifactFile + ".original", f.artifactFile);
    }
    if (kind === "app-symlink") {
      await fs.rename(f.appPath, path.join(f.root, "original.app"));
      await fs.symlink(path.join(f.root, "original.app"), f.appPath);
    }
    if (kind === "artifact-hardlink")
      await fs.link(f.artifactFile, path.join(f.root, "alias.json"));
    if (kind === "artifact-directory") {
      await fs.unlink(f.artifactFile);
      await fs.mkdir(f.artifactFile);
    }
    if (kind === "shared-parent") await fs.chmod(f.parent, 0o777);
    if (kind === "shared-artifact") await fs.chmod(f.artifactFile, 0o666);
    if (kind === "shared-app") await fs.chmod(f.appPath, 0o777);
    await expect(capture(f)).rejects.toThrow(/SUPERVISED_RESOURCES_/u);
    expect(verifyPackageContent).not.toHaveBeenCalled();
  });

  it.each([
    "empty",
    "oversized",
    "invalid-json",
    "invalid-utf8",
    "utf8-bom",
    "array",
  ])("refuses %s artifact bytes before invoking the verifier", async (kind) => {
    const f = await fixture();
    const bytes = {
      empty: "",
      oversized: " ".repeat(65537),
      "invalid-json": "{",
      "invalid-utf8": Buffer.from([0xff]),
      "utf8-bom": Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(f.bytes),
      ]),
      array: "[]",
    }[kind];
    await fs.writeFile(f.artifactFile, bytes);
    await expect(capture(f)).rejects.toThrow();
    expect(verifyPackageContent).not.toHaveBeenCalled();
  });

  it.each([
    "version",
    "buildVersion",
    "buildId",
    "sourceCommit",
    "sourceTreeDigest",
    "artifactSha256",
    "sourceDirty",
    "schema",
    "updateChannel",
  ])("requires exact accepted %s claims", async (claim) => {
    const f = await fixture();
    const changes = {
      version: "0.2.0-owner.beta.2",
      buildVersion: "16",
      buildId: "0".repeat(64),
      sourceCommit: "0".repeat(40),
      sourceTreeDigest: "0".repeat(64),
      artifactSha256: "0".repeat(64),
      sourceDirty: true,
      schema: 6,
      updateChannel: "github-stable",
    };
    await writeArtifact(f, { ...f.artifact, [claim]: changes[claim] });
    await expect(capture(f)).rejects.toThrow("ARTIFACT_CLAIMS");
    expect(verifyPackageContent).not.toHaveBeenCalled();
  });

  it.each([
    "noncanonical-version",
    "numeric-build",
    "invalid-sha",
    "extra-claim",
  ])("refuses %s expectations", async (kind) => {
    const f = await fixture();
    if (kind === "noncanonical-version")
      f.expected.version = "00.2.0-owner.beta.1";
    if (kind === "numeric-build") f.expected.buildVersion = 15;
    if (kind === "invalid-sha") f.expected.sourceCommit = "unknown";
    if (kind === "extra-claim") f.expected.channel = "stable";
    await expect(capture(f)).rejects.toThrow("EXPECTED_INVALID");
    expect(verifyPackageContent).not.toHaveBeenCalled();
  });

  it.each(["throws", "wrong-identity"])(
    "rejects a verifier that %s",
    async (kind) => {
      const f = await fixture();
      vi.mocked(verifyPackageContent).mockImplementationOnce(
        async (options) => {
          if (kind === "throws") throw new Error("fixture package refusal");
          return { ...identity(options), sourceTreeDigest: "0".repeat(64) };
        },
      );
      await expect(capture(f)).rejects.toThrow(
        kind === "throws" ? "fixture package refusal" : "PACKAGE_IDENTITY",
      );
    },
  );

  it.each([
    "app-root",
    "artifact-inode",
    "parent-root",
    "app-content",
    "artifact-bytes",
    "parent-mode",
  ])("sticks to refusal after native %s changes", async (kind) => {
    const f = await fixture();
    const result = await capture(f);
    if (kind === "app-root") await replaceApp(f);
    if (kind === "artifact-inode") {
      await fs.rename(f.artifactFile, path.join(f.root, "original.json"));
      await fs.writeFile(f.artifactFile, f.bytes, { mode: 0o600 });
    }
    if (kind === "parent-root") {
      const retained = path.join(f.root, "retained");
      await fs.rename(f.parent, retained);
      await fs.mkdir(f.parent, { mode: 0o700 });
      await fs.rename(path.join(retained, "Farol.app"), f.appPath);
      await fs.rename(path.join(retained, "artifact.json"), f.artifactFile);
    }
    if (kind === "app-content")
      await fs.writeFile(f.payload, "different content");
    if (kind === "artifact-bytes") await fs.appendFile(f.artifactFile, " ");
    if (kind === "parent-mode") await fs.chmod(f.parent, 0o777);
    expect(await result.verify()).toBe(false);
    const calls = vi.mocked(verifyPackageContent).mock.calls.length;
    if (kind === "parent-mode") await fs.chmod(f.parent, 0o700);
    if (kind === "app-content")
      await fs.writeFile(f.payload, "adapter fixture, not a package");
    if (kind === "artifact-bytes") await fs.writeFile(f.artifactFile, f.bytes);
    expect(await result.verify()).toBe(false);
    expect(verifyPackageContent).toHaveBeenCalledTimes(calls);
  });

  it.each(["app-root", "app-content", "artifact-bytes", "parent-root"])(
    "detects %s mutation during the full verifier before publishing",
    async (kind) => {
      const f = await fixture();
      vi.mocked(verifyPackageContent).mockImplementationOnce(
        async (options) => {
          if (kind === "app-root") await replaceApp(f);
          if (kind === "app-content")
            await fs.writeFile(f.payload, "changed during verification");
          if (kind === "artifact-bytes")
            await fs.appendFile(f.artifactFile, " ");
          if (kind === "parent-root") {
            const retained = path.join(f.root, "retained");
            await fs.rename(f.parent, retained);
            await fs.mkdir(f.parent, { mode: 0o700 });
            await fs.rename(path.join(retained, "Farol.app"), f.appPath);
            await fs.rename(
              path.join(retained, "artifact.json"),
              f.artifactFile,
            );
          }
          return identity(options);
        },
      );
      await expect(capture(f)).rejects.toThrow(/SUPERVISED_RESOURCES_/u);
    },
  );

  it("exposes the Go declaration the verifier checked, never a later read of the package", async () => {
    const f = await fixture();
    const verified = {
      core: { schema: "farol-core-artifact/1", fixture: "verified" },
      identity: { buildId: f.expected.buildId },
    };
    vi.mocked(verifyPackageContent).mockImplementation(async (options) => {
      options.onVerifiedGoCore({
        core: structuredClone(verified.core),
        identity: structuredClone(verified.identity),
      });
      return identity(options);
    });
    const result = await capture(f);
    expect(result.goCore).toEqual(verified);
    expect(Object.isFrozen(result.goCore.core)).toBe(true);
    expect(await result.verify()).toBe(true);
    // A substituted declaration on disk is never adopted: the captured value
    // stays, and the content fence refuses the changed package.
    await fs.writeFile(
      path.join(f.appPath, "Contents/Resources/app/build-manifest.json"),
      JSON.stringify({ schema: 4, core: { fixture: "substituted" } }),
    );
    expect(await result.verify()).toBe(false);
    expect(result.goCore).toEqual(verified);
  });

  it("refuses a later observation whose verified declaration differs", async () => {
    const f = await fixture();
    let core = { fixture: "first" };
    vi.mocked(verifyPackageContent).mockImplementation(async (options) => {
      options.onVerifiedGoCore({ core, identity: { fixture: true } });
      return identity(options);
    });
    const result = await capture(f);
    core = { fixture: "second" };
    expect(await result.verify()).toBe(false);
    expect(result.goCore.core).toEqual({ fixture: "first" });
  });

  it("reports no declaration for a package without a compiled core", async () => {
    const result = await capture(await fixture());
    expect(result.goCore).toBeNull();
  });

  it("shares a concurrent verification and never upgrades a failed observation", async () => {
    const f = await fixture();
    const result = await capture(f);
    const entered = deferred();
    const release = deferred();
    vi.mocked(verifyPackageContent).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("fixture lost verification");
    });
    const first = result.verify();
    await entered.promise;
    const second = result.verify();
    try {
      expect(second).toBe(first);
    } finally {
      release.resolve();
    }
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await result.verify()).toBe(false);
    expect(verifyPackageContent).toHaveBeenCalledTimes(2);
  });
});

it("binds an ordinary stable version to the stable channel", async () => {
  const f = await fixture();
  f.expected.version = "0.2.1";
  f.artifact.version = "0.2.1";
  f.artifact.updateChannel = "github-stable";
  f.artifact.signing.reason = "stable-distribution";
  await writeArtifact(f, f.artifact);
  const result = await capture(f);
  expect(await result.verify()).toBe(true);
  expect(verifyPackageContent).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedChannel: "github-stable",
      expectedVersion: "0.2.1",
    }),
  );
});
it("refuses a stable version bound to an owner-beta artifact", async () => {
  const f = await fixture();
  f.expected.version = "0.2.1";
  f.artifact.version = "0.2.1";
  await writeArtifact(f, f.artifact);
  await expect(capture(f)).rejects.toThrow("ARTIFACT_CLAIMS");
  expect(verifyPackageContent).not.toHaveBeenCalled();
});
