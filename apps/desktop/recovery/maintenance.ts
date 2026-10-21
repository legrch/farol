import path from "node:path";
import { activationObligations } from "../../../src/apps/desktop/legacy-activation-obligations";
import { assertClosedConnectorProcesses } from "../../../src/apps/desktop/closed-computer-recovery";
import {
  DEV_DATA_DIRECTORY_NAME,
  LEGACY_DEV_DATA_DIRECTORY_NAME,
} from "../../../src/apps/desktop/dev-profile-directory";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import { verifyCoreExecutable } from "../bridge/attested-core";
import {
  CORE_QUALIFICATION_BUDGET_MS,
  verifyCoreResources,
} from "../bridge/core-resources";
import {
  desktopCoreExpectation,
  readDesktopCoreDeclaration,
} from "../bridge/desktop-artifact";
import { discoverPreservedRecoveryChild } from "../bridge/preserved-inspection-child";
import {
  recoverStartupPreservedChat,
  type StartupPreservedRecoveryInput,
} from "../bridge/preserved-recovery-host";
import { selectStartupPreservedRecovery } from "./selection";

// One original startup attempt, before any read-only or normal runtime child.
// No renderer input, retry, settings writer, provider or new authority is added.
// The enclosing Electron owner retains the actual admission lease and singleton.
export async function runStartupPreservedMaintenance(
  input: Readonly<{
    userData: string;
    home: string;
    computerId: string;
    build: BuildIdentity;
    artifactRoot: string;
    compiledArtifact: unknown;
    compiledResources: unknown;
    startup: StartupPreservedRecoveryInput["startup"];
  }>,
): Promise<Awaited<ReturnType<typeof recoverStartupPreservedChat>>> {
  const { userData, home, computerId, artifactRoot } = input;
  const build = structuredClone(input.build);
  const compiledResources = structuredClone(input.compiledResources);
  const expected = desktopCoreExpectation({
    build,
    compiledArtifact: structuredClone(input.compiledArtifact),
  });
  const { lease, verify, assertCurrent } = input.startup;
  const current = async () => {
    await assertCurrent();
    if (!(await verify())) throw Error("STARTUP_PROMOTION_LEASE_LOST");
  };
  await current();
  const candidate = await selectStartupPreservedRecovery({
    userData,
    home,
    computerId,
    buildId: build.buildId,
    assertCurrent: current,
  });
  const attest = async () => {
    await current();
    const declaration = readDesktopCoreDeclaration(artifactRoot, expected);
    await verifyCoreResources(
      artifactRoot,
      compiledResources,
      expected,
      performance.now() + CORE_QUALIFICATION_BUDGET_MS,
    );
    return verifyCoreExecutable(declaration, {
      artifactRoot,
      build: expected.build,
      binary: expected.binary,
      profileId: candidate.profile.profileId,
    });
  };
  const processesAbsent = () => {
    // Historical children may have been launched with either Dev spelling.
    // These are the existing fixed-root probes; no PID is signalled or guessed.
    const names = [DEV_DATA_DIRECTORY_NAME, LEGACY_DEV_DATA_DIRECTORY_NAME];
    const roots = names.includes(path.basename(userData))
      ? names.map((name) => path.join(path.dirname(userData), name))
      : [userData];
    for (const root of roots) {
      const state = path.join(root, "farol-next-state");
      assertClosedConnectorProcesses(path.join(state, "secure-mcp-connector"));
      assertClosedConnectorProcesses(path.join(state, "go-core"));
    }
  };
  processesAbsent();
  const executable = await attest();
  const discovered = await discoverPreservedRecoveryChild(
    executable,
    candidate.profile,
    candidate.selectionInput,
    candidate.exact,
  );
  await candidate.recheck();
  await current();
  processesAbsent();
  // Discovery grants no preparation. The existing host repeats canonical
  // observation from zero digest selectors under all its original fences.
  const exact = { ...candidate.exact, current: discovered.Selection.Current };
  const selectionInput = {
    ...candidate.selectionInput,
    Selection: {
      ...candidate.selectionInput.Selection,
      Current: exact.current,
    },
  };
  return recoverStartupPreservedChat({
    userData,
    executable,
    profile: candidate.profile,
    exact,
    selectionInput,
    expectedRunSha256: candidate.expectedRunSha256,
    expectedConfigSha256: candidate.expectedConfigSha256,
    ...(candidate.expectedQuitSha256 === undefined
      ? {}
      : {
          expectedQuitSha256: candidate.expectedQuitSha256,
        }),
    startup: {
      lease,
      verify,
      assertCurrent,
      ...(candidate.legacyPreparation === undefined
        ? {}
        : { legacyPreparation: candidate.legacyPreparation }),
    },
    desktopState: () => activationObligations(userData),
    processesAbsent,
    attest: async () => {
      if ((await attest()) !== executable)
        throw Error("STARTUP_RECOVERY_EXECUTABLE_CHANGED");
    },
  });
}
