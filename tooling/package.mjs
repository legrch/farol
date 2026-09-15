import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";
import { BUILD_ENTRIES, verifyBuildEntries } from "./build-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = process.cwd();
const builtRoot = path.join(root, "dist/app");
const packageRoot = path.join(root, "dist/package");
const appPath = path.join(packageRoot, "Farol Next Preview.app");
const electronApp = path.join(root, "node_modules/electron/dist/Electron.app");
const repositoryRoot = path.resolve(root, "..");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");

const manifest = JSON.parse(
  await fs.readFile(path.join(builtRoot, "build-manifest.json"), "utf8"),
);
if (
  manifest.schema !== 2 ||
  manifest.sourceMode !== "head-exact" ||
  manifest.inputExact !== true ||
  !/^[a-f0-9]{64}$/u.test(manifest.inputLedgerSha256 ?? "")
) {
  throw new Error("BUILD_SOURCE_ATTESTATION_INVALID");
}
if (
  !Array.isArray(manifest.entries) ||
  manifest.entries.length !== BUILD_ENTRIES.length ||
  !manifest.entries.every((entry, index) => entry === BUILD_ENTRIES[index])
) {
  throw new Error("BUILD_ENTRY_SET_INVALID");
}
await verifyBuildEntries(builtRoot, manifest.entrySha256);
const currentSource = sourceIdentity(repositoryRoot, scope);
if (
  manifest.dirty ||
  currentSource.dirty ||
  currentSource.commit !== manifest.sourceCommit ||
  currentSource.treeDigest !== manifest.sourceTreeDigest
) {
  throw new Error(
    "PACKAGE_DIRTY_SOURCE: commit the exact vNext source and rebuild first",
  );
}

const electronSourceSha256 = await treeDigest(electronApp);

await fs.rm(packageRoot, { recursive: true, force: true });
await fs.mkdir(packageRoot, { recursive: true });
await fs.cp(electronApp, appPath, {
  recursive: true,
  verbatimSymlinks: true,
  preserveTimestamps: true,
});

function setPlist(plist, key, type, value) {
  try {
    execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :${key} ${value}`, plist],
      {
        stdio: "pipe",
      },
    );
  } catch {
    execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Add :${key} ${type} ${value}`, plist],
      {
        stdio: "pipe",
      },
    );
  }
}

async function renameExecutable(app, oldName, nextName) {
  const source = path.join(app, "Contents/MacOS", oldName);
  const target = path.join(app, "Contents/MacOS", nextName);
  await fs.rename(source, target);
  const plist = path.join(app, "Contents/Info.plist");
  setPlist(plist, "CFBundleExecutable", "string", nextName);
  setPlist(plist, "CFBundleDisplayName", "string", nextName);
  setPlist(plist, "CFBundleName", "string", nextName);
}

await renameExecutable(appPath, "Electron", "Farol Next Preview");
const mainPlist = path.join(appPath, "Contents/Info.plist");
setPlist(mainPlist, "CFBundleIdentifier", "string", "local.farol.next.preview");
setPlist(mainPlist, "CFBundleShortVersionString", "string", "0.1.0");
setPlist(mainPlist, "CFBundleVersion", "string", "1");
setPlist(
  mainPlist,
  "NSHumanReadableCopyright",
  "string",
  "Local development preview",
);

const helperKinds = [
  { suffix: "", id: "helper" },
  { suffix: " (GPU)", id: "helper.gpu" },
  { suffix: " (Plugin)", id: "helper.plugin" },
  { suffix: " (Renderer)", id: "helper.renderer" },
];
const frameworks = path.join(appPath, "Contents/Frameworks");
for (const helper of helperKinds) {
  const oldApp = path.join(frameworks, `Electron Helper${helper.suffix}.app`);
  const nextName = `Farol Next Preview Helper${helper.suffix}`;
  await renameExecutable(oldApp, `Electron Helper${helper.suffix}`, nextName);
  setPlist(
    path.join(oldApp, "Contents/Info.plist"),
    "CFBundleIdentifier",
    "string",
    `local.farol.next.preview.${helper.id}`,
  );
  await fs.rename(oldApp, path.join(frameworks, `${nextName}.app`));
}

const resources = path.join(appPath, "Contents/Resources");
await fs.rm(path.join(resources, "default_app.asar"), { force: true });
const appResources = path.join(resources, "app");
await fs.rm(appResources, { recursive: true, force: true });
await fs.mkdir(appResources, { recursive: true });
for (const entry of BUILD_ENTRIES) {
  await fs.copyFile(
    path.join(builtRoot, entry),
    path.join(appResources, entry),
  );
}
await fs.copyFile(
  path.join(builtRoot, "build-manifest.json"),
  path.join(appResources, "build-manifest.json"),
);
await fs.writeFile(
  path.join(appResources, "package.json"),
  `${JSON.stringify(
    {
      name: "farol-next-preview-app",
      version: "0.1.0-preview.0",
      private: true,
      productName: "Farol Next Preview",
      type: "module",
      main: "main.cjs",
    },
    null,
    2,
  )}\n`,
);
const zodLicense = await fs.readFile(
  path.join(root, "node_modules/zod/LICENSE"),
  "utf8",
);
await fs.writeFile(
  path.join(appResources, "THIRD_PARTY_NOTICES.txt"),
  `Farol Next Preview direct runtime notice\n\nZod 4.6.5 (MIT)\n${zodLicense}\n\nElectron's own license and Chromium notices are retained in Contents/Resources.\n`,
);

execFileSync(
  "/usr/bin/codesign",
  ["--force", "--deep", "--sign", "-", appPath],
  {
    stdio: "inherit",
  },
);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
  stdio: "inherit",
});
execFileSync("/usr/bin/plutil", ["-lint", mainPlist], { stdio: "inherit" });

function codeSignature(app) {
  const inspected = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], {
    encoding: "utf8",
  });
  if (inspected.status !== 0) throw new Error("PACKAGE_SIGNATURE_UNREADABLE");
  const detail = `${inspected.stdout}${inspected.stderr}`;
  const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(detail)?.[1];
  if (
    !cdHash ||
    !/^Signature=adhoc$/mu.test(detail) ||
    !/^TeamIdentifier=not set$/mu.test(detail) ||
    !/^Identifier=local\.farol\.next\.preview$/mu.test(detail)
  ) {
    throw new Error("PACKAGE_SIGNATURE_IDENTITY_INVALID");
  }
  return { kind: "ad-hoc", teamIdentifier: null, cdHash };
}

const signing = codeSignature(appPath);

const artifact = {
  schema: 2,
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  sourceCommit: manifest.sourceCommit,
  sourceTreeDigest: manifest.sourceTreeDigest,
  sourceDirty: manifest.dirty,
  artifactPath: appPath,
  artifactSha256: await treeDigest(appPath),
  electronSourceSha256,
  runtime: {
    electron: "41.10.7",
    node: "embedded-in-electron",
    testerManagedRuntime: false,
  },
  signing,
  notarized: false,
  updateChannel: "local-preview-only",
};
await fs.writeFile(
  path.join(packageRoot, "artifact.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  { mode: 0o600 },
);
execFileSync(
  process.execPath,
  [
    path.join(root, "tooling/verify-package.mjs"),
    "--artifact",
    path.join(packageRoot, "artifact.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
