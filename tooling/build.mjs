import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { BUILD_ENTRIES, snapshotBuildEntries } from "./build-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = process.cwd();
const repositoryRoot = path.resolve(root, "..");
const output = path.join(root, "dist/app");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });

const common = {
  bundle: true,
  logLevel: "warning",
  sourcemap: false,
  target: "node24",
};
await Promise.all([
  build({
    ...common,
    entryPoints: ["src/boot/electron-main.ts"],
    outfile: "dist/app/main.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/boot/runtime-entry.ts"],
    outfile: "dist/app/runtime.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/boot/preload.ts"],
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
  }),
]);
await Promise.all([
  fs.copyFile("src/ui/shell.html", "dist/app/shell.html"),
  fs.copyFile("src/ui/shell.css", "dist/app/shell.css"),
]);

const identity = sourceIdentity(
  repositoryRoot,
  path.relative(repositoryRoot, root).split(path.sep).join("/"),
);
const manifest = {
  schema: 1,
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  sourceCommit: identity.commit,
  sourceTreeDigest: identity.treeDigest,
  dirty: identity.dirty,
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
