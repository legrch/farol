import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  dependencyDrift,
  packageRootOf,
  packageTreeDigest,
  readDependencyDigests,
  toolchainPackageRoots,
} from "../../tooling/dependency-digests.mjs";

const vnextRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scratch = [];

function fixturePackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-deps-"));
  scratch.push(root);
  const directory = path.join(root, "node_modules", "fixture");
  fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(directory, "lib", "index.js"), "export {};\n");
  return { root, directory };
}

afterEach(() => {
  for (const root of scratch.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("F3-5 build provenance", () => {
  it("maps bundled inputs to their package, including scoped and nested ones", () => {
    expect(packageRootOf("node_modules/zod/v4/core/index.js")).toBe(
      "node_modules/zod",
    );
    expect(
      packageRootOf("node_modules/@modelcontextprotocol/server/dist/index.js"),
    ).toBe("node_modules/@modelcontextprotocol/server");
    expect(packageRootOf("node_modules/a/node_modules/b/index.js")).toBe(
      "node_modules/a/node_modules/b",
    );
    expect(() => packageRootOf("src/main.ts")).toThrow(
      "DEPENDENCY_PATH_INVALID",
    );
  });

  it("changes the package digest for one changed byte or execute bit", () => {
    const { directory } = fixturePackage();
    const clean = packageTreeDigest(directory);
    fs.appendFileSync(path.join(directory, "lib", "index.js"), " ");
    const edited = packageTreeDigest(directory);
    expect(edited).not.toBe(clean);
    fs.chmodSync(path.join(directory, "lib", "index.js"), 0o755);
    expect(packageTreeDigest(directory)).not.toBe(edited);
  });

  it("reports a mutated or unreviewed package as drift, never as exact", () => {
    const { root, directory } = fixturePackage();
    const expected = {
      "node_modules/fixture": { treeSha256: packageTreeDigest(directory) },
    };
    expect(dependencyDrift(root, ["node_modules/fixture"], expected)).toEqual(
      [],
    );
    fs.writeFileSync(path.join(directory, "lib", "index.js"), "mutated\n");
    expect(dependencyDrift(root, ["node_modules/fixture"], expected)).toEqual([
      { packageRoot: "node_modules/fixture", reason: "bytes-differ" },
    ]);
    expect(dependencyDrift(root, ["node_modules/other"], expected)).toEqual([
      { packageRoot: "node_modules/other", reason: "not-reviewed" },
    ]);
  });

  it("finds this checkout's compiler and bundled packages byte-identical to the reviewed install", () => {
    const expected = readDependencyDigests(vnextRoot);
    const bundled = [
      "node_modules/zod",
      "node_modules/@modelcontextprotocol/server",
      "node_modules/@modelcontextprotocol/core",
    ];
    expect(
      dependencyDrift(
        vnextRoot,
        [...toolchainPackageRoots(), ...bundled],
        expected,
      ),
    ).toEqual([]);
  });

  it("takes the source identity from the system Git, not a git earlier on PATH", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "farol-fake-git-"));
    scratch.push(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 97\n", {
      mode: 0o755,
    });
    // A fresh process, so the module reads the hostile PATH at load time.
    const module = pathToFileURL(
      path.join(vnextRoot, "tooling/source-identity.mjs"),
    ).href;
    const commit = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { sourceSnapshot } = await import(${JSON.stringify(module)});
         process.stdout.write(sourceSnapshot(${JSON.stringify(path.resolve(vnextRoot, ".."))}, "vnext").commit);`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    expect(commit).toMatch(/^[a-f0-9]{40}$/u);
  }, 120_000);
});
