import {
  parseCoreArtifactDeclaration,
  verifyCoreExecutable,
} from "./bridge/attested-core.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import type { InstalledGoSlotBindingHelper } from "../../src/modules/release/infra/native/installed-update-helper";

// Trusted Electron composition only. Resource custody comes from the existing
// installed execution snapshot/controller, independently of the measured file.
// This adapter selects no operation, profile, path permission or recovery action.
export function installedGoSlotBindingHelper(
  input: Readonly<{
    compiledArtifact: unknown;
    build: BuildIdentity;
    directory: string;
    recheck(): Promise<void>;
    beforeEffect(): void;
  }>,
): InstalledGoSlotBindingHelper {
  const artifact = parseCoreArtifactDeclaration(input.compiledArtifact);
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
  return Object.freeze({
    buildId: artifact.build.buildId,
    qualify: async () => {
      beforeEffect();
      await recheck();
      beforeEffect();
      const executable = verifyCoreExecutable(artifact, {
        artifactRoot: directory,
        build: artifact.build,
        binary: artifact.binary,
        profileId: "installed-slot-binding",
      });
      await recheck();
      beforeEffect();
      return executable;
    },
  });
}
