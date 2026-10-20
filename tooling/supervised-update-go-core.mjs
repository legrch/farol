import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { assertGoCoreDeclaration } from "./go-core-artifact.mjs";

const SHARED_CLAIMS = Object.freeze(["version", "buildVersion", "buildId"]);

function requireValue(condition) {
  if (!condition) throw new Error("UPDATE_HELPER_GO_CORE_REQUIRED");
}

/**
 * The supervised controller runs the accepted TARGET package's Go release
 * helper. Its compiled declaration and build identity are the exact values the
 * package verifier checked the bundled binary against, captured by the
 * resource observation (`captureSupervisedUpdateResources().goCore`) inside
 * its tree-digest fences. Nothing is re-read from the mutable package path
 * here, so a declaration cannot be supplied separately from the verified
 * bytes. The claimed identity must also equal the exact build the owner
 * selected, and the runtime still measures the executable against this
 * declaration before each launch.
 *
 * A package without a compiled core cannot run a helper and refuses before
 * the predecessor is asked to quit. There is no Python alternative.
 */
export function selectSupervisedGoCore({ goCore, expected }) {
  requireValue(
    goCore !== null &&
      typeof goCore === "object" &&
      goCore.core !== null &&
      typeof goCore.core === "object" &&
      !Array.isArray(goCore.core),
  );
  const identity = assertBuildIdentity(goCore.identity);
  requireValue(
    SHARED_CLAIMS.every((key) => identity[key] === expected[key]) &&
      identity.sourceCommit === expected.sourceCommit &&
      identity.sourceTreeDigest === expected.sourceTreeDigest &&
      identity.sourceDirty === false,
  );
  const declaration = assertGoCoreDeclaration(goCore.core, identity);
  return Object.freeze({ goCoreArtifact: declaration, goCoreBuild: identity });
}
