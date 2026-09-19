import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanInstallEnvironment,
  compilerProblems,
  dependencyDrift,
  npmCliFor,
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

  it("changes the package digest for one changed byte, execute bit or empty directory", () => {
    const { directory } = fixturePackage();
    const clean = packageTreeDigest(directory);
    fs.appendFileSync(path.join(directory, "lib", "index.js"), " ");
    const edited = packageTreeDigest(directory);
    expect(edited).not.toBe(clean);
    fs.chmodSync(path.join(directory, "lib", "index.js"), 0o755);
    const executable = packageTreeDigest(directory);
    expect(executable).not.toBe(edited);
    fs.mkdirSync(path.join(directory, "empty"));
    expect(packageTreeDigest(directory)).not.toBe(executable);
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

  it("refuses a package root that is a symlink instead of hashing where it points", () => {
    const { root, directory } = fixturePackage();
    const link = path.join(root, "node_modules", "linked");
    fs.symlinkSync(directory, link);
    expect(() => packageTreeDigest(link)).toThrow(
      "DEPENDENCY_ROOT_NOT_A_DIRECTORY",
    );
  });

  it("authenticates this checkout's compiler and refuses a redirected one", () => {
    expect(compilerProblems(vnextRoot, {})).toEqual([]);
    expect(
      compilerProblems(vnextRoot, { ESBUILD_BINARY_PATH: "/usr/bin/true" }),
    ).toContain("ESBUILD_BINARY_PATH redirects the compiler");
  });

  it("refuses a compiler whose package roots resolve outside the checkout", () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "farol-linked-"));
    scratch.push(checkout);
    fs.mkdirSync(path.join(checkout, "tooling"));
    fs.copyFileSync(
      path.join(vnextRoot, "tooling/dependency-digests.json"),
      path.join(checkout, "tooling/dependency-digests.json"),
    );
    fs.mkdirSync(path.join(checkout, "node_modules", "@esbuild"), {
      recursive: true,
    });
    for (const packageRoot of toolchainPackageRoots()) {
      fs.symlinkSync(
        path.join(vnextRoot, packageRoot),
        path.join(checkout, packageRoot),
      );
    }
    const problems = compilerProblems(checkout, {});
    expect(problems).toContain(
      "node_modules/esbuild resolves outside this checkout",
    );
    expect(problems).toContain(
      "node_modules/esbuild is not reviewed (unreadable)",
    );
  });

  it("refuses to build before any compiler code runs when the compiler is not trusted", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(vnextRoot, "tooling/build.mjs")],
      {
        cwd: vnextRoot,
        encoding: "utf8",
        env: { ...process.env, ESBUILD_BINARY_PATH: "/usr/bin/true" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "compiler not trusted: ESBUILD_BINARY_PATH redirects the compiler",
    );
    expect(result.stderr).not.toContain("at ");
  }, 120_000);

  it("runs the npm of the running Node installation, never one found on PATH", () => {
    const cli = npmCliFor(process.execPath);
    const prefix = path.resolve(
      path.dirname(fs.realpathSync(process.execPath)),
      "..",
    );
    expect(cli).toBe(
      path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), "farol-no-npm-"));
    scratch.push(lonely);
    fs.mkdirSync(path.join(lonely, "bin"));
    fs.writeFileSync(path.join(lonely, "bin", "node"), "");
    expect(() => npmCliFor(path.join(lonely, "bin", "node"))).toThrow();
  });

  it("never marks a build exact when a Node startup hook was present", () => {
    const preload = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "farol-preload-")),
      "hook.cjs",
    );
    scratch.push(path.dirname(preload));
    fs.writeFileSync(
      preload,
      "// a startup hook that could stand in for the compiler\n",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(vnextRoot, "tooling/build.mjs")],
      {
        cwd: vnextRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "node startup hook present (NODE_OPTIONS) — this build is not a candidate",
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(vnextRoot, "dist/app/build-manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.inputExact).toBe(false);
  }, 180_000);

  it("gives the clean install none of the caller's hooks or npm configuration", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "farol-clean-env-"),
    );
    scratch.push(directory);
    const env = cleanInstallEnvironment(directory, "/opt/node/bin/node");
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
      "npm_config_cache",
      "npm_config_globalconfig",
      "npm_config_userconfig",
    ]);
    expect(env.HOME).toBe(directory);
    expect(env.PATH).toBe("/opt/node/bin:/usr/bin:/bin");
    expect(fs.readFileSync(env.npm_config_userconfig, "utf8")).toBe("");
    expect(env.npm_config_globalconfig).toBe(env.npm_config_userconfig);
  });

  it("runs the candidate wrapper in isolated Python so no user-site hook runs", () => {
    const taskfile = fs.readFileSync(
      path.join(vnextRoot, "..", "Taskfile.yml"),
      "utf8",
    );
    const packageTask = taskfile.slice(
      taskfile.indexOf("  next:package:"),
      taskfile.indexOf("  next:run:"),
    );
    expect(packageTask).toContain(
      "/usr/bin/python3 -I ../scripts/assert-owner-untouched.py",
    );
    expect(packageTask).toContain("/usr/bin/env -i");
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
