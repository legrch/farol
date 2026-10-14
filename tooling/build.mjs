import { buildGoBackend } from "./go-backend-build.mjs";
import { readGoBuildInputs } from "./go-build-inputs.mjs";
import { embedBuiltCore, GO_CORE_ENTRIES } from "./go-core-artifact.mjs";
import { declareCoreResources } from "./core-resources.mjs";
import {
  declareShellSupport,
  verifyHostShellResources,
} from "./shell-support.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { releaseBuildFields } from "./release-identity.mjs";
import {
  BUILD_ENTRIES,
  snapshotBuildEntries,
  verifyAbsentIntegrations,
} from "./build-contract.mjs";
import {
  assertBuildIdentity,
  createBuildIdentity,
} from "./build-identity-contract.mjs";
import { assertResourceManifest } from "./resource-contract.mjs";
import {
  GEIST_RESOURCES,
  verifyGeistBuild,
  verifyGeistSources,
} from "./font-contract.mjs";
import {
  assertNativeHelperBytes,
  NATIVE_SAFE_OPEN_HELPER,
  verifyNativeHelper,
} from "./native-helper-contract.mjs";
import { sourceSnapshot } from "./source-identity.mjs";
import { BRAND_RESOURCES, verifyBrandAssets } from "./brand-contract.mjs";
import {
  assertNativeArchiveBytes,
  compileNativeArchive,
  NATIVE_ARCHIVE_OUTPUT,
} from "./native-archive-build.mjs";
import {
  compilerProblems,
  dependencyDrift,
  packageRootOf,
  readDependencyDigests,
  toolchainPackageRoots,
} from "./dependency-digests.mjs";

const goInputs = await readGoBuildInputs(process.argv.slice(2));
const root = process.cwd();
const repositoryRoot = root;
const output = path.join(root, "_output/build/app");
const scope = ".";
const initial = sourceSnapshot(repositoryRoot, scope);
const inputRecords = new Map();

// No compiler code runs before the compiler is authenticated (F3-5): a
// compiler that is not the reviewed one refuses the build instead of being
// trusted to leave the bytes a later check would read.
// Node startup hooks (NODE_OPTIONS, NODE_PATH, --loader/--import/--require)
// run before this file and could stand in for the compiler. `task
// package` starts the candidate build without any; a build that still
// sees one is never exact. A preload can hide itself, so this is a second
// line behind that clean launch, not a replacement for it.
const startupHooks = [
  ...(process.env.NODE_OPTIONS ? ["NODE_OPTIONS"] : []),
  ...(process.env.NODE_PATH ? ["NODE_PATH"] : []),
  ...process.execArgv.filter((argument) =>
    /^(?:--(?:experimental-)?loader|--import|--require|-r)(?:=|$)/u.test(
      argument,
    ),
  ),
];
for (const hook of startupHooks) {
  process.stderr.write(
    `node startup hook present (${hook}) — refusing to build\n`,
  );
}
// Refuse before importing the compiler or touching shared build outputs.
// A non-candidate build can still destroy bytes used by a running Dev host.
if (startupHooks.length > 0) process.exit(1);
const compilerRefusals = compilerProblems(root);
if (compilerRefusals.length > 0) {
  for (const problem of compilerRefusals) {
    process.stderr.write(`compiler not trusted: ${problem}\n`);
  }
  process.stderr.write(
    "Refusing to build. Reinstall the locked dependencies with `npm ci` from the repository root.\n",
  );
  process.exit(1);
}
const { build } = await import("esbuild");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function loaderFor(file) {
  const extension = path.extname(file);
  if (extension === ".json") return "json";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts")
    return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  return "js";
}

async function readBuildInput(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    throw new Error(`BUILD_INPUT_ESCAPES_ROOT:${absolute}`);
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`BUILD_INPUT_TYPE_INVALID:${relative}`);
  }
  const bytes = await fs.readFile(absolute);
  if (relative.startsWith("node_modules/")) {
    inputRecords.set(`dependency:${relative}`, {
      kind: "dependency",
      path: relative,
      sha256: sha256(bytes),
    });
    return bytes;
  }

  const repositoryRelative = path.posix.join(scope, relative);
  const expected = initial.entries.get(repositoryRelative);
  const exact =
    expected !== undefined &&
    (expected.mode === "100644" || expected.mode === "100755") &&
    Buffer.isBuffer(expected.bytes) &&
    bytes.equals(expected.bytes);
  inputRecords.set(`source:${relative}`, {
    kind: "source",
    path: relative,
    objectId: expected?.objectId ?? null,
    sha256: sha256(bytes),
    exact,
  });
  return bytes;
}

const attestInputs = {
  name: "farol-next-attest-inputs",
  setup(buildContext) {
    buildContext.onLoad(
      { filter: /\.(?:[cm]?[jt]sx?|json)$/, namespace: "file" },
      async ({ path: file }) => ({
        contents: await readBuildInput(file),
        loader: loaderFor(file),
        resolveDir: path.dirname(file),
      }),
    );
  },
};

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await Promise.all([
  fs.mkdir(path.join(root, "_output/logs"), { recursive: true }),
  fs.mkdir(path.join(root, "_output/tmp"), { recursive: true }),
]);
await verifyGeistSources(root);
const packageDocument = JSON.parse(
  (await readBuildInput("package.json")).toString("utf8"),
);

const common = {
  bundle: true,
  // Only the attested JavaScript transport is part of the package. Optional
  // native addons must never resolve from the owner's ambient installation.
  define: {
    "process.env.WS_NO_BUFFER_UTIL": '"1"',
    "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
  },
  logLevel: "warning",
  sourcemap: false,
  target: "node24",
  metafile: true,
  plugins: [attestInputs],
};
await Promise.all([
  build({
    ...common,
    entryPoints: ["src/apps/desktop/desktop-entry.ts"],
    define: {
      ...common.define,
      __FAROL_GO_CORE__: "null",
      __FAROL_GO_RESOURCES__: "null",
      __FAROL_GO_SHELL__: "null",
    },
    outfile: "_output/build/app/main.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron", "original-fs"],
  }),
  build({
    ...common,
    entryPoints: ["src/apps/runtime/main.ts"],
    outfile: "_output/build/app/runtime.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["apps/desktop/computer-mcp/main.ts"],
    outfile: "_output/build/app/computer-mcp.cjs",
    platform: "node",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["src/apps/desktop/preload.ts"],
    outfile: "_output/build/app/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    bundle: true,
    entryPoints: ["src/ui/renderer/entry.tsx"],
    outfile: "_output/build/app/shell.js",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    format: "iife",
    logLevel: "warning",
    sourcemap: false,
    target: ["chrome145"],
    metafile: true,
    plugins: [attestInputs],
  }),
]);
await Promise.all([
  ...[
    ["tooling/verify-package-standalone.mjs", "update-package.mjs"],
    ["tooling/update-slot.mjs", "update-slot.mjs"],
    ["tooling/update-obligations.mjs", "update-obligations.mjs"],
  ].map(([entry, outputName]) =>
    build({
      ...common,
      entryPoints: [entry],
      outfile: path.join(output, outputName),
      platform: "node",
      format: "esm",
    }),
  ),
  ...[["resources/native/update_helper.py", "update-helper.py"]].map(
    async ([source, name]) => {
      const bytes = await readBuildInput(source);
      await fs.writeFile(path.join(output, name), bytes, { mode: 0o600 });
    },
  ),
  readBuildInput("src/ui/renderer/shell.html").then((bytes) =>
    fs.writeFile("_output/build/app/shell.html", bytes),
  ),
  Promise.all([
    readBuildInput("src/ui/renderer/shell.css"),
    readBuildInput("src/ui/renderer/home.css"),
    readBuildInput("src/ui/renderer/setup.css"),
    readBuildInput("apps/desktop/renderer/recovery/view.css"),
  ]).then((parts) =>
    fs.writeFile(
      "_output/build/app/shell.css",
      Buffer.concat(parts.flatMap((bytes) => [bytes, Buffer.from("\n")])),
    ),
  ),
  readBuildInput("resources.json").then((bytes) => {
    assertResourceManifest(JSON.parse(bytes.toString("utf8")));
    return fs.writeFile("_output/build/app/resource-manifest.json", bytes);
  }),
  readBuildInput(NATIVE_SAFE_OPEN_HELPER.source).then(async (bytes) => {
    assertNativeHelperBytes(bytes);
    const destination = path.join(output, NATIVE_SAFE_OPEN_HELPER.output);
    await fs.writeFile(destination, bytes, {
      mode: NATIVE_SAFE_OPEN_HELPER.mode,
    });
    await fs.chmod(destination, NATIVE_SAFE_OPEN_HELPER.mode);
  }),
  ...GEIST_RESOURCES.map((resource) =>
    readBuildInput(resource.source).then((bytes) =>
      fs.writeFile(path.join(output, resource.output), bytes),
    ),
  ),
  ...BRAND_RESOURCES.map((resource) =>
    readBuildInput(
      `resources/brand/${resource.source ?? resource.output}`,
    ).then((bytes) => fs.writeFile(path.join(output, resource.output), bytes)),
  ),
]);
const nativeArchive = await compileNativeArchive({
  root,
  readSource: readBuildInput,
});
assertNativeArchiveBytes(nativeArchive.bytes);
await fs.writeFile(
  path.join(output, NATIVE_ARCHIVE_OUTPUT),
  nativeArchive.bytes,
  {
    mode: 0o700,
  },
);
await fs.chmod(path.join(output, NATIVE_ARCHIVE_OUTPUT), 0o700);
for (const record of nativeArchive.dependencies)
  inputRecords.set(`dependency:${record.path}`, record);
await verifyBrandAssets(output);
await verifyGeistBuild(output);
await verifyNativeHelper(path.join(output, NATIVE_SAFE_OPEN_HELPER.output));
await verifyAbsentIntegrations(output);

const current = sourceSnapshot(repositoryRoot, scope);
const sourceInputs = [...inputRecords.values()].filter(
  (entry) => entry.kind === "source",
);
const dependencyInputs = [...inputRecords.values()].filter(
  (entry) => entry.kind === "dependency",
);
const identityStable =
  current.commit === initial.commit &&
  current.treeDigest === initial.treeDigest &&
  !current.dirty;
// The compiler and every bundled package must be the bytes a clean install of
// the committed lockfile produced; a redirected compiler binary is not.
const drift = dependencyDrift(
  root,
  [
    ...toolchainPackageRoots(),
    ...dependencyInputs
      .filter((entry) => entry.path.startsWith("node_modules/"))
      .map((entry) => packageRootOf(entry.path)),
  ],
  readDependencyDigests(root),
);
const compilerRedirected = Boolean(process.env.ESBUILD_BINARY_PATH);
for (const entry of drift) {
  process.stderr.write(
    `dependency not reviewed (${entry.reason}): ${entry.packageRoot} — this build is not a candidate\n`,
  );
}
if (compilerRedirected) {
  process.stderr.write(
    "ESBUILD_BINARY_PATH redirects the compiler — this build is not a candidate\n",
  );
}
const inputExact =
  identityStable &&
  sourceInputs.length > 0 &&
  sourceInputs.every((entry) => entry.exact === true) &&
  drift.length === 0 &&
  !compilerRedirected &&
  startupHooks.length === 0;
const inputLedger = [...inputRecords.values()].sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);
// Retain the exact ledger bytes the manifest digest names, so the recorded
// inputs can be recomputed instead of trusted as a label.
const inputLedgerBytes = JSON.stringify(inputLedger);
await fs.writeFile(path.join(output, "input-manifest.json"), inputLedgerBytes, {
  mode: 0o600,
});
const buildIdentity = createBuildIdentity({
  version: packageDocument.version,
  ...releaseBuildFields(packageDocument),
  builtAt: new Date().toISOString(),
  sourceCommit: initial.commit,
  sourceTreeDigest: initial.treeDigest,
  sourceDirty: initial.dirty || current.dirty || !inputExact,
});
await fs.writeFile(
  path.join(output, "build-identity.json"),
  `${JSON.stringify(buildIdentity, null, 2)}\n`,
  { mode: 0o600 },
);
assertBuildIdentity(
  JSON.parse(
    await fs.readFile(path.join(output, "build-identity.json"), "utf8"),
  ),
);
let core;
if (goInputs) {
  if (!inputExact || buildIdentity.sourceDirty)
    throw new Error("GO_BUILD_REQUIRES_EXACT_SOURCE");
  const built = await buildGoBackend({
    repositoryRoot,
    buildIdentity,
    toolchain: goInputs.toolchain,
    platform: {
      goos: goInputs.toolchain.goos,
      goarch: goInputs.toolchain.goarch,
    },
    moduleInputs: goInputs.moduleInputs,
  });
  core = await embedBuiltCore(output, built, buildIdentity);
  const coreResources = await declareCoreResources(output, core, buildIdentity);
  await verifyHostShellResources();
  const shellSupport = await declareShellSupport(
    repositoryRoot,
    core,
    buildIdentity,
  );
  // Compile the independent producer declaration into the host. Runtime must
  // not invent its expected backend digest by measuring the file it will spawn.
  // This is the same source/identity/compiler, not another candidate producer.
  if (compilerProblems(root).length !== 0)
    throw new Error("GO_HOST_COMPILER_CHANGED");
  await build({
    ...common,
    entryPoints: ["src/apps/desktop/desktop-entry.ts"],
    define: {
      ...common.define,
      __FAROL_GO_CORE__: JSON.stringify(core),
      __FAROL_GO_RESOURCES__: JSON.stringify(coreResources),
      __FAROL_GO_SHELL__: JSON.stringify(shellSupport),
    },
    outfile: "_output/build/app/main.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron", "original-fs"],
  });
  const afterHostLedger = [...inputRecords.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (JSON.stringify(afterHostLedger) !== inputLedgerBytes)
    throw new Error("GO_HOST_INPUTS_CHANGED");
  if (
    JSON.stringify(await declareCoreResources(output, core, buildIdentity)) !==
    JSON.stringify(coreResources)
  )
    throw new Error("GO_HOST_RESOURCES_CHANGED");
  await verifyHostShellResources();
  if (
    JSON.stringify(
      await declareShellSupport(repositoryRoot, core, buildIdentity),
    ) !== JSON.stringify(shellSupport)
  )
    throw new Error("GO_HOST_SHELL_SUPPORT_CHANGED");
  if (
    dependencyDrift(
      root,
      [
        ...toolchainPackageRoots(),
        ...dependencyInputs
          .filter((entry) => entry.path.startsWith("node_modules/"))
          .map((entry) => packageRootOf(entry.path)),
      ],
      readDependencyDigests(root),
    ).length !== 0
  )
    throw new Error("GO_HOST_DEPENDENCIES_CHANGED");
  const afterCore = sourceSnapshot(repositoryRoot, scope);
  if (
    afterCore.commit !== initial.commit ||
    afterCore.treeDigest !== initial.treeDigest ||
    afterCore.dirty
  )
    throw new Error("GO_BUILD_SOURCE_CHANGED");
}
const entries = core
  ? [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort()
  : BUILD_ENTRIES;
const manifest = {
  schema: core ? 4 : 3,
  ...(core ? { core } : {}),
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  version: buildIdentity.version,
  buildId: buildIdentity.buildId,
  builtAt: buildIdentity.builtAt,
  sourceMode: "head-exact",
  sourceCommit: initial.commit,
  sourceTreeDigest: initial.treeDigest,
  dirty: buildIdentity.sourceDirty,
  inputExact,
  inputLedgerSha256: sha256(inputLedgerBytes),
  sourceInputCount: sourceInputs.length,
  dependencyInputCount: dependencyInputs.length,
  entries,
  entrySha256: await snapshotBuildEntries(output, entries),
};
await fs.writeFile(
  "_output/build/app/build-manifest.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
process.stdout.write(
  `built _output/build/app for ${manifest.sourceCommit.slice(0, 12)} (${manifest.dirty ? "dirty" : "clean"}) ${manifest.sourceTreeDigest}\n`,
);
