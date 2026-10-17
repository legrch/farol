import path from "node:path";
import { OWNER_PREVIEW_IDENTITY } from "../src/apps/desktop/desktop-environment.ts";
import { candidatePaths } from "./candidate-contract.mjs";

export const OWNER_PREVIEW_INTEGRATION_REQUIRED =
  "OWNER_PREVIEW_RUNTIME_INTEGRATION_REQUIRED";

export function ownerPreviewArguments(arguments_) {
  const [action, option, expectedMain] = arguments_;
  if (
    arguments_.length !== 3 ||
    !["plan", "build", "run"].includes(action) ||
    option !== "--expected-main" ||
    !/^[a-f0-9]{40}$/u.test(expectedMain ?? "")
  ) {
    throw new Error(
      "Usage: owner-preview.mjs plan|build|run --expected-main <full accepted main SHA>",
    );
  }
  return { action, expectedMain };
}

export function assertOwnerPreviewSource({
  expectedMain,
  localMain,
  trackedMain,
  source,
}) {
  if (
    !/^[a-f0-9]{40}$/u.test(expectedMain ?? "") ||
    localMain !== expectedMain ||
    trackedMain !== expectedMain ||
    source?.commit !== expectedMain ||
    source?.dirty !== false ||
    !/^[a-f0-9]{64}$/u.test(source?.treeDigest ?? "")
  ) {
    throw new Error("OWNER_PREVIEW_CURRENT_MAIN_REQUIRED");
  }
}

export function ownerPreviewPlan(root, sourceObservation) {
  assertOwnerPreviewSource(sourceObservation);
  const canonical = candidatePaths(root);
  return {
    kind: "owner-preview-plan",
    status: "blocked-runtime-integration",
    identity: OWNER_PREVIEW_IDENTITY,
    sourceCommit: sourceObservation.source.commit,
    sourceTreeDigest: sourceObservation.source.treeDigest,
    remoteFreshness: "not-checked-offline",
    base: { command: "task package", ...canonical },
    output: {
      appPath: path.join(root, "_output/preview/Farol Preview.app"),
      artifactFile: path.join(root, "_output/preview/artifact.json"),
    },
    // A plan is not a build, verification or launch receipt.
    packageVerified: false,
    derivativeVerified: false,
    launchAllowed: false,
  };
}

export function requireOwnerPreviewRuntimeIntegration() {
  throw new Error(
    `${OWNER_PREVIEW_INTEGRATION_REQUIRED}: see docs/development/owner-preview.md; no artifact was built or launched`,
  );
}
