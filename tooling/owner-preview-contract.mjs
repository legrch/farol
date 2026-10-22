import assert from "node:assert/strict";
import path from "node:path";
import {
  OWNER_PREVIEW_IDENTITY,
  desktopEnvironment,
  desktopIdentity,
  ownerPreviewIdentity,
  desktopCodexConfigPath,
  desktopCodexChildHomes,
} from "../src/apps/desktop/desktop-environment.ts";
import { PREVIEW_ASSET_RECIPE } from "./owner-preview-assets.mjs";
import { candidatePaths } from "./candidate-contract.mjs";

export const OWNER_PREVIEW_SCHEMA = "farol-owner-preview/1";
export const OWNER_PREVIEW_APP = "Farol Preview.app";
export const OWNER_PREVIEW_INTEGRATION_REQUIRED =
  "OWNER_PREVIEW_RUNTIME_INTEGRATION_REQUIRED";
export const PREVIEW_ASSET_PATHS = Object.freeze({
  "farol-preview-mark.svg": "Contents/Resources/app/farol-preview-mark.svg",
  "farol-preview-mark.png": "Contents/Resources/app/farol-preview-mark.png",
  "farol-preview.icns": "Contents/Resources/farol-preview.icns",
});
export const PREVIEW_LAUNCHER_PATH = "Contents/MacOS/Farol";
// No caller arguments, environment hooks, profile flags or runtime toolchain.
// E2E drives the unchanged embedded Electron with its separately proven root.
export const PREVIEW_LAUNCHER = `#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo "OWNER_PREVIEW_ARGUMENTS_INVALID" >&2; exit 1; }
launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=\${launcher_path%/*}
contents_dir=\${macos_dir%/*}
exec /usr/bin/env -i \\
  HOME="\${HOME:?OWNER_PREVIEW_HOME_REQUIRED}" \\
  LANG="\${LANG:-en_US.UTF-8}" \\
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
  TMPDIR="\${TMPDIR:-/tmp}" \\
  ELECTRON_FORCE_IS_PACKAGED=true \\
  FAROL_ENVIRONMENT=owner-preview \\
  "$contents_dir/Frameworks/Electron Runtime.app/Contents/MacOS/Electron" \\
  "$contents_dir/Resources/app"
`;
export const PREVIEW_RECIPE = Object.freeze({
  schema: "farol-owner-preview-recipe/1",
  plist: {
    CFBundleDisplayName: "Farol Preview",
    CFBundleName: "Farol Preview",
    CFBundleIdentifier: "local.farol.owner.preview",
    CFBundleIconFile: "farol-preview.icns",
  },
  launcher: PREVIEW_LAUNCHER,
  branding: PREVIEW_ASSET_RECIPE,
  addedResources: PREVIEW_ASSET_PATHS,
  addedResourceMode: 0o644,
  // All other files, links, directories and modes must match the sealed base.
});

export function ownerPreviewArguments(args) {
  const [action, option, expectedMain] = args;
  if (
    !["plan", "build", "run", "build-run"].includes(action) ||
    !(
      args.length === 1 ||
      (args.length === 3 &&
        option === "--expected-main" &&
        /^[a-f0-9]{40}$/u.test(expectedMain ?? ""))
    )
  )
    throw new Error(
      "Usage: owner-preview.mjs plan|build|run|build-run [--expected-main <full SHA>]",
    );
  return { action, expectedMain };
}

export function ownerPreviewLaunchMessage(result, generation) {
  if (result === "reopened")
    throw new Error(
      "OWNER_PREVIEW_RUNNING_GENERATION_UNCONFIRMED: an existing source-equivalent Preview was reopened; its generation was not observed. Quit it normally before launching the intended generation.",
    );
  if (result !== "primary-started")
    throw new Error(`OWNER_PREVIEW_LAUNCH_REFUSED:${result}`);
  if (!/^[a-f0-9]{64}$/u.test(generation ?? ""))
    throw new Error("OWNER_PREVIEW_GENERATION_INVALID");
  return `Owner Preview primary-started: ${generation}\n`;
}

export function assertOwnerPreviewSource({
  expectedMain,
  localMain,
  trackedMain,
  remoteMain,
  source,
}) {
  const commit = source?.commit;
  if (
    !/^[a-f0-9]{40}$/u.test(commit ?? "") ||
    (expectedMain !== undefined && expectedMain !== commit) ||
    localMain !== commit ||
    trackedMain !== commit ||
    remoteMain !== commit ||
    source?.dirty !== false ||
    !/^[a-f0-9]{64}$/u.test(source?.treeDigest ?? "")
  )
    throw new Error("OWNER_PREVIEW_CURRENT_MAIN_REQUIRED");
}

export function requireOwnerPreviewRuntimeIntegration() {
  try {
    assert.deepEqual(OWNER_PREVIEW_IDENTITY, {
      environment: "owner-preview",
      displayName: "Farol Preview",
      displayEdition: "",
      applicationId: "local.farol.owner.preview",
      applicationName: "Farol Preview",
      dataDirectoryName: "Farol Preview",
      runtimePartition: "persist:farol-owner-preview-runtime",
      chatGptPartition: "persist:farol-owner-preview-chatgpt",
      runtimeIdentity: "farol-owner-preview-runtime",
      runtimeServiceName: "Farol Preview Runtime",
    });
    const environment = desktopEnvironment("owner-preview");
    assert.equal(environment, "owner-preview");
    const appData = "/__farol_preview_contract__/app-data";
    const identity = desktopIdentity(environment, appData);
    assert.deepEqual(identity, ownerPreviewIdentity(appData));
    const homes = desktopCodexChildHomes(
      environment,
      identity,
      "/__owner_home__",
      "/__foreign_codex__",
    );
    assert.deepEqual(homes, {
      codexHomePath: path.join(identity.userData, "farol-private/codex-home"),
      processHomePath: path.join(
        identity.userData,
        "farol-private/process-home",
      ),
    });
    assert.equal(
      desktopCodexConfigPath(environment, identity, "/__owner_home__"),
      path.join(identity.codexHome, "config.toml"),
    );
    for (const existing of ["preview", "dev"]) {
      const other = desktopIdentity(existing, appData);
      for (const key of [
        "applicationId",
        "userData",
        "sessionData",
        "codexHome",
        "runtimePartition",
        "chatGptPartition",
        "runtimeIdentity",
        "runtimeServiceName",
      ])
        assert.notEqual(identity[key], other[key]);
    }
    return identity;
  } catch {
    throw new Error(OWNER_PREVIEW_INTEGRATION_REQUIRED);
  }
}

export function previewPlist(base) {
  let result = base;
  for (const [key, value] of Object.entries(PREVIEW_RECIPE.plist)) {
    const pattern = new RegExp(
      `(<key>${key}</key>\\s*<string>)[^<]*(</string>)`,
      "gu",
    );
    if ([...result.matchAll(pattern)].length !== 1)
      throw new Error(`OWNER_PREVIEW_PLIST_FIELD_INVALID:${key}`);
    result = result.replace(pattern, `$1${value}$2`);
  }
  return result;
}

export function generationPaths(root, generation) {
  if (!/^[a-f0-9]{64}$/u.test(generation ?? ""))
    throw new Error("OWNER_PREVIEW_GENERATION_INVALID");
  const directory = path.join(root, "_output/preview/generations", generation);
  return {
    directory,
    generation,
    appPath: path.join(directory, OWNER_PREVIEW_APP),
    artifactFile: path.join(directory, "derivative.json"),
    baseApp: path.join(directory, ".canonical/Farol.app"),
    baseArtifact: path.join(directory, ".canonical/artifact.json"),
  };
}

export function previewLinkTarget(generation) {
  generationPaths("/unused", generation);
  return `generations/${generation}/${OWNER_PREVIEW_APP}`;
}
export function generationFromLink(target) {
  const match = /^generations\/([a-f0-9]{64})\/Farol Preview\.app$/u.exec(
    target,
  );
  if (!match) throw new Error("OWNER_PREVIEW_CURRENT_LINK_INVALID");
  return match[1];
}

export function ownerPreviewPlan(root, observation) {
  assertOwnerPreviewSource(observation);
  let runtimeAdmission = "admitted";
  try {
    requireOwnerPreviewRuntimeIntegration();
  } catch {
    runtimeAdmission = "integration-required";
  }
  return {
    kind: "owner-preview-plan",
    runtimeAdmission,
    identity: OWNER_PREVIEW_IDENTITY,
    sourceCommit: observation.source.commit,
    sourceTreeDigest: observation.source.treeDigest,
    remoteFreshness: "bounded-origin-main-read",
    base: {
      command: "task package",
      ...candidatePaths(root),
      goInputs: path.join(root, "_output/go-build-inputs.json"),
    },
    output: {
      appPath: path.join(root, "_output/preview", OWNER_PREVIEW_APP),
      generations: path.join(root, "_output/preview/generations"),
    },
    packageVerified: false,
    derivativeVerified: false,
    launchAllowed: false,
  };
}
