import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MODULE = "golang.org/x/text";
const MODULE_VERSION = "v0.28.0";
const MODULE_SUM = "h1:rhazDwis8INMIwQ4tpjLDzUhx6RlXqZNPEM0huQojng=";
const GO_VERSION = "go1.26.2";
// Each trusted compiler is an exact go binary and SDK tree pair. The Homebrew
// build is the owner's Mac; the official go.dev archive is what hosted CI
// installs. Both compile the byte-identical archive pinned below.
const TRUSTED_COMPILERS = Object.freeze([
  Object.freeze({
    origin: "homebrew go 1.26.2",
    binarySha256:
      "912f19a1a95ffe44a9e349d8283c74eb1d2eace37aad3ca6ef7b9ae321eb709f",
    sdkSha256:
      "6683400b4531ac46ed6ae2da36a98c082d864f6a5ed9208260536241f7499a8c",
  }),
  Object.freeze({
    origin: "go.dev go1.26.2.darwin-arm64.tar.gz",
    binarySha256:
      "005640c7ff93028cb704283b0f737f2db3faf8b51b2561170c769b83905da646",
    sdkSha256:
      "489fc7aab97296629ee7da3c0273b1c24eb46fd6accdc5fa3e5fce8cda979b8d",
  }),
]);

// Measured from the pinned compiler and source after native parity tests.
// The candidate still requires its separate source review and package gates.
export const NATIVE_ARCHIVE_SHA256 =
  "0f60969f4acbaf57d2c628c69412f4f81f227a94e1d27c60d36356fe8ed9d4c7";
export const NATIVE_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_ARCHIVE_OUTPUT = "update-archive.py";
const MAX_SDK_BYTES = 512 * 1024 * 1024;

function refuse(code) {
  throw new Error(code);
}
function sameFile(left, right) {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
async function regularBytes(file, maximum) {
  const before = await fs.lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 0n ||
    before.size > BigInt(maximum) ||
    (before.mode & 0o022n) !== 0n
  )
    refuse("NATIVE_ARCHIVE_INPUT_UNSAFE");
  const fd = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await fd.stat({ bigint: true });
    if (!sameFile(before, opened)) refuse("NATIVE_ARCHIVE_INPUT_CHANGED");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await fd.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (
      count !== Number(opened.size) ||
      !sameFile(opened, await fd.stat({ bigint: true })) ||
      !sameFile(opened, await fs.lstat(file, { bigint: true }))
    )
      refuse("NATIVE_ARCHIVE_INPUT_CHANGED");
    return bytes.subarray(0, count);
  } finally {
    await fd.close();
  }
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function snapshotTree(root, maximumBytes = MAX_SDK_BYTES) {
  const records = [];
  let total = 0;
  async function walk(directory, depth) {
    if (depth > 32) refuse("NATIVE_ARCHIVE_INPUT_LIMIT");
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022)
      refuse("NATIVE_ARCHIVE_INPUT_UNSAFE");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, depth + 1);
      } else {
        if (!entry.isFile()) refuse("NATIVE_ARCHIVE_INPUT_UNSAFE");
        const bytes = await regularBytes(file, 64 * 1024 * 1024);
        const stat = await fs.lstat(file);
        total += bytes.length;
        if (total > maximumBytes || records.length >= 30_000)
          refuse("NATIVE_ARCHIVE_INPUT_LIMIT");
        records.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          kind: "file",
          mode: stat.mode & 0o7777,
          sha256: digest(bytes),
        });
      }
    }
  }
  await walk(root, 0);
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Matches the measured SDK receipt's ASCII JSON, including non-ASCII names.
  const serialized = JSON.stringify(records).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return { records, sha256: digest(serialized), total };
}

async function compiler() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    refuse("NATIVE_ARCHIVE_COMPILER_PLATFORM_UNSUPPORTED");
  const executable = await fs.realpath("/opt/homebrew/bin/go");
  const sdk = path.dirname(path.dirname(executable));
  const binarySha256 =
    path.basename(executable) === "go" &&
    path.basename(path.dirname(executable)) === "bin"
      ? digest(await regularBytes(executable, 64 * 1024 * 1024))
      : null;
  const trusted = TRUSTED_COMPILERS.find(
    (candidate) => candidate.binarySha256 === binarySha256,
  );
  if (!trusted) refuse("NATIVE_ARCHIVE_COMPILER_UNTRUSTED");
  const measured = await snapshotTree(sdk);
  if (measured.sha256 !== trusted.sdkSha256)
    refuse("NATIVE_ARCHIVE_COMPILER_SDK_UNTRUSTED");
  return { executable, sdk, measured, sdkSha256: trusted.sdkSha256 };
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    refuse("NATIVE_ARCHIVE_CACHE_UNSAFE");
}

async function seedModuleCache(cache) {
  const source = path.join(
    os.userInfo().homedir,
    "go/pkg/mod/cache/download/golang.org/x/text/@v",
  );
  const destination = path.join(cache, "cache/download/golang.org/x/text/@v");
  await privateDirectory(destination);
  for (const extension of [".zip", ".ziphash", ".mod", ".info"]) {
    const name = `${MODULE_VERSION}${extension}`;
    const bytes = await regularBytes(path.join(source, name), 32 * 1024 * 1024);
    await fs.writeFile(path.join(destination, name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function removePrivateBuild(directory, identity) {
  const root = await fs.lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.dev !== identity.dev ||
    root.ino !== identity.ino ||
    root.uid !== process.getuid?.() ||
    (root.mode & 0o077) !== 0
  )
    refuse("NATIVE_ARCHIVE_CLEANUP_UNKNOWN");
  // Go makes its extracted, task-private module cache read-only. Unlock only
  // owned directories below this measured temporary root; no shared cache or
  // SDK permission changes are needed to remove the disposable build.
  async function unlock(current) {
    const descriptor = await fs.open(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const before = await descriptor.stat();
      const named = await fs.lstat(current);
      if (
        !before.isDirectory() ||
        before.uid !== process.getuid?.() ||
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        named.isSymbolicLink()
      )
        refuse("NATIVE_ARCHIVE_CLEANUP_UNKNOWN");
      await descriptor.chmod(0o700);
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.isDirectory()) await unlock(path.join(current, entry.name));
        else if (!entry.isFile()) refuse("NATIVE_ARCHIVE_CLEANUP_UNKNOWN");
      }
      const after = await fs.lstat(current);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        !after.isDirectory()
      )
        refuse("NATIVE_ARCHIVE_CLEANUP_UNKNOWN");
    } finally {
      await descriptor.close();
    }
  }
  await unlock(directory);
  const after = await fs.lstat(directory);
  if (after.dev !== identity.dev || after.ino !== identity.ino)
    refuse("NATIVE_ARCHIVE_CLEANUP_UNKNOWN");
  await fs.rm(directory, { recursive: true, force: false });
}

/** Compile only owned source with the authenticated existing SDK, offline. */
export async function compileNativeArchive({
  root,
  readSource,
  check = false,
}) {
  const selected = await compiler();
  const moduleRoot = path.join(root, "resources/native/go");
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) files.push(file);
      else refuse("NATIVE_ARCHIVE_SOURCE_UNSAFE");
    }
  }
  await collect(moduleRoot);
  files.sort();
  const source = new Map();
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    source.set(file, await readSource(relative));
  }
  const sums = source.get(path.join(moduleRoot, "go.sum"))?.toString("utf8");
  if (!sums?.split("\n").includes(`${MODULE} ${MODULE_VERSION} ${MODULE_SUM}`))
    refuse("NATIVE_ARCHIVE_MODULE_NOT_PINNED");
  const parent = path.join(root, "_output/tmp");
  await fs.mkdir(parent, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(parent, "go-archive-build-"));
  const temporaryIdentity = await fs.lstat(temporary);
  let buildError;
  try {
    const cache = path.join(temporary, "modules");
    const sharedCache = path.join(
      root,
      "_output/tmp/go-archive-compiler-cache",
    );
    await privateDirectory(sharedCache);
    await privateDirectory(path.join(temporary, "tmp"));
    await seedModuleCache(cache);
    const environment = {
      HOME: os.userInfo().homedir,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      GOENV: "off",
      GOWORK: "off",
      GOTOOLCHAIN: "local",
      GOFLAGS: "",
      GOPROXY: "off",
      GOROOT: selected.sdk,
      GOPATH: path.join(temporary, "path"),
      GOMODCACHE: cache,
      GOCACHE: sharedCache,
      GOTMPDIR: path.join(temporary, "tmp"),
      CGO_ENABLED: "0",
      GOOS: "darwin",
      GOARCH: "arm64",
    };
    const command = async (arguments_) =>
      run(selected.executable, arguments_, {
        cwd: moduleRoot,
        env: environment,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      });
    const version = await command(["version"]);
    if (version.stdout.trim() !== `go version ${GO_VERSION} darwin/arm64`)
      refuse("NATIVE_ARCHIVE_COMPILER_VERSION_MISMATCH");
    const dependency = JSON.parse(
      (
        await command([
          "mod",
          "download",
          "-json",
          `${MODULE}@${MODULE_VERSION}`,
        ])
      ).stdout,
    );
    if (
      dependency.Sum !== MODULE_SUM ||
      dependency.Error ||
      dependency.Path !== MODULE ||
      dependency.Version !== MODULE_VERSION ||
      dependency.Dir !== path.join(cache, "golang.org/x/text@v0.28.0")
    )
      refuse("NATIVE_ARCHIVE_MODULE_UNTRUSTED");
    await command(["mod", "verify"]);
    const dependencyBefore = await snapshotTree(
      dependency.Dir,
      64 * 1024 * 1024,
    );
    if (check) {
      const format = await run(
        path.join(selected.sdk, "bin/gofmt"),
        ["-l", ...files.filter((file) => file.endsWith(".go"))],
        { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      if (format.stdout.trim()) refuse("NATIVE_ARCHIVE_SOURCE_FORMAT");
      await command(["test", "-count=1", "./..."]);
    }
    const binary = path.join(temporary, NATIVE_ARCHIVE_OUTPUT);
    await command([
      "build",
      "-mod=readonly",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      binary,
      "./cmd/update-archive",
    ]);
    for (const [file, before] of source) {
      if (!before.equals(await regularBytes(file, 8 * 1024 * 1024)))
        refuse("NATIVE_ARCHIVE_SOURCE_CHANGED");
    }
    const dependencyAfter = await snapshotTree(
      dependency.Dir,
      64 * 1024 * 1024,
    );
    if (
      dependencyBefore.sha256 !== dependencyAfter.sha256 ||
      (await snapshotTree(selected.sdk)).sha256 !== selected.sdkSha256
    )
      refuse("NATIVE_ARCHIVE_COMPILER_INPUT_CHANGED");
    return {
      bytes: await regularBytes(binary, NATIVE_ARCHIVE_MAX_BYTES),
      dependencies: [
        {
          kind: "dependency",
          path: `native/compiler/${GO_VERSION}`,
          sha256: selected.sdkSha256,
        },
        {
          kind: "dependency",
          path: `native/module/${MODULE}@${MODULE_VERSION}`,
          sha256: dependencyBefore.sha256,
        },
      ],
    };
  } catch (error) {
    buildError = error;
    throw error;
  } finally {
    try {
      await removePrivateBuild(temporary, temporaryIdentity);
    } catch (cleanupError) {
      throw new AggregateError(
        buildError ? [buildError, cleanupError] : [cleanupError],
        "NATIVE_ARCHIVE_CLEANUP_UNKNOWN",
      );
    }
  }
}

export function assertNativeArchiveBytes(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > NATIVE_ARCHIVE_MAX_BYTES ||
    digest(bytes) !== NATIVE_ARCHIVE_SHA256
  )
    refuse("NATIVE_ARCHIVE_BINARY_UNTRUSTED");
}
