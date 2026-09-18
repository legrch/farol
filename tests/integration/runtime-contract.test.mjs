import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TREE_DIGEST_VERSION,
  treeDigest,
} from "../../tooling/artifact-digest.mjs";
import {
  ELECTRON_RUNTIME,
  assertEmbeddedRuntime,
  assertRuntimeClosure,
  assertRuntimeExpectation,
  assertRuntimeObservation,
  observeElectronRuntime,
  observeEmbeddedRuntime,
  runtimeClosure,
} from "../../tooling/runtime-contract.mjs";

// HR-013/F1: the packaged runtime must be bound to the vendor distribution the
// owner verified, not to whatever `node_modules` currently holds. A stale
// runtime whose manifest hashes agree with themselves, and same-version bytes
// modified after extraction, must both be refused before packaging.

const nextRoot = path.resolve(import.meta.dirname, "../..");
const relativePath = "Contents/Frameworks/Electron Runtime.app";
const expected = Object.freeze({
  version: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  bundleIdentifier: "com.github.Electron",
  executable: "Electron",
  distribution: Object.freeze({
    asset: "electron-v1.2.3-darwin-arm64.zip",
    sha256: "a".repeat(64),
  }),
  treeDigestVersion: TREE_DIGEST_VERSION,
  extractedTreeDigest: "b".repeat(64),
});
const observed = Object.freeze({
  packageVersion: "1.2.3",
  versionFile: "v1.2.3",
  bundleVersion: "1.2.3",
  bundleIdentifier: "com.github.Electron",
  executable: "Electron",
  distributionAsset: "electron-v1.2.3-darwin-arm64.zip",
  distributionSha256: "a".repeat(64),
  treeDigestVersion: TREE_DIGEST_VERSION,
  extractedTreeDigest: "b".repeat(64),
});
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function plist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

async function syntheticElectronPackage({ version, checksums }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-runtime-"));
  roots.push(root);
  const app = path.join(root, "dist/Electron.app/Contents");
  await fs.mkdir(path.join(app, "MacOS"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "electron", version }),
  );
  await fs.writeFile(
    path.join(root, "checksums.json"),
    JSON.stringify(checksums),
  );
  await fs.writeFile(path.join(root, "dist/version"), `v${version}\n`);
  await fs.writeFile(path.join(app, "Info.plist"), plist(version));
  await fs.writeFile(path.join(app, "MacOS/Electron"), `binary ${version}\n`, {
    mode: 0o755,
  });
  return root;
}

describe("reviewed Electron runtime contract", () => {
  it("accepts the observation that matches the pinned expectation", () => {
    expect(assertRuntimeObservation(observed, expected)).toBe(expected);
    expect(
      assertRuntimeObservation({ ...observed, versionFile: "1.2.3" }, expected),
    ).toBe(expected);
    expect(assertRuntimeExpectation(ELECTRON_RUNTIME)).toBe(ELECTRON_RUNTIME);
  });

  it.each([
    [
      "a stale runtime whose self-hashes agree",
      {
        packageVersion: "1.2.2",
        versionFile: "v1.2.2",
        bundleVersion: "1.2.2",
        distributionAsset: "electron-v1.2.2-darwin-arm64.zip",
        distributionSha256: "e".repeat(64),
        extractedTreeDigest: "d".repeat(64),
      },
      "RUNTIME_PACKAGE_VERSION_MISMATCH",
    ],
    [
      "a stale npm package version",
      { packageVersion: "1.2.2" },
      "RUNTIME_PACKAGE_VERSION_MISMATCH",
    ],
    [
      "a stale version file",
      { versionFile: "v1.2.2" },
      "RUNTIME_VERSION_FILE_MISMATCH",
    ],
    [
      "a bare stale version file",
      { versionFile: "1.2.2" },
      "RUNTIME_VERSION_FILE_MISMATCH",
    ],
    [
      "a version file with another shape",
      { versionFile: "1.2.3-beta.1" },
      "RUNTIME_VERSION_FILE_MISMATCH",
    ],
    [
      "a stale bundle version",
      { bundleVersion: "1.2.2" },
      "RUNTIME_BUNDLE_VERSION_MISMATCH",
    ],
    [
      "another bundle identity",
      { bundleIdentifier: "com.example.Runtime" },
      "RUNTIME_BUNDLE_IDENTITY_MISMATCH",
    ],
    [
      "another executable",
      { executable: "Runtime" },
      "RUNTIME_BUNDLE_IDENTITY_MISMATCH",
    ],
    [
      "a distribution the vendor did not publish",
      { distributionSha256: "f".repeat(64) },
      "RUNTIME_DISTRIBUTION_CHECKSUM_MISMATCH",
    ],
    [
      "a missing distribution checksum",
      { distributionSha256: null },
      "RUNTIME_DISTRIBUTION_CHECKSUM_MISMATCH",
    ],
    [
      "another distribution asset",
      { distributionAsset: "electron-v1.2.3-darwin-x64.zip" },
      "RUNTIME_DISTRIBUTION_CHECKSUM_MISMATCH",
    ],
    [
      "same-version bytes modified after extraction",
      { extractedTreeDigest: "c".repeat(64) },
      "RUNTIME_TREE_DIGEST_MISMATCH",
    ],
    [
      "a legacy tree digest encoding",
      { treeDigestVersion: "farol.next.tree-digest/v1" },
      "RUNTIME_TREE_DIGEST_MISMATCH",
    ],
  ])("refuses %s", (_name, drift, code) => {
    expect(() =>
      assertRuntimeObservation({ ...observed, ...drift }, expected),
    ).toThrow(code);
  });

  it.each([
    [
      "an asset that names another version",
      {
        distribution: {
          ...expected.distribution,
          asset: "electron-v1.2.2-darwin-arm64.zip",
        },
      },
    ],
    [
      "an asset that names another architecture",
      {
        distribution: {
          ...expected.distribution,
          asset: "electron-v1.2.3-darwin-x64.zip",
        },
      },
    ],
    [
      "a malformed distribution digest",
      { distribution: { ...expected.distribution, sha256: "xyz" } },
    ],
    ["a malformed extracted digest", { extractedTreeDigest: "abc" }],
    ["an unsupported platform", { platform: "linux" }],
    [
      "a legacy digest version",
      { treeDigestVersion: "farol.next.tree-digest/v1" },
    ],
  ])("refuses an expectation with %s", (_name, drift) => {
    expect(() => assertRuntimeExpectation({ ...expected, ...drift })).toThrow(
      "RUNTIME_EXPECTATION_INVALID",
    );
    expect(() =>
      assertRuntimeObservation(observed, { ...expected, ...drift }),
    ).toThrow("RUNTIME_EXPECTATION_INVALID");
  });

  it("reads the npm electron package the way the packager will", async () => {
    const root = await syntheticElectronPackage({
      version: "1.2.3",
      checksums: { "electron-v1.2.3-darwin-arm64.zip": "a".repeat(64) },
    });
    const observation = await observeElectronRuntime(root, expected);
    expect(observation).toMatchObject({
      packageVersion: "1.2.3",
      versionFile: "v1.2.3",
      bundleVersion: "1.2.3",
      bundleIdentifier: "com.github.Electron",
      executable: "Electron",
      distributionAsset: "electron-v1.2.3-darwin-arm64.zip",
      distributionSha256: "a".repeat(64),
      treeDigestVersion: TREE_DIGEST_VERSION,
      extractedTreeDigest: await treeDigest(
        path.join(root, "dist/Electron.app"),
      ),
    });
    expect(() =>
      assertRuntimeObservation(observation, {
        ...expected,
        extractedTreeDigest: observation.extractedTreeDigest,
      }),
    ).not.toThrow();
  });

  it("refuses a stale installed runtime even when its own files agree", async () => {
    const root = await syntheticElectronPackage({
      version: "1.2.2",
      checksums: { "electron-v1.2.2-darwin-arm64.zip": "e".repeat(64) },
    });
    const observation = await observeElectronRuntime(root, expected);
    expect(observation.distributionSha256).toBeNull();
    expect(() => assertRuntimeObservation(observation, expected)).toThrow(
      "RUNTIME_PACKAGE_VERSION_MISMATCH",
    );
  });

  it("observes the embedded runtime of a sealed package and refuses drift", async () => {
    const root = await syntheticElectronPackage({
      version: "1.2.3",
      checksums: { "electron-v1.2.3-darwin-arm64.zip": "a".repeat(64) },
    });
    const app = path.join(root, "dist/Electron.app");
    const embedded = await observeEmbeddedRuntime(app);
    expect(embedded).toEqual({
      bundleVersion: "1.2.3",
      bundleIdentifier: "com.github.Electron",
      executable: "Electron",
      treeDigestVersion: TREE_DIGEST_VERSION,
      extractedTreeDigest: await treeDigest(app),
    });
    const pinned = {
      ...expected,
      extractedTreeDigest: embedded.extractedTreeDigest,
    };
    expect(assertEmbeddedRuntime(embedded, pinned)).toBe(pinned);
    expect(() =>
      assertEmbeddedRuntime({ ...embedded, bundleVersion: "1.2.2" }, pinned),
    ).toThrow("RUNTIME_BUNDLE_VERSION_MISMATCH");
    expect(() => assertEmbeddedRuntime(embedded, expected)).toThrow(
      "RUNTIME_TREE_DIGEST_MISMATCH",
    );
    expect(() =>
      assertEmbeddedRuntime({ ...embedded, executable: "Runtime" }, pinned),
    ).toThrow("RUNTIME_BUNDLE_IDENTITY_MISMATCH");
  });

  it("writes and verifies the runtime closure of the artifact manifest", () => {
    const closure = runtimeClosure(expected, relativePath);
    expect(closure).toEqual({
      electron: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: {
        asset: "electron-v1.2.3-darwin-arm64.zip",
        sha256: "a".repeat(64),
      },
      node: "embedded-in-electron",
      testerManagedRuntime: false,
      layout: "nested-unmodified-vendor-bundle",
      relativePath,
    });
    expect(assertRuntimeClosure(closure, expected, relativePath)).toBe(closure);
    for (const drift of [
      { electron: "1.2.2" },
      { arch: "x64" },
      { distribution: { ...closure.distribution, sha256: "f".repeat(64) } },
      {
        distribution: {
          ...closure.distribution,
          asset: "electron-v1.2.2-darwin-arm64.zip",
        },
      },
      { testerManagedRuntime: true },
      { layout: "flat" },
      { relativePath: "Contents/Frameworks/Other.app" },
      { node: "24.20.0" },
    ]) {
      expect(() =>
        assertRuntimeClosure({ ...closure, ...drift }, expected, relativePath),
      ).toThrow("PACKAGE_RUNTIME_CLOSURE_INVALID");
    }
    expect(() =>
      assertRuntimeClosure(undefined, expected, relativePath),
    ).toThrow("PACKAGE_RUNTIME_CLOSURE_INVALID");
  });

  it("pins the installed electron dependency to the reviewed distribution", async () => {
    const packageDocument = JSON.parse(
      await fs.readFile(path.join(nextRoot, "package.json"), "utf8"),
    );
    expect(ELECTRON_RUNTIME.version).toBe(
      packageDocument.dependencies.electron,
    );
    const observation = await observeElectronRuntime(
      path.join(nextRoot, "node_modules/electron"),
    );
    expect(assertRuntimeObservation(observation)).toBe(ELECTRON_RUNTIME);
  }, 60_000);
});
