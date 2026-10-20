import { createCoreArtifactVerifier } from "../../src/pkg/kernel/infra/core-artifact.ts";
import { BridgeError } from "./bridge/client.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import type { InstalledGoUpdateHelper } from "../../src/modules/release/infra/native/installed-update-helper";

const verification = createCoreArtifactVerifier({
  refuse: (code): never => {
    throw new BridgeError("refused", code);
  },
  isRefusal: (error) => error instanceof BridgeError,
});

// Trusted Electron composition only. Resource custody comes from the existing
// installed execution snapshot/controller, independently of the measured file.
// This adapter selects no operation, profile, path permission or recovery action.
// `recheck` verifies resource custody only; the effect fence is `beforeEffect`,
// which `qualify` runs around every check and `remeasure` never runs.
export function installedGoSlotBindingHelper(
  input: Readonly<{
    compiledArtifact: unknown;
    build: BuildIdentity;
    directory: string;
    recheck(): Promise<void>;
    beforeEffect(): void;
  }>,
): InstalledGoUpdateHelper {
  const artifact = verification.parseCoreArtifactDeclaration(
    input.compiledArtifact,
  );
  if (
    input.build.sourceDirty ||
    artifact.build.buildId !== input.build.buildId ||
    artifact.build.sourceSHA !== input.build.sourceCommit ||
    artifact.build.sourceTreeDigest !== input.build.sourceTreeDigest ||
    artifact.binary.path !== "farol-backend"
  )
    throw new Error("UPDATE_SLOT_BINDING_GO_BUILD_MISMATCH");
  const directory = input.directory;
  const recheck = input.recheck;
  const beforeEffect = input.beforeEffect;
  const verify = () =>
    verification.verifyCoreExecutable(artifact, {
      artifactRoot: directory,
      build: artifact.build,
      binary: artifact.binary,
    });
  return Object.freeze({
    buildId: artifact.build.buildId,
    qualify: async () => {
      beforeEffect();
      await recheck();
      beforeEffect();
      const executable = verify();
      await recheck();
      beforeEffect();
      return executable;
    },
    remeasure: async () => {
      await recheck();
      const executable = verify();
      await recheck();
      return executable;
    },
  });
}
