import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";

const root = process.cwd();
const artifactIndex = process.argv.indexOf("--artifact");
const artifactFile = path.resolve(
  artifactIndex === -1
    ? path.join(root, "dist/package/artifact.json")
    : (process.argv[artifactIndex + 1] ?? ""),
);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

requireValue(artifact.schema === 1, "PACKAGE_MANIFEST_SCHEMA_INVALID");
requireValue(
  artifact.product === "Farol Next Preview",
  "PACKAGE_PRODUCT_INVALID",
);
requireValue(
  artifact.bundleId === "local.farol.next.preview",
  "PACKAGE_BUNDLE_ID_INVALID",
);
requireValue(
  /^[a-f0-9]{40}$/u.test(artifact.sourceCommit),
  "PACKAGE_SOURCE_COMMIT_INVALID",
);
requireValue(
  /^[a-f0-9]{64}$/u.test(artifact.sourceTreeDigest),
  "PACKAGE_SOURCE_DIGEST_INVALID",
);
requireValue(
  /^[a-f0-9]{64}$/u.test(artifact.artifactSha256),
  "PACKAGE_DIGEST_INVALID",
);
requireValue(
  typeof artifact.sourceDirty === "boolean",
  "PACKAGE_DIRTY_STATE_INVALID",
);
requireValue(artifact.signing === "ad-hoc", "PACKAGE_SIGNING_IDENTITY_INVALID");
requireValue(
  artifact.notarized === false,
  "PACKAGE_NOTARIZATION_CLAIM_INVALID",
);
requireValue(
  artifact.updateChannel === "local-preview-only",
  "PACKAGE_CHANNEL_INVALID",
);
requireValue(
  artifact.runtime?.electron === "41.10.7" &&
    artifact.runtime?.node === "embedded-in-electron" &&
    artifact.runtime?.testerManagedRuntime === false,
  "PACKAGE_RUNTIME_CLOSURE_INVALID",
);

const appPath = path.resolve(artifact.artifactPath);
requireValue(
  path.basename(appPath) === "Farol Next Preview.app",
  "PACKAGE_PATH_INVALID",
);
const actualDigest = await treeDigest(appPath);
requireValue(
  actualDigest === artifact.artifactSha256,
  "PACKAGE_DIGEST_MISMATCH",
);

const resources = path.join(appPath, "Contents/Resources/app");
const embedded = JSON.parse(
  await fs.readFile(path.join(resources, "build-manifest.json"), "utf8"),
);
requireValue(embedded.schema === 1, "PACKAGE_EMBEDDED_MANIFEST_INVALID");
requireValue(
  embedded.product === artifact.product,
  "PACKAGE_EMBEDDED_PRODUCT_MISMATCH",
);
requireValue(
  embedded.bundleId === artifact.bundleId,
  "PACKAGE_EMBEDDED_BUNDLE_MISMATCH",
);
requireValue(
  embedded.sourceCommit === artifact.sourceCommit,
  "PACKAGE_EMBEDDED_COMMIT_MISMATCH",
);
requireValue(
  embedded.sourceTreeDigest === artifact.sourceTreeDigest,
  "PACKAGE_EMBEDDED_DIGEST_MISMATCH",
);
requireValue(
  embedded.dirty === artifact.sourceDirty,
  "PACKAGE_EMBEDDED_DIRTY_MISMATCH",
);

function plistValue(plist, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    {
      encoding: "utf8",
    },
  ).trim();
}

const mainPlist = path.join(appPath, "Contents/Info.plist");
requireValue(
  plistValue(mainPlist, "CFBundleIdentifier") === artifact.bundleId,
  "PACKAGE_PLIST_BUNDLE_MISMATCH",
);
requireValue(
  plistValue(mainPlist, "CFBundleExecutable") === "Farol Next Preview",
  "PACKAGE_PLIST_EXECUTABLE_MISMATCH",
);
await fs.access(path.join(appPath, "Contents/MacOS/Farol Next Preview"));
await fs.access(path.join(resources, "THIRD_PARTY_NOTICES.txt"));

const helpers = [
  { suffix: "", id: "helper" },
  { suffix: " (GPU)", id: "helper.gpu" },
  { suffix: " (Plugin)", id: "helper.plugin" },
  { suffix: " (Renderer)", id: "helper.renderer" },
];
for (const helper of helpers) {
  const name = `Farol Next Preview Helper${helper.suffix}`;
  const helperRoot = path.join(appPath, "Contents/Frameworks", `${name}.app`);
  const helperPlist = path.join(helperRoot, "Contents/Info.plist");
  requireValue(
    plistValue(helperPlist, "CFBundleExecutable") === name,
    "PACKAGE_HELPER_IDENTITY_MISMATCH",
  );
  requireValue(
    plistValue(helperPlist, "CFBundleIdentifier") ===
      `local.farol.next.preview.${helper.id}`,
    "PACKAGE_HELPER_BUNDLE_MISMATCH",
  );
  await fs.access(path.join(helperRoot, "Contents/MacOS", name));
}

execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
  stdio: "pipe",
});
execFileSync("/usr/bin/plutil", ["-lint", mainPlist], { stdio: "pipe" });
process.stdout.write(
  `verified ${artifact.product} ${artifact.artifactSha256} (${artifact.sourceDirty ? "dirty" : "clean"})\n`,
);
