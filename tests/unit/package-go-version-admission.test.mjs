import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_ENTRIES,
  LEGACY_BUILD_ENTRIES,
  bridgeEntrySets,
} from "../../tooling/build-contract.mjs";
import { GO_CORE_ENTRIES } from "../../tooling/go-core-artifact.mjs";
import { TREE_DIGEST_VERSION } from "../../tooling/artifact-digest.mjs";
import {
  ELECTRON_RUNTIME,
  runtimeClosure,
} from "../../tooling/runtime-contract.mjs";
import { verifyPackageContent } from "../../tooling/verify-package-content.mjs";

// Control-flow evidence only: scripted observations never attest package bytes.
// Every filesystem and native-process boundary used here is blocked or mocked.
const observations = vi.hoisted(() => ({
  treeDigest: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("../../tooling/artifact-digest.mjs", async (original) => ({
  ...(await original()),
  treeDigest: observations.treeDigest,
}));
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: observations.readdir,
    readFile: observations.readFile,
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: observations.execFileSync,
  spawnSync: observations.spawnSync,
}));

const currentVersion = "0.2.0-owner.beta.4";
const historicalVersion = "0.1.0-owner.beta.1";
const appPath = "/controlled/Farol.app";
const contents = `${appPath}/Contents`;
const resources = `${contents}/Resources/app`;

function fixture(
  schema = 7,
  version = currentVersion,
  expectedVersion = version,
) {
  return {
    artifact: {
      schema,
      treeDigestVersion: TREE_DIGEST_VERSION,
      product: "Farol",
      version,
      bundleId: "io.github.legrch.farol",
      sourceCommit: "a".repeat(40),
      sourceTreeDigest: "b".repeat(64),
      buildId: "c".repeat(64),
      builtAt: "2026-10-08T12:00:00.000Z",
      artifactSha256: "d".repeat(64),
      sourceDirty: false,
      signing: {
        kind: "unsigned",
        reason: "owner-beta-distribution",
        runtimeBytes: "unmodified-vendor-bundle",
      },
      electronSourceSha256: "e".repeat(64),
      notarized: false,
      updateChannel: "github-owner-beta",
      runtime: runtimeClosure(
        ELECTRON_RUNTIME,
        "Contents/Frameworks/Electron Runtime.app",
      ),
    },
    appPath: schema === 5 ? "/controlled/Farol Next Preview.app" : appPath,
    expectedVersion,
    expectedChannel: "github-owner-beta",
    assertArtifactPath: vi.fn(),
  };
}

beforeEach(() => {
  for (const observation of Object.values(observations)) {
    observation.mockReset();
    observation.mockImplementation(() => {
      throw new Error("OBSERVATION_BLOCKED");
    });
  }
});

function withoutEntries(...removed) {
  return [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].filter(
    (entry) => !removed.includes(entry),
  );
}

async function refusesBeforeObservation(input, code) {
  await expect(verifyPackageContent(input)).rejects.toThrow(code);
  expect(input.assertArtifactPath).not.toHaveBeenCalled();
  for (const observation of Object.values(observations))
    expect(observation).not.toHaveBeenCalled();
}

describe("shared package Go version admission", () => {
  for (const schema of [5, 6]) {
    it.each([
      "0.2.0",
      "0.2.1-preview.0",
      currentVersion,
      "0.2.12-owner.beta.0",
      "0.3.0-owner.beta.1",
      "0.4.0",
      "0.4.1",
      "0.10.0",
      "0.20.0",
      "1.0.0",
      "10.2.0",
      "9007199254740993.0.0",
    ])(`requires Go core for %s claiming schema ${schema}`, async (version) => {
      await refusesBeforeObservation(
        fixture(schema, version),
        "PACKAGE_GO_CORE_REQUIRED",
      );
    });
    it.each([
      [currentVersion, historicalVersion],
      [historicalVersion, currentVersion],
      [null, currentVersion],
      [currentVersion, undefined],
      ["0.4.0", historicalVersion],
      [historicalVersion, "0.4.1"],
      ["1.0.0", historicalVersion],
      [historicalVersion, "1.0.0"],
    ])(
      `requires Go core when either version requires it with schema ${schema}: %s / %s`,
      async (version, expectedVersion) => {
        const input = fixture(schema, version);
        input.expectedVersion = expectedVersion;
        await refusesBeforeObservation(input, "PACKAGE_GO_CORE_REQUIRED");
      },
    );
  }

  it.each([5, 6])(
    "retains historical 0.1 schema %s admission to the existing digest guard",
    async (schema) => {
      const input = fixture(schema, historicalVersion);
      observations.treeDigest.mockResolvedValue("f".repeat(64));
      await expect(verifyPackageContent(input)).rejects.toThrow(
        "PACKAGE_DIGEST_MISMATCH",
      );
      expect(input.assertArtifactPath).toHaveBeenCalledOnce();
      expect(observations.treeDigest).toHaveBeenCalledExactlyOnceWith(
        input.appPath,
      );
      expect(observations.readdir).not.toHaveBeenCalled();
      expect(observations.readFile).not.toHaveBeenCalled();
    },
  );

  it.each([currentVersion, historicalVersion])(
    "retains schema 4 tree-digest rejection for %s",
    async (version) => {
      await refusesBeforeObservation(
        fixture(4, version),
        "PACKAGE_TREE_DIGEST_LEGACY",
      );
    },
  );

  it.each([5, 6])(
    "retains unknown tree-digest diagnostics before schema %s Go admission",
    async (schema) => {
      const input = fixture(schema);
      input.artifact.treeDigestVersion = "farol.tree-digest/v9";
      await refusesBeforeObservation(
        input,
        "PACKAGE_TREE_DIGEST_VERSION_INVALID",
      );
    },
  );

  it.each([undefined, null, "7", 8])(
    "retains invalid schema rejection for %s",
    async (schema) => {
      const input = fixture();
      input.artifact.schema = schema;
      await refusesBeforeObservation(input, "PACKAGE_MANIFEST_SCHEMA_INVALID");
    },
  );

  it("retains the tree-digest version guard for schema 7", async () => {
    const input = fixture();
    input.artifact.treeDigestVersion = "farol.tree-digest/v1";
    await refusesBeforeObservation(
      input,
      "PACKAGE_TREE_DIGEST_VERSION_INVALID",
    );
  });

  it.each([
    [7, currentVersion, "0.2.1-owner.beta.4"],
    [7, historicalVersion, currentVersion],
    [7, currentVersion, historicalVersion],
    [6, historicalVersion, "0.1.1-owner.beta.1"],
    [6, "00.2.0", historicalVersion],
    [6, null, historicalVersion],
    [6, 2, historicalVersion],
    [6, { startsWith: () => true }, historicalVersion],
    [6, historicalVersion, null],
  ])(
    "retains version mismatch rejection for schema %s: %s / %s",
    async (schema, version, expectedVersion) => {
      const input = fixture(schema, version, expectedVersion);
      await expect(verifyPackageContent(input)).rejects.toThrow(
        "PACKAGE_VERSION_INVALID",
      );
      expect(input.assertArtifactPath).toHaveBeenCalledOnce();
      for (const observation of Object.values(observations))
        expect(observation).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined])(
    "retains rejection of a missing artifact: %s",
    async (artifact) => {
      const input = fixture();
      input.artifact = artifact;
      await refusesBeforeObservation(input, TypeError);
    },
  );

  it.each([
    [
      "legacy resource set",
      LEGACY_BUILD_ENTRIES,
      { schema: 4 },
      "PACKAGE_RESOURCE_SET_INVALID",
    ],
    [
      "branded resource set without Go",
      BUILD_ENTRIES,
      { schema: 4 },
      "PACKAGE_RESOURCE_SET_INVALID",
    ],
    [
      "legacy embedded schema",
      [...BUILD_ENTRIES, ...GO_CORE_ENTRIES],
      { schema: 3 },
      "PACKAGE_EMBEDDED_MANIFEST_INVALID",
    ],
    // Bridge rule: only the retired Python update helper may be absent.
    [
      "embedded schema after the bridge set",
      withoutEntries("update-helper.py"),
      { schema: 3 },
      "PACKAGE_EMBEDDED_MANIFEST_INVALID",
    ],
    [
      "resource set without the safe-open helper",
      withoutEntries("computer-safe-open.py"),
      { schema: 4 },
      "PACKAGE_RESOURCE_SET_INVALID",
    ],
    [
      "bridge set missing another entry",
      withoutEntries("update-helper.py", "update-archive.py"),
      { schema: 4 },
      "PACKAGE_RESOURCE_SET_INVALID",
    ],
    [
      "bridge set with an added entry",
      [...withoutEntries("update-helper.py"), "update-helper"],
      { schema: 4 },
      "PACKAGE_RESOURCE_SET_INVALID",
    ],
    [
      "unattested Go manifest",
      [...BUILD_ENTRIES, ...GO_CORE_ENTRIES],
      { schema: 4 },
      "PACKAGE_EMBEDDED_ATTESTATION_INVALID",
    ],
  ])(
    "schema 7 proceeds to the existing %s guard",
    async (_label, entries, embedded, code) => {
      const input = fixture();
      observations.treeDigest.mockResolvedValue(input.artifact.artifactSha256);
      observations.readdir.mockImplementation(async (file) => {
        if (file === contents)
          return ["Frameworks", "Info.plist", "MacOS", "Resources"];
        if (file === `${contents}/MacOS`) return ["Farol"];
        if (file === `${contents}/Frameworks`) return ["Electron Runtime.app"];
        if (file === `${contents}/Resources`) return ["app", "farol.icns"];
        if (file === resources)
          return [
            ...entries,
            "THIRD_PARTY_NOTICES.txt",
            "build-manifest.json",
            "package.json",
          ].sort();
        throw new Error("UNEXPECTED_FILESYSTEM_OBSERVATION");
      });
      observations.readFile.mockImplementation(async (file) => {
        expect(file).toBe(`${resources}/build-manifest.json`);
        return JSON.stringify(embedded);
      });
      await expect(verifyPackageContent(input)).rejects.toThrow(code);
      expect(input.assertArtifactPath).toHaveBeenCalledOnce();
      expect(observations.treeDigest).toHaveBeenCalledExactlyOnceWith(appPath);
      expect(observations.readdir).toHaveBeenCalledWith(resources);
      expect(observations.readFile).toHaveBeenCalledTimes(
        code === "PACKAGE_RESOURCE_SET_INVALID" ? 0 : 1,
      );
      expect(observations.execFileSync).not.toHaveBeenCalled();
      expect(observations.spawnSync).not.toHaveBeenCalled();
    },
  );
});

describe("update-helper bridge entry sets", () => {
  it("offers exactly the full set and the set without the retired helper", () => {
    const full = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
    expect(bridgeEntrySets(full)).toEqual([
      full,
      full.filter((entry) => entry !== "update-helper.py"),
    ]);
    expect(Object.isFrozen(bridgeEntrySets(full)[1])).toBe(true);
  });
  it("refuses to derive a bridge from a set that already lacks the helper", () => {
    expect(() => bridgeEntrySets(withoutEntries("update-helper.py"))).toThrow(
      "BUILD_ENTRY_BRIDGE_INVALID",
    );
  });
});
