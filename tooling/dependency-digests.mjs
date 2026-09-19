import { createHash } from "node:crypto";
import fs from "node:fs";
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

// `node tooling/dependency-digests.mjs --write <clean-install-root> <package-root>...`
// writes the digests of a CLEAN `npm ci` tree. It refuses to run against the
// working tree's own node_modules, which is exactly what it must not trust.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, cleanRoot, ...roots] = process.argv.slice(2);
  const vnextRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (
    flag !== "--write" ||
    !cleanRoot ||
    roots.length === 0 ||
    path.resolve(cleanRoot) === vnextRoot
  ) {
    process.stderr.write(
      "usage: dependency-digests.mjs --write <clean npm ci root> <package-root>...\n",
    );
    process.exit(2);
  }
  const packages = {};
  for (const packageRoot of roots.sort()) {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(cleanRoot, packageRoot, "package.json"),
        "utf8",
      ),
    );
    packages[packageRoot] = {
      version: manifest.version,
      treeSha256: packageTreeDigest(path.join(cleanRoot, packageRoot)),
    };
  }
  fs.writeFileSync(
    path.join(vnextRoot, DEPENDENCY_DIGESTS_FILE),
    `${JSON.stringify({ schema: 1, packages }, null, 2)}\n`,
  );
}
