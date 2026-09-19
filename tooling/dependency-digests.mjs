import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The build trusts no byte under node_modules by being there. Every package it
// bundles, and the compiler that bundles it, must be byte-identical to the tree
// a clean `npm ci` of the committed lockfile produced when this file was
// written (npm verifies each tarball against the lockfile's integrity; this
// file carries that verification forward to the installed bytes). A package
// that differs, or one this file does not name, makes the build inexact, and an
// inexact build is never a candidate.
export const DEPENDENCY_DIGESTS_FILE = "tooling/dependency-digests.json";

// The compiler: esbuild's JavaScript API and the one platform binary it spawns.
// Reviewed digests exist per platform; a platform without one reports its
// compiler as not reviewed, so a build there is never a candidate (today only
// darwin-arm64, the preview's supported target, is reviewed).
export function toolchainPackageRoots(
  platform = process.platform,
  arch = process.arch,
) {
  return ["node_modules/esbuild", `node_modules/@esbuild/${platform}-${arch}`];
}

// The package directory a node_modules-relative input belongs to, including a
// package nested inside another package's own node_modules.
export function packageRootOf(relativePath) {
  const parts = relativePath.split("/");
  let root = null;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== "node_modules") continue;
    const scoped = parts[index + 1]?.startsWith("@");
    const end = index + (scoped ? 2 : 1);
    if (end >= parts.length - 1) break;
    root = parts.slice(0, end + 1).join("/");
    index = end;
  }
  if (root === null) throw new Error(`DEPENDENCY_PATH_INVALID:${relativePath}`);
  return root;
}

// One digest over every entry of a package directory: relative path, kind,
// executable bit, and content (a symlink contributes its target text).
export function packageTreeDigest(directory) {
  // The package root itself must be a real directory: a symlinked root would
  // be hashed at its lexical path while Node loads it from wherever it points.
  const rootInfo = fs.lstatSync(directory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`DEPENDENCY_ROOT_NOT_A_DIRECTORY:${directory}`);
  }
  const records = [];
  const walk = (current, relative) => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    for (const name of entries) {
      const absolute = path.join(current, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        records.push(`L\0${childRelative}\0${fs.readlinkSync(absolute)}`);
      } else if (info.isDirectory()) {
        // Directories are entries too: an added or removed empty directory
        // changes what a package can observe, so it changes the digest.
        records.push(`D\0${childRelative}`);
        walk(absolute, childRelative);
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(fs.readFileSync(absolute))
          .digest("hex");
        const executable = (info.mode & 0o111) !== 0 ? "x" : "-";
        records.push(`F\0${childRelative}\0${executable}\0${digest}`);
      } else {
        throw new Error(`DEPENDENCY_ENTRY_UNSUPPORTED:${childRelative}`);
      }
    }
  };
  walk(directory, "");
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

export function readDependencyDigests(root) {
  const document = JSON.parse(
    fs.readFileSync(path.join(root, DEPENDENCY_DIGESTS_FILE), "utf8"),
  );
  if (
    document?.schema !== 1 ||
    typeof document.packages !== "object" ||
    document.packages === null
  ) {
    throw new Error("DEPENDENCY_DIGESTS_INVALID");
  }
  return document.packages;
}

// Compares the named package roots under `root` with the committed digests.
// Returns every drift; an empty list is the only exact answer.
export function dependencyDrift(root, packageRoots, expected) {
  const drift = [];
  for (const packageRoot of [...new Set(packageRoots)].sort()) {
    const want = expected[packageRoot];
    if (!want || typeof want.treeSha256 !== "string") {
      drift.push({ packageRoot, reason: "not-reviewed" });
      continue;
    }
    let actual;
    try {
      actual = packageTreeDigest(path.join(root, packageRoot));
    } catch {
      drift.push({ packageRoot, reason: "unreadable" });
      continue;
    }
    if (actual !== want.treeSha256) {
      drift.push({ packageRoot, reason: "bytes-differ" });
    }
  }
  return drift;
}

// The compiler is authenticated before any of its code runs: its package roots
// must be real directories at their canonical place under this checkout, match
// the reviewed digests, and the platform binary Node resolves from esbuild's
// own module context must lie inside the reviewed platform package. A redirect
// through ESBUILD_BINARY_PATH is refused. Returns every problem found.
export function compilerProblems(root, env = process.env) {
  const problems = [];
  if (env.ESBUILD_BINARY_PATH) {
    problems.push("ESBUILD_BINARY_PATH redirects the compiler");
  }
  const canonicalRoot = fs.realpathSync(root);
  const roots = toolchainPackageRoots();
  for (const packageRoot of roots) {
    const lexical = path.join(canonicalRoot, packageRoot);
    let canonical;
    try {
      canonical = fs.realpathSync(lexical);
    } catch {
      problems.push(`${packageRoot} is missing`);
      continue;
    }
    if (canonical !== lexical) {
      problems.push(`${packageRoot} resolves outside this checkout`);
    }
  }
  for (const entry of dependencyDrift(
    canonicalRoot,
    roots,
    readDependencyDigests(root),
  )) {
    problems.push(`${entry.packageRoot} is not reviewed (${entry.reason})`);
  }
  try {
    const platformRoot = path.join(canonicalRoot, roots[1]);
    const binary = fs.realpathSync(
      createRequire(
        path.join(canonicalRoot, "node_modules/esbuild/package.json"),
      ).resolve(`${roots[1].slice("node_modules/".length)}/bin/esbuild`),
    );
    if (!binary.startsWith(`${platformRoot}${path.sep}`)) {
      problems.push(
        "esbuild resolves a platform binary outside the reviewed package",
      );
    }
  } catch {
    problems.push("esbuild's platform binary cannot be resolved");
  }
  return problems;
}

// `node tooling/dependency-digests.mjs --write <package-root>...` performs the
// clean install itself: a disposable directory receives only package.json and
// package-lock.json, `npm ci` installs them (npm verifies every tarball against
// the lockfile's integrity), esbuild's own install step runs as it does in
// every real install, and only that directory is hashed. No caller-supplied
// tree can become the reviewed state.
// The npm that belongs to the running Node installation, by its own path: a
// `npm` found first on PATH must not decide what the clean install contains.
export function npmCliFor(nodeExecutable = process.execPath) {
  const cli = path.resolve(
    path.dirname(fs.realpathSync(nodeExecutable)),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const info = fs.lstatSync(cli);
  if (!info.isFile()) throw new Error(`NPM_CLI_NOT_FOUND:${cli}`);
  return cli;
}

// The clean install sees none of the caller's startup hooks or npm
// configuration: no NODE_OPTIONS/NODE_PATH/npm_config_* from the environment,
// HOME inside the disposable directory, and empty user and global npmrc.
// Only the package cache is shared; npm verifies every tarball from it
// against the lockfile's integrity.
export function cleanInstallEnvironment(
  scratch,
  nodeExecutable = process.execPath,
) {
  const emptyConfig = path.join(scratch, ".npmrc-empty");
  fs.writeFileSync(emptyConfig, "");
  return {
    PATH: `${path.dirname(nodeExecutable)}:/usr/bin:/bin`,
    HOME: scratch,
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    npm_config_userconfig: emptyConfig,
    npm_config_globalconfig: emptyConfig,
    npm_config_cache: path.join(os.homedir(), ".npm"),
  };
}

export function writeDependencyDigestsFromCleanInstall(vnextRoot, roots) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "farol-clean-deps-"));
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(vnextRoot, name), path.join(scratch, name));
    }
    const env = cleanInstallEnvironment(scratch);
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: scratch,
        env,
        stdio: "inherit",
      });
      if (result.status !== 0) {
        throw new Error(`DEPENDENCY_CLEAN_INSTALL_FAILED:${command}`);
      }
    };
    run(process.execPath, [
      npmCliFor(),
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    run(process.execPath, [path.join("node_modules", "esbuild", "install.js")]);
    const packages = {};
    for (const packageRoot of [...roots].sort()) {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(scratch, packageRoot, "package.json"),
          "utf8",
        ),
      );
      packages[packageRoot] = {
        version: manifest.version,
        treeSha256: packageTreeDigest(path.join(scratch, packageRoot)),
      };
    }
    fs.writeFileSync(
      path.join(vnextRoot, DEPENDENCY_DIGESTS_FILE),
      `${JSON.stringify({ schema: 1, packages }, null, 2)}\n`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, ...roots] = process.argv.slice(2);
  const vnextRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (
    flag !== "--write" ||
    roots.length === 0 ||
    !roots.every((root) => /^node_modules\/(@[^/]+\/)?[^/]+$/u.test(root))
  ) {
    process.stderr.write(
      "usage: dependency-digests.mjs --write <node_modules/package>...\n",
    );
    process.exit(2);
  }
  writeDependencyDigestsFromCleanInstall(vnextRoot, roots);
}
