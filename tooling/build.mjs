import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const repositoryRoot = path.resolve(root, "..");
const output = path.join(root, "dist/app");

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["dist", "node_modules", "coverage", "artifacts"].includes(entry.name))
      continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else files.push(target);
  }
  return files.sort();
}

async function digestInputs() {
  const hash = createHash("sha256");
  for (const file of await sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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

const commit = execFileSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
const dirty =
  execFileSync(
    "git",
    ["-C", repositoryRoot, "status", "--porcelain", "--", "vnext"],
    {
      encoding: "utf8",
    },
  ).trim().length > 0;
const manifest = {
  schema: 1,
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  sourceCommit: commit,
  sourceTreeDigest: await digestInputs(),
  dirty,
  entries: [
    "main.cjs",
    "preload.cjs",
    "runtime.cjs",
    "shell.css",
    "shell.html",
    "shell.js",
  ],
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
