import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import type { createInstalledUpdateHost } from "../update/host";
import type {
  DesktopCoreSelection,
  DesktopGoCore,
  startDesktopGoCore,
} from "../go-core-host";
import {
  desktopCoreArtifactRoot,
  desktopDevShellImageMatches,
} from "../dev-core-layout";
import { observeOperation } from "../operations/observe";
import type { OperationsStore } from "../operations/store";
import type { CoreReporters } from "./report";

// Starting the one Go core: the observed Setup operation and the argument
// object the host launch receives. Main keeps the `desktopGoCore` owner, the
// startup boundary around this call and everything before and after it. Every
// `let` of main's startup is a late getter here; the compiled constants, the
// build identity and the update host are shared by reference. The chat browser
// callback is chat wiring and arrives as a port. Nothing here retries: a
// refused or unknown start is thrown to the boundary, never started again.

export type GoCoreStartPorts = Readonly<{
  startDesktopGoCore: typeof startDesktopGoCore;
  operationsStore: () => Pick<OperationsStore, "record">;
  compiledArtifact: DesktopCoreSelection["compiledArtifact"];
  compiledResources: DesktopCoreSelection["compiledResources"];
  compiledShell: DesktopCoreSelection["compiledShell"];
  runtimeEnvironment: "dev" | "preview" | "owner-preview";
  directory: string;
  executablePath: () => string;
  realpathSync: (path: string) => string;
  // Read inside the start, as main read its own flag there.
  freshStartup: () => boolean;
  previousHostAdmissionReady: boolean;
  computerMcpLifecycle: () => Readonly<{
    withInactiveForFreshStart: <T>(start: () => Promise<T>) => Promise<T>;
  }>;
  buildIdentity: BuildIdentity;
  installedUpdates: Pick<
    ReturnType<typeof createInstalledUpdateHost>,
    "resourcesOrigin"
  >;
  stateRoot: string;
  home: () => string;
  settings: DesktopCoreSelection["settings"];
  reportOwnedBackendLifecycle: CoreReporters["reportOwnedBackendLifecycle"];
  reportQualificationObservation: CoreReporters["reportQualificationObservation"];
  browser: DesktopCoreSelection["browser"];
}>;

function startObservedDesktopGoCore(
  ports: Pick<GoCoreStartPorts, "startDesktopGoCore" | "operationsStore">,
  selection: DesktopCoreSelection,
): Promise<DesktopGoCore> {
  return observeOperation(
    ports.operationsStore(),
    { source: "Setup", kind: "hub.start", target: {} },
    () => ports.startDesktopGoCore(selection),
  );
}

export function startGoCore(ports: GoCoreStartPorts): Promise<DesktopGoCore> {
  const fresh = ports.freshStartup();
  return startObservedDesktopGoCore(ports, {
    compiledArtifact: ports.compiledArtifact,
    compiledResources: ports.compiledResources,
    // Legacy preview entrypoints retain File tools, but never qualify Shell
    // against a different copy of the code actually executing this host.
    compiledShell:
      ports.runtimeEnvironment === "dev" &&
      !desktopDevShellImageMatches(
        ports.realpathSync(ports.directory),
        ports.realpathSync(ports.executablePath()),
      )
        ? undefined
        : ports.compiledShell,
    previousHostDrainConfirmed: fresh
      ? false
      : ports.previousHostAdmissionReady,
    ...(fresh
      ? {
          startupPurpose: "fresh" as const,
          withInactiveMcp: <T>(start: () => Promise<T>) =>
            ports.computerMcpLifecycle().withInactiveForFreshStart(start),
        }
      : {}),
    build: ports.buildIdentity,
    // The attested path must remain immutable through spawn and lifetime.
    // Shared installation paths are writable by other administrator accounts.
    artifactRoot: desktopCoreArtifactRoot(
      ports.installedUpdates.resourcesOrigin?.execution.directory ??
        ports.directory,
      ports.runtimeEnvironment,
    ),
    stateRoot: ports.stateRoot,
    home: ports.home(),
    settings: ports.settings,
    onLifecycleObservation: ports.reportOwnedBackendLifecycle,
    ...(ports.runtimeEnvironment === "dev" || process.env.FAROL_E2E === "1"
      ? {
          onQualificationObservation: ports.reportQualificationObservation,
        }
      : {}),
    browser: ports.browser,
  });
}
