import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  measureGoToolchain,
  releaseOwnedTemporary,
} from "../../tooling/go-backend-build.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";

async function buildGoBackend(options) {
  const keys = [
    "GOTOOLCHAIN",
    "GOROOT",
    "GOWORK",
    "GOFLAGS",
    "GOPROXY",
    "GOCACHEPROG",
    "GOARCH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "NODE_PATH",
  ];
  const overrides = Object.fromEntries(
    keys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  // Vitest itself starts with a loader. Exercise the unmodified production
  // guard through a clean Node consumer, and pass test overrides after launch.
  const script = `import { buildGoBackend } from ${JSON.stringify(new URL("../../tooling/go-backend-build.mjs", import.meta.url).href)};
Object.assign(process.env, ${JSON.stringify(overrides)});
try { const evidence = await buildGoBackend(${JSON.stringify(options)}); process.stdout.write(JSON.stringify({ evidence })); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.message, cause: error.cause })); }`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: options.repositoryRoot },
      maxBuffer: 1024 * 1024,
    }),
  );
  if (result.error) throw new Error(result.error, { cause: result.cause });
  return Object.freeze(result.evidence);
}

async function buildDevControl(root, inputs) {
  // The helper refuses any Node execArgv, so run a plain module file.
  const entry = path.join(path.dirname(root), "build-dev-control.mjs");
  await fs.writeFile(
    entry,
    `import { buildDevControl } from ${JSON.stringify(new URL("../../tooling/go-backend-build.mjs", import.meta.url).href)};
try { process.stdout.write(JSON.stringify({ binary: await buildDevControl(${JSON.stringify(root)}, ${JSON.stringify(inputs)}) })); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }`,
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [entry], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: root },
      maxBuffer: 1024 * 1024,
    }),
  );
  if (result.error) throw new Error(result.error);
  return result.binary;
}

const MODULE = "github.com/legrch/farol";
const SYMBOL = `${MODULE}/boot.BuildID`;
const platform = { goos: "darwin", goarch: "arm64" };
const owned = [];
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(root, ...args) {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/var/empty",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

const moduleVersions = [
  ["golang.org/x/sys", "v0.35.0"],
  ["golang.org/x/text", "v0.28.0"],
];
// Test input construction, with a published .mod h1 vector below as an
// independent anchor. Synthetic ZIP contents are NOT the real Go modules.
const testH1 = (files) =>
  `h1:${createHash("sha256")
    .update(
      [...files]
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
        .join(""),
    )
    .digest("base64")}`;
function zipFixture(files, options = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const nameBytes = Buffer.from(name);
    const data = options.deflate ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(options.descriptor ? 8 : 0, 6);
    header.writeUInt16LE(options.deflate ? 8 : 0, 8);
    if (!options.descriptor) {
      header.writeUInt32LE(crc32(bytes), 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(bytes.length, 22);
    }
    header.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(options.descriptor ? 16 : 0);
    if (options.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc32(bytes), 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    }
    local.push(header, nameBytes, data, descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(options.descriptor ? 8 : 0, 8);
    entry.writeUInt16LE(options.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(bytes), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(options.attrs ?? 0x81a40000, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset +=
      header.length + nameBytes.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function moduleFixture(base, options = {}) {
  const inputs = [];
  const sums = [];
  const filesByModule = [];
  for (const [index, [modulePath, version]] of moduleVersions.entries()) {
    const directory = path.join(base, `module-${index}`);
    const contentRoot = path.join(directory, "content");
    await fs.mkdir(path.join(contentRoot, "lib"), { recursive: true });
    const mod = Buffer.from(
      options.modOverrides?.[index] ?? `module ${modulePath}\n\ngo 1.23.0\n`,
    );
    const prefix = `${modulePath}@${version}/`;
    const files = new Map([
      [`${prefix}go.mod`, mod],
      [
        `${prefix}lib/source.go`,
        Buffer.from("package lib\n// synthetic module fixture\n"),
      ],
      [`${prefix}lib/z-last.txt`, Buffer.from("last\n")],
      [`${prefix}lib/A-first.txt`, Buffer.from("first\n")],
      [`${prefix}empty.txt`, Buffer.alloc(0)],
    ]);
    for (const [name, bytes] of files)
      await fs.writeFile(
        path.join(contentRoot, name.slice(prefix.length)),
        bytes,
      );
    const zipPath = path.join(directory, `${version}.zip`);
    const modPath = path.join(directory, `${version}.mod`);
    const zipHashPath = path.join(directory, `${version}.ziphash`);
    const zipH1 = testH1(files);
    await fs.writeFile(
      zipPath,
      zipFixture(files, index ? { deflate: true, descriptor: true } : {}),
    );
    await fs.writeFile(modPath, mod);
    await fs.writeFile(zipHashPath, zipH1);
    inputs.push({
      modulePath,
      version,
      zipPath,
      modPath,
      contentRoot,
      zipHashPath,
    });
    sums.push(
      `${modulePath} ${version} ${zipH1}`,
      `${modulePath} ${version}/go.mod ${testH1(new Map([["go.mod", mod]]))}`,
    );
    filesByModule.push(files);
  }
  return { inputs, sums: `${sums.join("\n")}\n`, filesByModule };
}

function binaryInfo(overrides = {}) {
  return {
    GoVersion: "go1.26.2",
    Path: `${MODULE}/cmd/farol`,
    Main: { Path: MODULE, Version: "(devel)" },
    Settings: [
      { Key: "-compiler", Value: "gc" },
      { Key: "-buildmode", Value: "exe" },
      { Key: "-trimpath", Value: "true" },
      { Key: "CGO_ENABLED", Value: "0" },
      { Key: "GOOS", Value: "darwin" },
      { Key: "GOARCH", Value: "arm64" },
    ],
    ...overrides,
  };
}

// Disposable shell SDK is an explicitly declared test compiler, NOT a Go
// compiler or native/runtime/provider qualification. It checks actual command,
// environment, snapshots and refusal/cleanup paths without building/executing
// Farol. No injected production runner or authentication bypass is exported.
async function fixture(options = {}) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-go-builder-")),
  );
  owned.push(base);
  const root = path.join(base, "repository");
  const sdk = path.join(base, "sdk");
  const log = path.join(base, "commands");
  await fs.mkdir(path.join(root, "cmd/farol"), { recursive: true });
  await fs.mkdir(path.join(root, "boot"));
  await fs.mkdir(path.join(sdk, "bin"), { recursive: true });
  await fs.mkdir(path.join(sdk, "pkg/tool"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "_output/\nignored.go\n");
  await fs.writeFile(
    path.join(root, "go.mod"),
    `module ${MODULE}\n\ngo 1.26.2\n\nrequire (\n\tgolang.org/x/sys v0.35.0\n\tgolang.org/x/text v0.28.0\n)\n`,
  );
  await fs.writeFile(
    path.join(root, "cmd/farol/main.go"),
    "package main\n// committed production entry\n",
  );
  await fs.writeFile(
    path.join(root, "boot/application.go"),
    'package boot\nvar BuildID = "development"\n',
  );
  await fs.writeFile(path.join(root, "README.md"), "whole HEAD input\n");
  await fs.writeFile(
    path.join(sdk, "pkg/tool/compiler"),
    "trusted compiler input",
  );
  if (options.vendor) {
    await fs.mkdir(path.join(root, "vendor"));
    await fs.writeFile(
      path.join(root, "vendor/modules.txt"),
      "committed dependency input\n",
    );
  }
  const modules = await moduleFixture(base, options);
  await fs.writeFile(path.join(root, "go.sum"), modules.sums);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const source = sourceIdentity(root);
  const identity = createBuildIdentity({
    version: "0.1.0",
    builtAt: "2026-10-03T10:00:00.000Z",
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    sourceDirty: false,
  });
  // Minimal synthetic Mach-O data with a Go string at the named symbol.
  // Format fixture only: it is deliberately never executed.
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(72, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.writeBigUInt64LE(0x1000n, 56);
  bytes.writeBigUInt64LE(512n, 64);
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(512n, 80);
  bytes.writeBigUInt64LE(0x1120n, 256);
  bytes.writeBigUInt64LE(64n, 264);
  bytes.write(options.embeddedBuildId ?? identity.buildId, 288);
  options.mutateBinary?.(bytes);
  await fs.writeFile(path.join(sdk, "test-binary"), bytes);
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${quote(log)}
case "$1" in
  version)
    if [ "$#" = 1 ]; then
      ${options.versionAction ?? ""}
      printf '%s\\n' ${quote(options.version ?? "go version go1.26.2 darwin/arm64")}
    else
      ${options.identityAction ?? ""}
      printf '%s\\n' ${quote(options.rawInfo ?? JSON.stringify(options.info ?? binaryInfo({ Deps: modules.inputs.map(({ modulePath, version }, index) => ({ Path: modulePath, Version: version, Sum: testH1(modules.filesByModule[index]) })) })))}
    fi ;;
  build)
    [ "$GOTOOLCHAIN" = local ] && [ "$GOENV" = off ] && [ "$GOWORK" = off ]
    [ "$GOPROXY" = off ] && [ "$GOSUMDB" = off ] && [ "$GOFLAGS" = '' ]
    [ "$CGO_ENABLED" = 0 ] && [ "$GOARCH" = arm64 ] && [ "$GOOS" = darwin ]
    [ "$GOAUTH" = off ] && [ "$GOVCS" = '*:off' ]
    [ -z "\${GOCACHEPROG:-}" ] && [ -z "\${LD_PRELOAD:-}" ] && [ -z "\${DYLD_INSERT_LIBRARIES:-}" ]
    [ ! -e ignored.go ] && [ ! -e .git ]
    [ -d "$GOMODCACHE" ] && [ -d "$GOCACHE" ] && [ -z "$(ls -A "$GOCACHE")" ]
    [ ! -e "$GOMODCACHE/foreign" ]
    [ -f "$GOMODCACHE/golang.org/x/sys@v0.35.0/go.mod" ]
    [ -f "$GOMODCACHE/golang.org/x/text@v0.28.0/lib/source.go" ]
    cmp "$GOMODCACHE/golang.org/x/sys@v0.35.0/go.mod" "$GOMODCACHE/cache/download/golang.org/x/sys/@v/v0.35.0.mod"
    [ "$*" = ${quote(`build -p=2 -compiler=gc -buildmode=exe -trimpath -buildvcs=false -mod=${"readonly"} -ldflags=-X=${SYMBOL}=${identity.buildId}`)}" -o $(dirname \"$TMPDIR\")/farol-backend ./cmd/farol" ]
    ${options.buildAction ?? ""}
    while [ "$1" != -o ]; do shift; done
    shift
    cp "$GOROOT/test-binary" "$1"
    chmod 500 "$1"
    ${options.afterBuild ?? ""}
    ;;
  tool)
    ${options.nmAction ?? ""}
    printf '%s\\n' ${quote(options.nm ?? `1100 D ${SYMBOL}`)} ;;
  *) exit 75 ;;
esac
`;
  // Root/source paths in attack actions are resolved by the disposable script.
  const rendered = script
    .replaceAll("@ROOT@", quote(root))
    .replaceAll("@SDK@", quote(sdk))
    .replaceAll("@MOD@", quote(modules.inputs[0].contentRoot))
    .replaceAll("@ZIP@", quote(modules.inputs[0].zipPath));
  await fs.writeFile(path.join(sdk, "bin/go"), rendered, { mode: 0o500 });
  const toolchain = {
    root: sdk,
    treeSha256: await measureGoToolchain(sdk),
    version: "go1.26.2",
    ...platform,
  };
  return {
    root,
    sdk,
    log,
    identity,
    toolchain,
    modules,
    base,
    options: {
      repositoryRoot: root,
      buildIdentity: identity,
      toolchain,
      platform,
      moduleInputs: modules.inputs,
    },
  };
}

async function artifacts(root) {
  return (
    await fs.readdir(path.join(root, "_output/tmp")).catch(() => [])
  ).filter(
    (name) => name.startsWith("go-artifact-") || name.startsWith("go-backend-"),
  );
}
async function refuses(f, code) {
  await expect(buildGoBackend(f.options)).rejects.toThrow(code);
  expect(await artifacts(f.root)).toEqual([]);
}

afterEach(async () => {
  for (const directory of owned.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe("candidate-local Go backend build contract", () => {
  it("binds the production command, build ID, measured bytes and whole committed HEAD", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "ignored.go"), "package injected\n");
    const evidence = await buildGoBackend(f.options);
    const bytes = await fs.readFile(evidence.path);
    expect(evidence).toMatchObject({
      sha256: sha256(bytes),
      size: bytes.length,
      buildId: f.identity.buildId,
      sourceCommit: f.identity.sourceCommit,
      sourceTreeDigest: f.identity.sourceTreeDigest,
      inputExact: true,
      entry: "./cmd/farol",
      goVersion: "go1.26.2",
      goToolchainSha256: f.toolchain.treeSha256,
      ...platform,
      cgoEnabled: false,
      trimpath: true,
      buildvcs: false,
      moduleMode: "readonly",
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(path.relative(f.root, evidence.path)).toMatch(
      /^_output\/tmp\/go-artifact-[^/]+\/farol-backend$/u,
    );
    expect(await artifacts(f.root)).toHaveLength(1);
    expect(
      (await fs.readFile(f.log, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(4);
    expect(sourceIdentity(f.root)).toMatchObject({
      dirty: false,
      commit: f.identity.sourceCommit,
    });
  });

  it("preserves every earlier owned output", async () => {
    const f = await fixture();
    const first = await buildGoBackend(f.options);
    const second = await buildGoBackend(f.options);
    expect(second.path).not.toBe(first.path);
    expect(await fs.readFile(first.path)).toEqual(
      await fs.readFile(second.path),
    );
    expect(first.moduleMode).toBe("readonly");
  });

  it("does not inherit compiler, cache, toolchain, workspace, network or loader overrides", async () => {
    const f = await fixture();
    const overrides = {
      GOTOOLCHAIN: "auto",
      GOROOT: "/untrusted",
      GOWORK: "/untrusted/go.work",
      GOFLAGS: "-overlay=/untrusted",
      GOPROXY: "https://invalid",
      GOCACHEPROG: "/untrusted",
      GOARCH: "amd64",
      LD_PRELOAD: "/untrusted",
      DYLD_INSERT_LIBRARIES: "/untrusted",
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, overrides);
      expect((await buildGoBackend(f.options)).inputExact).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each([undefined, { version: "go1.26.2" }])(
    "refuses an unauthenticated SDK before compiler execution: %j",
    async (toolchain) => {
      const f = await fixture();
      f.options.toolchain = toolchain;
      await refuses(f, "GO_BACKEND_TOOLCHAIN_DECLARATION_INVALID");
      await expect(fs.readFile(f.log)).rejects.toThrow();
    },
  );

  it("rejects a platform different from the declared trusted SDK", async () => {
    const f = await fixture();
    f.options.platform = { goos: "darwin", goarch: "amd64" };
    await refuses(f, "GO_BACKEND_TOOLCHAIN_DECLARATION_INVALID");
  });

  it("authenticates pkg/tool bytes before ANY compiler code runs", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.sdk, "pkg/tool/compiler"), "modified");
    await refuses(f, "GO_BACKEND_TOOLCHAIN_DIGEST_MISMATCH");
    await expect(fs.readFile(f.log)).rejects.toThrow();
  });

  it("rejects SDK symlinks before any compiler execution", async () => {
    const f = await fixture();
    await fs.symlink("compiler", path.join(f.sdk, "pkg/tool/redirect"));
    await refuses(f, "GO_BACKEND_TOOLCHAIN_INPUT_TYPE_INVALID");
    await expect(fs.readFile(f.log)).rejects.toThrow();
  });

  it("does not trust a version string contradicting authenticated declaration", async () => {
    const f = await fixture({ version: "go version go1.27.0 darwin/arm64" });
    await refuses(f, "GO_BACKEND_TOOLCHAIN_VERSION_MISMATCH");
    expect(await fs.readFile(f.log, "utf8")).toBe("version\n");
  });

  it("refuses dirty non-Go whole-HEAD input, including hidden index changes", async () => {
    const f = await fixture();
    git(f.root, "update-index", "--assume-unchanged", "README.md");
    await fs.writeFile(
      path.join(f.root, "README.md"),
      "uncommitted unrelated source\n",
    );
    await refuses(f, "GO_BACKEND_SOURCE_IDENTITY_MISMATCH");
    await expect(fs.readFile(f.log)).rejects.toThrow();
  });

  it("rejects a valid buildIdentity naming a different source", async () => {
    const f = await fixture();
    f.options.buildIdentity = createBuildIdentity({
      ...f.identity,
      sourceCommit: "a".repeat(40),
    });
    await refuses(f, "GO_BACKEND_SOURCE_IDENTITY_MISMATCH");
  });

  it("refuses changed original source while compile uses the committed snapshot", async () => {
    const f = await fixture({
      buildAction: "printf 'moved' >> @ROOT@/README.md",
    });
    await refuses(f, "GO_BACKEND_SOURCE_IDENTITY_MISMATCH");
  });

  it("refuses a moving HEAD even when its new committed tree stays clean", async () => {
    const f = await fixture({
      buildAction:
        "/usr/bin/git -C @ROOT@ -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm moved",
    });
    await refuses(f, "GO_BACKEND_SOURCE_IDENTITY_MISMATCH");
    expect(sourceIdentity(f.root).dirty).toBe(false);
  });

  it("refuses mutated source snapshot bytes even after compiler success", async () => {
    const f = await fixture({
      buildAction:
        "chmod 600 cmd/farol/main.go; printf 'changed' >> cmd/farol/main.go",
    });
    await refuses(f, "GO_BACKEND_SOURCE_SNAPSHOT_MOVED");
  });

  it("refuses additional snapshot files that could change compilation", async () => {
    const f = await fixture({ buildAction: "printf 'new' > cmd/farol/new.go" });
    await refuses(f, "GO_BACKEND_SOURCE_SNAPSHOT_MOVED");
  });

  it("refuses SDK movement during the build", async () => {
    const f = await fixture({
      buildAction: "printf 'moved' >> @SDK@/pkg/tool/compiler",
    });
    await refuses(f, "GO_BACKEND_TOOLCHAIN_MOVED");
  });

  it("never returns or retries after compilation failure, even if bytes were written", async () => {
    const f = await fixture({ afterBuild: "exit 81" });
    await refuses(f, "GO_BACKEND_COMMAND_FAILED:build");
    expect(
      (await fs.readFile(f.log, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(2);
  });

  it.each([
    { GoVersion: "go1.25.0" },
    { Path: `${MODULE}/tests/core-host` },
    { Main: { Path: "foreign", Version: "(devel)" } },
    {
      Settings: binaryInfo().Settings.map((entry) =>
        entry.Key === "GOARCH" ? { ...entry, Value: "amd64" } : entry,
      ),
    },
    {
      Settings: [
        ...binaryInfo().Settings,
        { Key: "vcs.modified", Value: "true" },
      ],
    },
    { Settings: [...binaryInfo().Settings, { Key: "GOOS", Value: "darwin" }] },
  ])("rejects contradictory binary identity: %j", async (overrides) => {
    const f = await fixture({ info: binaryInfo(overrides) });
    await refuses(f, "GO_BACKEND_BINARY_IDENTITY_INVALID");
  });

  it("rejects malformed binary metadata", async () => {
    const f = await fixture({ rawInfo: "not JSON" });
    await refuses(f, "GO_BACKEND_BINARY_IDENTITY_INVALID");
  });

  it("refuses a production binary that does not retain boot.BuildID", async () => {
    const f = await fixture({ nm: "1000 D other.BuildID" });
    await refuses(f, "GO_BACKEND_BUILD_ID_SYMBOL_MISSING");
  });

  it("compares the exact boot.BuildID string in the measured binary", async () => {
    const f = await fixture({ embeddedBuildId: "0".repeat(64) });
    await refuses(f, "GO_BACKEND_BINARY_BUILD_ID_INVALID");
  });

  it("refuses bytes moving after Go metadata inspection", async () => {
    const f = await fixture({
      nmAction: 'chmod 600 "$3"; printf moved >> "$3"; chmod 500 "$3"',
    });
    await refuses(f, "GO_BACKEND_BINARY_MOVED");
  });

  it.each([
    ["foreign architecture", (bytes) => bytes.writeUInt32LE(0x01000007, 4)],
    ["invalid magic", (bytes) => bytes.writeUInt32LE(0, 0)],
    ["load command overflow", (bytes) => bytes.writeUInt32LE(0xffffffff, 20)],
    [
      "string outside segments",
      (bytes) => bytes.writeBigUInt64LE(0xffffffffffffffffn, 256),
    ],
  ])("rejects malformed Mach-O identity: %s", async (_name, mutateBinary) => {
    const f = await fixture({ mutateBinary });
    await refuses(f, "GO_BACKEND_BINARY_BUILD_ID_INVALID");
  });

  it("retains a known exit diagnostic without retry or output", async () => {
    const f = await fixture({
      buildAction: "printf 'deliberate compile failure' >&2; exit 42",
    });
    let error;
    try {
      await buildGoBackend(f.options);
    } catch (failure) {
      error = failure;
    }
    expect(error.message).toBe("GO_BACKEND_COMMAND_FAILED:build");
    expect(error.cause).toEqual({
      exitCode: 42,
      signal: null,
      diagnostic: "deliberate compile failure",
    });
    expect(await artifacts(f.root)).toEqual([]);
  });

  it("classifies a signaled compiler as outcome unknown without retry or output", async () => {
    const f = await fixture({ buildAction: "kill -TERM $$" });
    let error;
    try {
      await buildGoBackend(f.options);
    } catch (failure) {
      error = failure;
    }
    expect(error.message).toBe("GO_BACKEND_COMMAND_OUTCOME_UNKNOWN:build");
    expect(error.cause.exitCode).toBe(null);
    expect(error.cause.signal).toBe("SIGTERM");
    expect(
      (await fs.readFile(f.log, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(2);
    expect(await artifacts(f.root)).toEqual([]);
  });

  it("rejects module replacements before any compiler reads external input", async () => {
    const f = await fixture();
    await fs.appendFile(
      path.join(f.root, "go.mod"),
      "\nreplace foreign => /outside\n",
    );
    git(f.root, "add", "go.mod");
    git(
      f.root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "replacement",
    );
    const source = sourceIdentity(f.root);
    f.options.buildIdentity = createBuildIdentity({
      ...f.identity,
      sourceCommit: source.commit,
      sourceTreeDigest: source.treeDigest,
    });
    await refuses(f, "GO_BACKEND_MODULE_REPLACEMENT_UNSUPPORTED");
    await expect(fs.readFile(f.log)).rejects.toThrow();
  });

  it("refuses redirected output without touching the foreign directory", async () => {
    const f = await fixture();
    const outside = path.join(f.sdk, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "preserve");
    await fs.mkdir(path.join(f.root, "_output"));
    await fs.symlink(outside, path.join(f.root, "_output/tmp"));
    await expect(buildGoBackend(f.options)).rejects.toThrow(
      "GO_BACKEND_OUTPUT_TYPE_INVALID",
    );
    expect(await fs.readdir(outside)).toEqual(["keep"]);
  });

  it("rejects Node startup hooks before source/SDK/build work", async () => {
    const f = await fixture();
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = "--require /untrusted";
      await refuses(f, "GO_BACKEND_NODE_STARTUP_HOOK");
      await expect(fs.readFile(f.log)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
});

async function committedChange(f, file, contents) {
  await fs.writeFile(path.join(f.root, file), contents);
  git(f.root, "add", file);
  git(
    f.root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "changed fixture",
  );
  const source = sourceIdentity(f.root);
  f.options.buildIdentity = createBuildIdentity({
    ...f.identity,
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
  });
}
async function inputRefuses(f, code) {
  await refuses(f, code);
  await expect(fs.readFile(f.log)).rejects.toThrow();
}

describe("explicit committed-sum-bound offline module inputs", () => {
  it("authenticates ZIP content and separate .mod, returns a deterministic source-bound ledger", async () => {
    const f = await fixture();
    const first = await buildGoBackend(f.options);
    const second = await buildGoBackend({
      ...f.options,
      moduleInputs: [...f.options.moduleInputs].reverse(),
    });
    expect(first.dependencies).toEqual(second.dependencies);
    expect(first.dependencyDigest).toBe(second.dependencyDigest);
    expect(first.dependencies).toHaveLength(2);
    expect(first.dependencies[0]).toMatchObject({
      modulePath: "golang.org/x/sys",
      version: "v0.35.0",
      fileCount: 5,
      // Published Go .mod vector for v0.35.0, not a caller ziphash claim.
      modH1: "h1:BJP2sWEmIv4KK5OTEluFJCKSidICx8ciO85XgH3Ak8k=",
    });
    for (const [i, input] of f.modules.inputs.entries()) {
      expect(first.dependencies[i].zipSha256).toBe(
        sha256(await fs.readFile(input.zipPath)),
      );
      expect(first.dependencies[i].modSha256).toBe(
        sha256(await fs.readFile(input.modPath)),
      );
    }
    expect(first.dependencyDigest).toBe(
      sha256(`farol-go-dependencies-v1\0${JSON.stringify(first.dependencies)}`),
    );
    expect(first.goModSha256).toBe(
      sha256(await fs.readFile(path.join(f.root, "go.mod"))),
    );
    expect(first.goSumSha256).toBe(
      sha256(await fs.readFile(path.join(f.root, "go.sum"))),
    );
  });

  it("hashes files identically across ZIP ordering, compression, descriptors and metadata", async () => {
    const f = await fixture();
    const first = await buildGoBackend(f.options);
    const input = f.modules.inputs[0];
    await fs.writeFile(
      input.zipPath,
      zipFixture(new Map([...f.modules.filesByModule[0]].reverse()), {
        deflate: true,
        descriptor: true,
      }),
    );
    const second = await buildGoBackend(f.options);
    expect(second.dependencies[0].zipH1).toBe(first.dependencies[0].zipH1);
    expect(second.dependencies[0].zipSha256).not.toBe(
      first.dependencies[0].zipSha256,
    );
    expect(second.dependencyDigest).not.toBe(first.dependencyDigest);
  });

  it("needs no caller ziphash and derives the owned cache claim from authenticated ZIP bytes", async () => {
    const f = await fixture();
    for (const input of f.options.moduleInputs) delete input.zipHashPath;
    expect((await buildGoBackend(f.options)).dependencies).toHaveLength(2);
  });

  it.each([undefined, [], [{}]])(
    "rejects missing or incomplete declarations before compiler execution: %j",
    async (inputs) => {
      const f = await fixture();
      f.options.moduleInputs = inputs;
      await inputRefuses(f, "MODULE_INPUT_DECLARATION_INVALID");
    },
  );
  it.each([
    { modulePath: "golang.org/x/tools" },
    { version: "v0.36.0" },
    { zipPath: "relative.zip" },
    { contentRoot: "/some/../redirect" },
    { ziphash: "forged unbound claim" },
  ])(
    "rejects undeclared fields, modules, versions or paths: %j",
    async (change) => {
      const f = await fixture();
      Object.assign(f.options.moduleInputs[0], change);
      await inputRefuses(f, "MODULE_INPUT_DECLARATION_INVALID");
    },
  );
  it("rejects duplicate inputs instead of silently substituting a required module", async () => {
    const f = await fixture();
    f.options.moduleInputs[1] = f.options.moduleInputs[0];
    await inputRefuses(f, "MODULE_INPUT_DECLARATION_INVALID");
  });
  it("rejects committed vendor alongside the explicit offline contract", async () => {
    const f = await fixture({ vendor: true });
    await inputRefuses(f, "MODULE_VENDOR_UNSUPPORTED");
  });
  it("rejects root version drift", async () => {
    const f = await fixture();
    await committedChange(
      f,
      "go.mod",
      (await fs.readFile(path.join(f.root, "go.mod"), "utf8")).replace(
        "v0.35.0",
        "v0.36.0",
      ),
    );
    await inputRefuses(f, "MODULE_GRAPH_UNSUPPORTED");
  });
  it.each(["missing", "duplicate", "unknown", "malformed"])(
    "rejects %s committed checksum records",
    async (attack) => {
      const f = await fixture();
      const sum = f.modules.sums;
      const changed = {
        missing: sum.split("\n").slice(1).join("\n"),
        duplicate: `${sum}${sum.split("\n")[0]}\n`,
        unknown: `${sum}example.invalid/foreign v1.0.0 h1:${"A".repeat(43)}=\n`,
        malformed: sum.replace("h1:", "h2:"),
      }[attack];
      await committedChange(f, "go.sum", changed);
      await inputRefuses(f, "MODULE_SUM_INVALID");
    },
  );
  it("rejects forged ziphash even when the actual ZIP is authentic", async () => {
    const f = await fixture();
    await fs.writeFile(
      f.modules.inputs[0].zipHashPath,
      `h1:${"A".repeat(43)}=`,
    );
    await inputRefuses(f, "MODULE_ZIPHASH_MISMATCH");
  });
  it("does not let a correct ziphash hide forged ZIP/content bytes", async () => {
    const f = await fixture();
    const input = f.modules.inputs[0];
    const files = new Map(f.modules.filesByModule[0]);
    files.set(
      `${input.modulePath}@${input.version}/lib/source.go`,
      Buffer.from("package attacker\n"),
    );
    await fs.writeFile(input.zipPath, zipFixture(files));
    await fs.writeFile(
      path.join(input.contentRoot, "lib/source.go"),
      "package attacker\n",
    );
    await inputRefuses(f, "MODULE_CHECKSUM_MISMATCH");
  });
  it("authenticates .mod independently of the ZIP", async () => {
    const f = await fixture();
    await fs.appendFile(f.modules.inputs[0].modPath, "// forged\n");
    await inputRefuses(f, "MODULE_CHECKSUM_MISMATCH");
  });
  it.each(["different", "extra", "missing"])(
    "rejects %s extracted source even with authentic ZIP and ziphash",
    async (attack) => {
      const f = await fixture();
      const root = f.modules.inputs[0].contentRoot;
      if (attack === "different")
        await fs.appendFile(path.join(root, "lib/source.go"), "// forged\n");
      if (attack === "extra")
        await fs.writeFile(
          path.join(root, "unlisted.go"),
          "package injected\n",
        );
      if (attack === "missing") await fs.rm(path.join(root, "empty.txt"));
      await inputRefuses(f, "MODULE_EXTRACTION_MISMATCH");
    },
  );
  it("rejects an authenticated .mod that differs from ZIP go.mod", async () => {
    const f = await fixture();
    const input = f.modules.inputs[0];
    const files = new Map(f.modules.filesByModule[0]);
    files.set(
      `${input.modulePath}@${input.version}/go.mod`,
      Buffer.from("module golang.org/x/sys\n\ngo 1.23.0\n// zip differs\n"),
    );
    await fs.writeFile(input.zipPath, zipFixture(files));
    const sum = f.modules.sums.replace(
      testH1(f.modules.filesByModule[0]),
      testH1(files),
    );
    await committedChange(f, "go.sum", sum);
    await inputRefuses(f, "MODULE_EXTRACTION_MISMATCH");
  });
  it.each(["zipPath", "modPath", "zipHashPath", "contentRoot"])(
    "rejects a symlink at %s",
    async (key) => {
      const f = await fixture();
      const input = f.modules.inputs[0];
      const original = input[key];
      const alias = `${original}-alias`;
      await fs.symlink(original, alias);
      input[key] = alias;
      await inputRefuses(f, "MODULE_INPUT_TYPE_INVALID");
    },
  );
  it("rejects symlinked extraction files and directories", async () => {
    const f = await fixture();
    const input = f.modules.inputs[0];
    await fs.symlink(
      f.modules.inputs[1].contentRoot,
      path.join(input.contentRoot, "redirect"),
    );
    await inputRefuses(f, "MODULE_INPUT_TYPE_INVALID");
  });
  it.each([
    ["../outside.go", "MODULE_PATH_INVALID"],
    ["/absolute.go", "MODULE_PATH_INVALID"],
    ["lib/../../escape.go", "MODULE_PATH_INVALID"],
    ["lib\\escape.go", "MODULE_PATH_INVALID"],
    ["lib/CON.go", "MODULE_PATH_INVALID"],
    ["nested/go.mod", "MODULE_PATH_INVALID"],
    ["lib/SOURCE.go", "MODULE_PATH_COLLISION"],
    ["LIB/extra.go", "MODULE_PATH_COLLISION"],
    ["lib", "MODULE_PATH_COLLISION"],
    ["é.go", "MODULE_PATH_INVALID"],
  ])(
    "rejects ZIP path/collision %s before any extraction",
    async (name, code) => {
      const f = await fixture();
      const input = f.modules.inputs[0];
      const files = new Map(f.modules.filesByModule[0]);
      files.set(
        `${input.modulePath}@${input.version}/${name}`,
        Buffer.from("escape"),
      );
      await fs.writeFile(input.zipPath, zipFixture(files));
      await inputRefuses(f, code);
    },
  );
  it("rejects a ZIP for a different module or version", async () => {
    const f = await fixture();
    const files = new Map([["foreign@v1.0.0/file.go", Buffer.from("forged")]]);
    await fs.writeFile(f.modules.inputs[0].zipPath, zipFixture(files));
    await inputRefuses(f, "MODULE_PATH_INVALID");
  });
  it("rejects a ZIP link entry even if it claims a regular file name", async () => {
    const f = await fixture();
    await fs.writeFile(
      f.modules.inputs[0].zipPath,
      zipFixture(f.modules.filesByModule[0], { attrs: 0xa1ff0000 }),
    );
    await inputRefuses(f, "MODULE_ZIP_UNSUPPORTED");
  });
  it.each([
    "crc",
    "local-name",
    "size",
    "encrypted",
    "zip64",
    "descriptor",
    "trailing",
  ])("rejects malformed or unsupported ZIP %s", async (attack) => {
    const f = await fixture();
    let bytes = zipFixture(f.modules.filesByModule[0], { descriptor: true });
    const end = bytes.length - 22;
    const central = bytes.readUInt32LE(end + 16);
    if (attack === "crc") bytes.writeUInt32LE(0, central + 16);
    if (attack === "local-name") bytes[30] ^= 1;
    if (attack === "size") bytes.writeUInt32LE(0x40000000, central + 24);
    if (attack === "encrypted") bytes.writeUInt16LE(9, central + 8);
    if (attack === "zip64") bytes.writeUInt32LE(0xffffffff, central + 42);
    if (attack === "descriptor") bytes[central - 1] ^= 1;
    if (attack === "trailing")
      bytes = Buffer.concat([bytes, Buffer.from("unbound")]);
    await fs.writeFile(f.modules.inputs[0].zipPath, bytes);
    await inputRefuses(f, "MODULE_ZIP_");
  });
  it("rejects authenticated module replacements", async () => {
    const f = await fixture({
      modOverrides: {
        0: "module golang.org/x/sys\n\ngo 1.23.0\nreplace foreign => /outside\n",
      },
    });
    await inputRefuses(f, "MODULE_REPLACEMENT_UNSUPPORTED");
  });
  it("rejects authenticated module Go version drift", async () => {
    const f = await fixture({
      modOverrides: { 0: "module golang.org/x/sys\n\ngo 1.27.0\n" },
    });
    await inputRefuses(f, "MODULE_GRAPH_UNSUPPORTED");
  });
  it.each([
    { Path: "golang.org/x/tools", Version: "v0.35.0", Sum: "forged" },
    { Path: "golang.org/x/sys", Version: "v0.36.0", Sum: "forged" },
    { Path: "golang.org/x/sys", Version: "v0.35.0", Sum: "forged" },
    {
      Path: "golang.org/x/sys",
      Version: "v0.35.0",
      Replace: { Path: "/outside" },
    },
  ])(
    "rejects binary dependencies outside the authenticated ledger: %j",
    async (dependency) => {
      const f = await fixture({ info: binaryInfo({ Deps: [dependency] }) });
      await refuses(f, "BINARY_DEPENDENCIES_INVALID");
    },
  );
  it.each([
    "printf moved >> @MOD@/lib/source.go",
    "printf moved >> @ZIP@",
    'chmod 600 "$GOMODCACHE/golang.org/x/sys@v0.35.0/lib/source.go"; printf moved >> "$GOMODCACHE/golang.org/x/sys@v0.35.0/lib/source.go"',
    'printf foreign > "$GOMODCACHE/foreign"',
  ])(
    "refuses original input or owned cache movement after compiler success: %s",
    async (buildAction) => {
      const f = await fixture({ buildAction });
      await refuses(f, "GO_BACKEND_MODULE_");
    },
  );
  it("rejects replacing an input with identical bytes during compile", async () => {
    const f = await fixture({
      buildAction: "cp @ZIP@ @ZIP@.replacement; mv @ZIP@.replacement @ZIP@",
    });
    await refuses(f, "MODULE_INPUT_MOVED");
  });
  it("rejects a declared directory in place of a regular ZIP", async () => {
    const f = await fixture();
    f.options.moduleInputs[0].zipPath = f.modules.inputs[0].contentRoot;
    await inputRefuses(f, "MODULE_INPUT_TYPE_INVALID");
  });
  it("rejects duplicate binary module identities", async () => {
    const f = await fixture();
    const dependency = {
      Path: "golang.org/x/sys",
      Version: "v0.35.0",
      Sum: testH1(f.modules.filesByModule[0]),
    };
    // Replace metadata within the synthetic SDK, then declare its new test hash.
    const scriptPath = path.join(f.sdk, "bin/go");
    let script = await fs.readFile(scriptPath, "utf8");
    const original = JSON.stringify(
      binaryInfo({
        Deps: f.modules.inputs.map(({ modulePath, version }, i) => ({
          Path: modulePath,
          Version: version,
          Sum: testH1(f.modules.filesByModule[i]),
        })),
      }),
    );
    script = script.replace(
      quote(original),
      quote(JSON.stringify(binaryInfo({ Deps: [dependency, dependency] }))),
    );
    await fs.chmod(scriptPath, 0o700);
    await fs.writeFile(scriptPath, script);
    f.toolchain.treeSha256 = await measureGoToolchain(f.sdk);
    await refuses(f, "BINARY_DEPENDENCIES_INVALID");
  });
  it("rejects non-array binary module metadata", async () => {
    const f = await fixture({ info: binaryInfo({ Deps: {} }) });
    await refuses(f, "BINARY_DEPENDENCIES_INVALID");
  });
  it("rejects null binary module metadata entries", async () => {
    const f = await fixture({ info: binaryInfo({ Deps: [null] }) });
    await refuses(f, "BINARY_DEPENDENCIES_INVALID");
  });
  it("allows authenticated upstream metadata requirements without provisioning extra modules", async () => {
    const f = await fixture({
      modOverrides: {
        1: "module golang.org/x/text\n\ngo 1.23.0\nrequire golang.org/x/tools v0.35.0 // unused tool-only graph in this fixture\n",
      },
    });
    expect(
      (await buildGoBackend(f.options)).dependencies.map(
        ({ modulePath }) => modulePath,
      ),
    ).toEqual(moduleVersions.map(([modulePath]) => modulePath));
  });
});

describe("owned temporary build directories", () => {
  const scratch = async (root) =>
    (await fs.readdir(path.join(root, "_output/tmp")).catch(() => [])).filter(
      (name) => name.startsWith("go-dev-control-"),
    );

  it("removes the development stop helper scratch when its build fails", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.sdk, "pkg/tool/compiler"), "modified");
    await expect(
      buildDevControl(f.root, {
        toolchain: f.toolchain,
        moduleInputs: f.modules.inputs,
      }),
    ).rejects.toThrow("GO_BACKEND_TOOLCHAIN_DIGEST_MISMATCH");
    expect(await scratch(f.root)).toEqual([]);
  });

  it("releases exactly one returned owned directory and refuses any other path", async () => {
    const f = await fixture();
    const parent = path.join(f.root, "_output/tmp");
    await fs.mkdir(parent, { recursive: true });
    const owned = await fs.mkdtemp(path.join(parent, "go-artifact-"));
    const sibling = await fs.mkdtemp(path.join(parent, "go-artifact-"));
    await fs.writeFile(path.join(owned, "farol-backend"), "built");
    await releaseOwnedTemporary(
      f.root,
      path.join(owned, "farol-backend"),
      "go-artifact-",
    );
    await expect(fs.lstat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(sibling)).isDirectory()).toBe(true);
    await releaseOwnedTemporary(
      f.root,
      path.join(owned, "farol-backend"),
      "go-artifact-",
    );
    for (const outside of [
      path.join(f.root, "_output/farol-backend"),
      path.join(parent, "go-dev-control-abcdef/dev-control"),
      path.join(sibling, "nested/farol-backend"),
      path.join(f.base, "go-artifact-abcdef/farol-backend"),
    ])
      await expect(
        releaseOwnedTemporary(f.root, outside, "go-artifact-"),
      ).rejects.toThrow("GO_BACKEND_OWNED_TEMPORARY_PATH_INVALID");
    expect((await fs.lstat(sibling)).isDirectory()).toBe(true);
  });
});
