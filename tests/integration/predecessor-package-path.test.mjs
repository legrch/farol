import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestPredecessorDirectory,
  predecessorPackagePaths,
} from "../e2e/predecessor-package-path.mjs";

const root = "/tmp/farol-predecessor";
const created = [];
// Metadata from the accepted build 13; this fixture does not inspect or
// qualify the real bundle, installed state, or native executable.
const accepted = {
  schema: 6,
  product: "Farol Next Preview",
  version: "0.1.11-owner.beta.1",
  buildVersion: "13",
  bundleId: "local.farol.next.preview",
  sourceCommit: "8c09f4c7fd9fc82f23a30ad42e701d041189aeea",
  sourceTreeDigest:
    "52e7853eed72c7beeda459d778227aa591778e21b42dc880dbce86459385e5ad",
  sourceDirty: false,
  buildId: "eae7b848e4faad5e6f7c737e1703e3633a286dba0a9e085cdf1c2642dcce9918",
  builtAt: "2026-10-05T13:01:28.015Z",
  artifactPath:
    "/Users/ac/.codex/worktrees/7ff2/farol/_output/package/Farol.app",
  artifactSha256:
    "76e9f8582e25806f9b82eaceb2209f0f143be80b5fbb771cea7e125145290e02",
};
const acceptedArtifact = path.join(
  path.dirname(accepted.artifactPath),
  "artifact.json",
);

function manifestAt(packageRoot, schema = 5) {
  return {
    ...accepted,
    schema,
    artifactPath: path.join(
      packageRoot,
      schema === 5 ? "Farol Next Preview.app" : "Farol.app",
    ),
  };
}

// Evaluate only the resolver, with in-memory I/O and a stubbed verifier.
// Importing the E2E runner would execute the native lane at module scope.
const runner = await fs.readFile(
  new URL("../e2e/preview.e2e.mjs", import.meta.url),
  "utf8",
);
const resolverStart = runner.indexOf(
  "async function resolvePredecessor(artifactFile) {",
);
const resolverEnd = runner.indexOf("\nconst predecessor =", resolverStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
const resolverFactory = new Function(
  "fs",
  "assert",
  "path",
  "predecessorPackagePaths",
  "spawnSync",
  "process",
  "artifact",
  `${runner.slice(resolverStart, resolverEnd)}\nreturn resolvePredecessor;`,
);
const pinnedNames = [
  "package.json",
  "package-lock.json",
  "tooling/verify-package.mjs",
];
const pinnedBlob = "a".repeat(40);

function verificationReceipt(manifest = accepted) {
  return `verified ${manifest.product} ${manifest.version} ${manifest.artifactSha256} (clean) at ${manifest.artifactPath}\n`;
}

function resolverFixture(manifest = accepted, overrides = {}) {
  const calls = [];
  const resolve = resolverFactory(
    { readFile: async () => JSON.stringify(manifest) },
    assert,
    path,
    predecessorPackagePaths,
    (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      if (command === "git" && arguments_[2] === "ls-tree") {
        return {
          status: 0,
          stderr: "",
          stdout: pinnedNames
            .map((name) => `100644 blob ${pinnedBlob}\t${name}`)
            .join("\n"),
        };
      }
      if (command === "git" && arguments_[2] === "hash-object") {
        return {
          status: 0,
          stderr: "",
          stdout: `${overrides.blob ?? pinnedBlob}\n`,
        };
      }
      assert.equal(command, process.execPath);
      assert.deepEqual(arguments_, [
        path.join(
          path.dirname(path.dirname(path.dirname(manifest.artifactPath))),
          "tooling/verify-package.mjs",
        ),
        "--artifact",
        path.join(path.dirname(manifest.artifactPath), "artifact.json"),
        "--app",
        manifest.artifactPath,
      ]);
      return {
        status: overrides.status === undefined ? 0 : overrides.status,
        stdout: overrides.stdout ?? verificationReceipt(manifest),
        stderr: overrides.stderr ?? "",
      };
    },
    { execPath: process.execPath },
    {
      sourceCommit: "b".repeat(40),
      buildId: "b".repeat(64),
      artifactSha256: "c".repeat(64),
    },
  );
  return { calls, resolve };
}

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

describe("predecessor package path", () => {
  it.each([
    ["dist/package", 5],
    ["_output/package", 5],
    ["dist/package", 6],
    ["_output/package", 6],
  ])(
    "accepts the %s layout for schema %s only for a predecessor's own pinned verifier",
    (layout, schema) => {
      const packageRoot = path.join(root, layout);
      expect(
        predecessorPackagePaths(
          path.join(packageRoot, "artifact.json"),
          manifestAt(packageRoot, schema),
        ),
      ).toEqual({
        checkoutRoot: root,
        packageRoot,
        executable: path.join(
          manifestAt(packageRoot, schema).artifactPath,
          "Contents/MacOS/Farol Next Preview",
        ),
      });
    },
  );

  it("refuses a foreign layout or manifest", () => {
    const packageRoot = path.join(root, "dist/package");
    expect(() =>
      predecessorPackagePaths(
        path.join(packageRoot, "artifact.json"),
        manifestAt(path.join(root, "elsewhere")),
      ),
    ).toThrow("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
    expect(() =>
      predecessorPackagePaths(
        path.join(root, "elsewhere/artifact.json"),
        manifestAt(packageRoot),
      ),
    ).toThrow("E2E_PREDECESSOR_MANIFEST_NOT_CANONICAL");
  });

  it("selects the accepted schema 6 brand with the historical launcher", () => {
    expect(predecessorPackagePaths(acceptedArtifact, accepted)).toEqual({
      checkoutRoot: "/Users/ac/.codex/worktrees/7ff2/farol",
      packageRoot: path.dirname(accepted.artifactPath),
      executable: path.join(
        accepted.artifactPath,
        "Contents/MacOS/Farol Next Preview",
      ),
    });
  });

  it.each([4, 7, "6", undefined])("refuses unsupported schema %s", (schema) => {
    expect(() =>
      predecessorPackagePaths(acceptedArtifact, { ...accepted, schema }),
    ).toThrow("E2E_PREDECESSOR_MANIFEST_SCHEMA");
  });

  it.each([
    [5, "Farol.app"],
    [6, "Farol Next Preview.app"],
    [6, "Other.app"],
    [6, "Farol.app/Contents/MacOS/Farol Next Preview"],
    [6, "Farol.app/Contents/Frameworks/Electron Runtime.app"],
  ])(
    "refuses schema %s with mismatched brand or executable path %s",
    (schema, name) => {
      expect(() =>
        predecessorPackagePaths(acceptedArtifact, {
          ...accepted,
          schema,
          artifactPath: path.join(path.dirname(acceptedArtifact), name),
        }),
      ).toThrow("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
    },
  );

  it.each([
    ["relative/artifact.json", accepted.artifactPath],
    [acceptedArtifact, "_output/package/Farol.app"],
    [acceptedArtifact, null],
    [
      acceptedArtifact,
      `${path.dirname(accepted.artifactPath)}/../package/Farol.app`,
    ],
    [
      `${path.dirname(acceptedArtifact)}/../package/artifact.json`,
      accepted.artifactPath,
    ],
  ])("refuses noncanonical inputs %s and %s", (artifactFile, artifactPath) => {
    expect(() =>
      predecessorPackagePaths(artifactFile, { ...accepted, artifactPath }),
    ).toThrow("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
  });

  it.each([5, 6])(
    "resolves schema %s through its pinned verifier with exact artifact/app arguments",
    async (schema) => {
      const manifest = manifestAt(path.dirname(acceptedArtifact), schema);
      const fixture = resolverFixture(manifest);
      const resolved = await fixture.resolve(acceptedArtifact);
      expect(resolved.executable).toBe(
        path.join(manifest.artifactPath, "Contents/MacOS/Farol Next Preview"),
      );
      expect(resolved.sourceCommit).toBe(accepted.sourceCommit);
      expect(resolved.verifier.pinnedFiles).toBe(pinnedNames.length);
      expect(fixture.calls[0].arguments_).toEqual([
        "-C",
        resolved.verifier.root,
        "ls-tree",
        "-r",
        manifest.sourceCommit,
        "--",
        "tooling",
        "package.json",
        "package-lock.json",
      ]);
      expect(
        fixture.calls.filter((call) => call.command === process.execPath),
      ).toHaveLength(1);
      expect(fixture.calls.at(-1).options.cwd).toBe(resolved.verifier.root);
    },
  );

  it.each([
    { product: "Farol" },
    { version: "0.2.0-owner.beta.2" },
    { artifactSha256: "d".repeat(64) },
    { artifactPath: "/tmp/other/_output/package/Farol.app" },
  ])("rejects a receipt for a different identity %j", async (changed) => {
    const fixture = resolverFixture(accepted, {
      stdout: verificationReceipt({ ...accepted, ...changed }),
    });
    await expect(fixture.resolve(acceptedArtifact)).rejects.toThrow(
      "E2E_PREDECESSOR_NOT_VERIFIED",
    );
  });

  it("rejects a changed manifest version against the original verifier receipt", async () => {
    const fixture = resolverFixture(
      { ...accepted, version: "0.2.0-owner.beta.2" },
      { stdout: verificationReceipt() },
    );
    await expect(fixture.resolve(acceptedArtifact)).rejects.toThrow(
      "E2E_PREDECESSOR_NOT_VERIFIED",
    );
  });

  it.each([
    verificationReceipt().replace("(clean)", "(dirty)"),
    `prefix ${verificationReceipt()}`,
    `${verificationReceipt().trim()} extra\n`,
    verificationReceipt().slice(
      "verified Farol Next Preview 0.1.11-owner.beta.1".length,
    ),
  ])("rejects incomplete or inexact verifier receipt %s", async (stdout) => {
    await expect(
      resolverFixture(accepted, { stdout }).resolve(acceptedArtifact),
    ).rejects.toThrow("E2E_PREDECESSOR_NOT_VERIFIED");
  });

  it.each([
    "PACKAGE_PLIST_EXECUTABLE_MISMATCH",
    "PACKAGE_LAUNCHER_MODE_INVALID",
    "PACKAGE_VERSION_INVALID",
    "PACKAGE_PLIST_BUILD_VERSION_MISMATCH",
  ])(
    "propagates its own verifier's %s failure even with a matching receipt",
    async (stderr) => {
      await expect(
        resolverFixture(accepted, { status: 1, stderr }).resolve(
          acceptedArtifact,
        ),
      ).rejects.toThrow(stderr);
    },
  );

  it("refuses an unknown verifier outcome", async () => {
    await expect(
      resolverFixture(accepted, { status: null }).resolve(acceptedArtifact),
    ).rejects.toThrow();
  });

  it("refuses modified verifier source before verification", async () => {
    const fixture = resolverFixture(accepted, { blob: "d".repeat(40) });
    await expect(fixture.resolve(acceptedArtifact)).rejects.toThrow(
      "E2E_PREDECESSOR_VERIFIER_NOT_PINNED",
    );
    expect(
      fixture.calls.some((call) => call.command === process.execPath),
    ).toBe(false);
  });

  it("keeps an older predecessor discoverable after new evidence moves to _output", async () => {
    const checkout = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-predecessor-"),
    );
    created.push(checkout);
    const older = path.join(checkout, "artifacts/predecessors/older");
    const newer = path.join(checkout, "_output/evidence/predecessors/newer");
    await Promise.all([
      fs.mkdir(older, { recursive: true }),
      fs.mkdir(newer, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(older, "artifact.json"),
        JSON.stringify({ schema: 5, builtAt: "2026-09-20T00:00:00Z" }),
      ),
      fs.writeFile(
        path.join(newer, "artifact.json"),
        JSON.stringify({ schema: 5, builtAt: "2026-09-19T00:00:00Z" }),
      ),
    ]);
    expect(await latestPredecessorDirectory(checkout)).toBe(older);
  });
});
