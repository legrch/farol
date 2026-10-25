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
import { observeMaintenance, type MaintenanceObserver } from "./diagnostics";
import type { MaintenanceAttempt } from "./receipt";
import type { QualificationObserver } from "../bridge/qualification-metrics";

// One original startup attempt, before any read-only or normal runtime child.
// No renderer input, retry, settings writer, provider or new authority is added.
// The enclosing Electron owner retains the actual admission lease and singleton.
type StartupMaintenanceInput = Readonly<{
  userData: string;
  home: string;
  computerId: string;
  build: BuildIdentity;
  artifactRoot: string;
  compiledArtifact: unknown;
  compiledResources: unknown;
  startup: StartupPreservedRecoveryInput["startup"];
  attempt?: MaintenanceAttempt;
  onMaintenanceObservation?: MaintenanceObserver;
  onQualificationObservation?: QualificationObserver;
}>;
type MaintenanceResult = Awaited<
  ReturnType<typeof recoverStartupPreservedChat>
>;

export async function runStartupPreservedMaintenance(
  input: StartupMaintenanceInput,
): Promise<MaintenanceResult> {
  try {
    const result = await performStartupPreservedMaintenance(input);
    try {
      await input.attempt?.completed(result);
    } catch {
      /* Keep the original known result. */
    }
    return result;
  } catch (error) {
    try {
      await input.attempt?.failed(error);
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  }
}
async function performStartupPreservedMaintenance(
  input: StartupMaintenanceInput,
): Promise<MaintenanceResult> {
  const { userData, home, computerId, artifactRoot } = input;
  const observe = <T>(
    stage: Parameters<typeof observeMaintenance>[0],
    run: () => T | Promise<T>,
  ) =>
    observeMaintenance(
      stage,
      (value) => {
        input.attempt?.observe(value);
        input.onMaintenanceObservation?.(value);
      },
      run,
    );
  const build = structuredClone(input.build);
  const compiledResources = structuredClone(input.compiledResources);
  const expected = await observe("host-inputs", () =>
    desktopCoreExpectation({
      build,
      compiledArtifact: structuredClone(input.compiledArtifact),
    }),
  );
  const { lease, verify, assertCurrent } = input.startup;
  const current = async () => {
    await assertCurrent();
    if (!(await verify())) throw Error("STARTUP_PROMOTION_LEASE_LOST");
  };
  await observe("admission", current);
  const candidate = await observe("selection", () =>
    selectStartupPreservedRecovery({
      userData,
      home,
      computerId,
      buildId: build.buildId,
      assertCurrent: current,
    }),
  );
  await input.attempt?.selected({
    ...candidate.exact,
    failedRunSha256: candidate.expectedRunSha256,
    configSha256: candidate.expectedConfigSha256,
  });
  const attest = async () => {
    await observe("admission", current);
    const declaration = await observe("artifact", () =>
      readDesktopCoreDeclaration(artifactRoot, expected),
    );
    await observe("resources", () =>
      verifyCoreResources(
        artifactRoot,
        compiledResources,
        expected,
        performance.now() + CORE_QUALIFICATION_BUDGET_MS,
        input.onQualificationObservation,
      ),
    );
    return observe("executable", () =>
      verifyCoreExecutable(declaration, {
        artifactRoot,
        build: expected.build,
        binary: expected.binary,
        profileId: candidate.profile.profileId,
      }),
    );
  };
  const processesAbsent = () => {
    // Historical children may have been launched with either Dev spelling.
    // These are the existing fixed-root probes; no PID is signalled or guessed.
    const names = [DEV_DATA_DIRECTORY_NAME, LEGACY_DEV_DATA_DIRECTORY_NAME];
    const roots = names.includes(path.basename(userData))
      ? names.map((name) => path.join(path.dirname(userData), name))
      : [userData];
    for (const root of roots) {
      const state = path.join(root, "farol-state");
      assertClosedConnectorProcesses(path.join(state, "secure-mcp-connector"));
      assertClosedConnectorProcesses(path.join(state, "go-core"));
    }
  };
  await observe("processes", () => processesAbsent());
  const executable = await attest();
  const discovered = await observe("discovery", () =>
    discoverPreservedRecoveryChild(
      executable,
      candidate.profile,
      candidate.selectionInput,
      candidate.exact,
    ),
  );
  await observe("selection-recheck", () => candidate.recheck());
  await observe("admission", current);
  await observe("processes", () => processesAbsent());
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
  await input.attempt?.beforePreparation();
  return observe("preparation", () =>
    recoverStartupPreservedChat({
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
    }),
  );
}
