// Build-only local Dev derivative. This module never starts an application,
// reads a profile, imports a tunnel binding, or modifies a vendor/build input.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "./build-contract.mjs";
import { GO_CORE_ENTRIES, verifyGoCoreArtifact } from "./go-core-artifact.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { assertExactSourceIdentity } from "./candidate-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import {
  observeElectronRuntime,
  assertRuntimeObservation,
  plistValue,
} from "./runtime-contract.mjs";
import { treeDigest } from "./artifact-digest.mjs";
import { normalizePackagedFileModes } from "./package-file-modes.mjs";
import { desktopIdentity, productName } from "./harness-identity.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(ok, code) {
  if (!ok) throw Error(code);
}
export const VM_DEV_SCHEMA = "farol.vm-dev-artifact/1";
const dev = desktopIdentity("dev", "/");
// Every VM Dev name derives from the product-owned identity; Python
// validators receive this exact object in FAROL_VM_DEV_IDENTITY.
export const VM_DEV_APP = dev.applicationName + ".app";
export const VM_DEV_ARCHIVE = dev.applicationName.replaceAll(" ", "-") + ".zip";
const LAUNCHER = "Contents/MacOS/" + productName;
export const VM_DEV_IDENTITY = Object.freeze({
  product: dev.applicationName,
  appName: VM_DEV_APP,
  bundleId: dev.applicationId,
  archiveName: VM_DEV_ARCHIVE,
  executable: productName,
});
export const VM_DEV_IDENTITY_ENV = {
  FAROL_VM_DEV_IDENTITY: JSON.stringify(VM_DEV_IDENTITY),
};

async function regular(file, maximum = 32 * 1024 * 1024) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    requireValue(
      before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum),
      "VM_DEV_INPUT_UNSAFE",
    );
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    requireValue(
      bytes.length === Number(before.size) &&
        ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(
          (k) => before[k] === after[k],
        ),
      "VM_DEV_INPUT_CHANGED",
    );
    return bytes;
  } finally {
    await fd.close();
  }
}

async function requireVMDevLocation(root, output) {
  requireValue(
    path.isAbsolute(root) &&
      path.isAbsolute(output) &&
      path.resolve(root) === root &&
      path.resolve(output) === output,
    "VM_DEV_OUTPUT_UNSAFE",
  );
  const parent = path.join(root, "_output/vm-dev");
  requireValue(
    path.dirname(output) === parent &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(path.basename(output)),
    "VM_DEV_OUTPUT_UNSAFE",
  );
  for (const directory of [root, path.join(root, "_output"), parent, output]) {
    const info = await fs.lstat(directory);
    requireValue(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid() &&
        !(info.mode & 0o022) &&
        (await fs.realpath(directory)) === directory,
      "VM_DEV_OUTPUT_UNSAFE",
    );
  }
}

export async function requireVMDevOutput(root, output) {
  await requireVMDevLocation(root, output);
  requireValue(
    (await fs.readdir(output)).length === 0,
    "VM_DEV_OUTPUT_NOT_EMPTY",
  );
}

export function vmDevInfoPlist(version, minimum) {
  requireValue(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) &&
      /^\d+\.\d+(?:\.\d+)?$/.test(minimum),
    "VM_DEV_IDENTITY_INVALID",
  );
  const fields = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: dev.applicationName,
    CFBundleName: dev.applicationName,
    CFBundleIdentifier: dev.applicationId,
    CFBundleExecutable: productName,
    CFBundlePackageType: "APPL",
    CFBundleIconFile: "farol.icns",
    CFBundleShortVersionString: version,
    CFBundleVersion: "1",
    LSMinimumSystemVersion: minimum,
  };
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' +
    Object.entries(fields)
      .map(([key, value]) => `<key>${key}</key><string>${value}</string>\n`)
      .join("") +
    "<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n"
  );
}

export async function assembleVMDev(root, output) {
  await requireVMDevOutput(root, output);
  const source = path.join(root, "_output/build/app");
  const manifestBytes = await regular(path.join(source, "build-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const build = assertBuildIdentity(
    JSON.parse(await regular(path.join(source, "build-identity.json"))),
  );
  const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
  requireValue(
    manifest.schema === 4 &&
      manifest.dirty === false &&
      manifest.inputExact === true &&
      manifest.sourceMode === "head-exact" &&
      manifest.buildId === build.buildId &&
      manifest.sourceCommit === build.sourceCommit &&
      manifest.sourceTreeDigest === build.sourceTreeDigest &&
      JSON.stringify(manifest.entries) === JSON.stringify(entries),
    "VM_DEV_BUILD_UNQUALIFIED",
  );
  assertExactSourceIdentity(sourceIdentity(root), build);
  await verifyBuildEntries(source, manifest.entrySha256, entries);
  await verifyInputManifest(source, manifest);
  await verifyGoCoreArtifact(source, manifest.core, build);
  const runtime = await observeElectronRuntime(
    path.join(root, "node_modules/electron"),
  );
  assertRuntimeObservation(runtime);
  const vendor = path.join(root, "node_modules/electron/dist/Electron.app");
  const minimum = plistValue(
    path.join(vendor, "Contents/Info.plist"),
    "LSMinimumSystemVersion",
  );
  const launcher = await regular(
    path.join(root, "tooling/vm-dev-launcher.sh"),
    65536,
  );
  const plist = vmDevInfoPlist(build.version, minimum);
  // All authentication above precedes the first output byte. Recheck an empty
  // physical destination immediately before publishing this new derivative.
  await requireVMDevOutput(root, output);
  const app = path.join(output, VM_DEV_APP);
  await fs.mkdir(app, { mode: 0o700 });
  const resources = path.join(app, "Contents/Resources/app");
  await fs.mkdir(resources, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(app, "Contents/MacOS"), { mode: 0o700 });
  await fs.mkdir(path.join(app, "Contents/Frameworks"), { mode: 0o700 });
  await fs.cp(
    vendor,
    path.join(app, "Contents/Frameworks/Electron Runtime.app"),
    {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    },
  );
  for (const name of [...entries, "build-manifest.json"]) {
    const bytes = await regular(path.join(source, name), 256 * 1024 * 1024);
    await fs.writeFile(path.join(resources, name), bytes, {
      flag: "wx",
      mode: (await fs.lstat(path.join(source, name))).mode & 0o777,
    });
  }
  await normalizePackagedFileModes(resources, { hasGoCore: true });
  await fs.chmod(path.join(resources, "update-archive.py"), 0o700);
  await fs.writeFile(path.join(app, LAUNCHER), launcher, {
    flag: "wx",
    mode: 0o755,
  });
  await fs.writeFile(path.join(app, "Contents/Info.plist"), plist, {
    flag: "wx",
    mode: 0o644,
  });
  await fs.copyFile(
    path.join(resources, "farol.icns"),
    path.join(app, "Contents/Resources/farol.icns"),
    fs.constants.COPYFILE_EXCL,
  );
  await fs.writeFile(
    path.join(resources, "package.json"),
    JSON.stringify({
      name: "farol-vm-dev",
      version: build.version,
      private: true,
      type: "module",
      main: "main.cjs",
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await verifyBuildEntries(resources, manifest.entrySha256, entries);
  await verifyInputManifest(resources, manifest);
  await verifyGoCoreArtifact(resources, manifest.core, build);
  requireValue(
    (await treeDigest(
      path.join(app, "Contents/Frameworks/Electron Runtime.app"),
    )) === runtime.extractedTreeDigest,
    "VM_DEV_RUNTIME_COPY_CHANGED",
  );
  requireValue(
    hash(await regular(path.join(source, "build-manifest.json"))) ===
      hash(manifestBytes),
    "VM_DEV_BUILD_CHANGED",
  );
  requireValue(
    hash(await regular(path.join(app, LAUNCHER))) === hash(launcher),
    "VM_DEV_LAUNCHER_CHANGED",
  );
  assertExactSourceIdentity(sourceIdentity(root), build);
  const receipt = {
    schema: VM_DEV_SCHEMA,
    kind: "local-dev-derivative",
    appName: VM_DEV_APP,
    bundleId: dev.applicationId,
    environment: "dev",
    version: build.version,
    parentBuildId: build.buildId,
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    buildManifestSHA256: hash(manifestBytes),
    launcherSHA256: hash(launcher),
    artifactPath: app,
    artifactSha256: await treeDigest(app),
    hostLaunch: false,
    profileImport: false,
    officialRelease: false,
  };
  await fs.writeFile(
    path.join(output, "vm-dev-artifact.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

// This explicit caller-selected commitment predates the ZIP payload. It is
// not read from the ZIP or freshly learned from a candidate being admitted.
export async function archiveVMDev(
  root,
  output,
  expectedReceiptSHA256,
  inspectExisting = false,
) {
  requireValue(
    typeof inspectExisting === "boolean",
    "VM_DEV_ARCHIVE_OPTIONS_INVALID",
  );
  await requireVMDevLocation(root, output);
  requireValue(
    /^[a-f0-9]{64}$/.test(expectedReceiptSHA256),
    "VM_DEV_RECEIPT_UNQUALIFIED",
  );
  const receiptPath = path.join(output, "vm-dev-artifact.json");
  const raw = await regular(receiptPath, 16384);
  requireValue(hash(raw) === expectedReceiptSHA256, "VM_DEV_RECEIPT_CHANGED");
  const receipt = JSON.parse(raw);
  const app = path.join(output, VM_DEV_APP);
  requireValue(
    receipt.schema === VM_DEV_SCHEMA &&
      receipt.kind === "local-dev-derivative" &&
      receipt.appName === VM_DEV_APP &&
      receipt.bundleId === dev.applicationId &&
      receipt.environment === "dev" &&
      receipt.artifactPath === app &&
      receipt.officialRelease === false &&
      receipt.hostLaunch === false &&
      receipt.profileImport === false &&
      /^[a-f0-9]{64}$/.test(receipt.artifactSha256) &&
      /^[a-f0-9]{64}$/.test(receipt.launcherSHA256),
    "VM_DEV_RECEIPT_UNQUALIFIED",
  );
  const appInfo = await fs.lstat(app);
  requireValue(
    appInfo.isDirectory() &&
      !appInfo.isSymbolicLink() &&
      (await fs.realpath(app)) === app,
    "VM_DEV_OUTPUT_UNSAFE",
  );
  requireValue(
    (await treeDigest(app)) === receipt.artifactSha256,
    "VM_DEV_ARTIFACT_CHANGED",
  );
  requireValue(
    hash(await regular(path.join(app, LAUNCHER), 65536)) ===
      receipt.launcherSHA256 &&
      receipt.launcherSHA256 ===
        hash(
          await regular(path.join(root, "tooling/vm-dev-launcher.sh"), 65536),
        ),
    "VM_DEV_LAUNCHER_CHANGED",
  );
  const { stdout } = await promisify(execFile)(
    "/usr/bin/python3",
    [
      "-I",
      "-B",
      path.join(root, "tooling/vm-dev-archive.py"),
      "--output",
      output,
      "--expected-receipt-sha256",
      expectedReceiptSHA256,
      ...(inspectExisting ? ["--inspect-existing"] : []),
    ],
    {
      cwd: root,
      timeout: 120000,
      maxBuffer: 32768,
      env: {
        ...Object.fromEntries(
          ["HOME", "USER", "TMPDIR"]
            .filter((k) => process.env[k] !== undefined)
            .map((k) => [k, process.env[k]]),
        ),
        ...VM_DEV_IDENTITY_ENV,
      },
    },
  );
  const archived = JSON.parse(stdout);
  requireValue(
    hash(await regular(receiptPath, 16384)) === expectedReceiptSHA256 &&
      (await treeDigest(app)) === receipt.artifactSha256 &&
      archived.schema === "farol.vm-dev-archive/1" &&
      archived.receiptSHA256 === expectedReceiptSHA256 &&
      archived.artifactSha256 === receipt.artifactSha256 &&
      archived.bundleId === dev.applicationId &&
      archived.officialRelease === false &&
      archived.archiveName === VM_DEV_ARCHIVE &&
      /^[a-f0-9]{64}$/.test(archived.archiveSha256),
    "VM_DEV_ARTIFACT_CHANGED",
  );
  return archived;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  requireValue(process.argv.length === 3, "VM_DEV_OUTPUT_REQUIRED");
  console.log(
    JSON.stringify(await assembleVMDev(process.cwd(), process.argv[2])),
  );
}
