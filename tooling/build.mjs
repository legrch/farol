import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
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
import {
  dependencyDrift,
  packageRootOf,
  readDependencyDigests,
  toolchainPackageRoots,
} from "./dependency-digests.mjs";

const root = process.cwd();
const repositoryRoot = path.resolve(root, "..");
const output = path.join(root, "dist/app");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");
const initial = sourceSnapshot(repositoryRoot, scope);
const inputRecords = new Map();

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

  const repositoryRelative = `${scope}/${relative}`;
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
await verifyGeistSources(root);
const packageDocument = JSON.parse(
  (await readBuildInput("package.json")).toString("utf8"),
);

const common = {
  bundle: true,
  logLevel: "warning",
  sourcemap: false,
  target: "node24",
  metafile: true,
  plugins: [attestInputs],
};
await Promise.all([
  build({
    ...common,
    entryPoints: ["src/apps/desktop/main.ts"],
    outfile: "dist/app/main.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/apps/runtime/main.ts"],
    outfile: "dist/app/runtime.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/apps/computer-mcp/main.ts"],
    outfile: "dist/app/computer-mcp.cjs",
    platform: "node",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["src/apps/desktop/preload.ts"],
    outfile: "dist/app/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    bundle: true,
    entryPoints: ["src/ui/shell.ts"],
    outfile: "dist/app/shell.js",
    platform: "browser",
    format: "iife",
    logLevel: "warning",
    sourcemap: false,
    target: ["chrome145"],
    metafile: true,
    plugins: [attestInputs],
  }),
]);
await Promise.all([
  readBuildInput("src/ui/shell.html").then((bytes) =>
    fs.writeFile("dist/app/shell.html", bytes),
  ),
  readBuildInput("src/ui/shell.css").then((bytes) =>
    fs.writeFile("dist/app/shell.css", bytes),
  ),
  readBuildInput("resources.json").then((bytes) => {
    assertResourceManifest(JSON.parse(bytes.toString("utf8")));
    return fs.writeFile("dist/app/resource-manifest.json", bytes);
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
]);
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
    ...dependencyInputs.map((entry) => packageRootOf(entry.path)),
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
  !compilerRedirected;
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
const manifest = {
  schema: 3,
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
  entries: BUILD_ENTRIES,
  entrySha256: await snapshotBuildEntries(output),
};
await fs.writeFile(
  "dist/app/build-manifest.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
process.stdout.write(
  `built dist/app for ${manifest.sourceCommit.slice(0, 12)} (${manifest.dirty ? "dirty" : "clean"}) ${manifest.sourceTreeDigest}\n`,
);
