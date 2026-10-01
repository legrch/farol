import fs from "node:fs";
import path from "node:path";
import {
  DEV_DATA_DIRECTORY_NAME,
  LEGACY_DEV_DATA_DIRECTORY_NAME,
  type DevDataDirectoryName,
} from "./dev-profile-directory";

export const DEV_DISPLAY_NAME = "Farol Dev";

export type DesktopEnvironment = "preview" | "dev";

export type DesktopIdentity = Readonly<{
  environment: DesktopEnvironment;
  displayName: string;
  displayEdition: string;
  applicationId: string;
  applicationName: string;
  userData: string;
  sessionData: string;
  runtimePartition: string;
  chatGptPartition: "persist:farol-next-chatgpt" | "persist:farol-dev-chatgpt";
  runtimeIdentity: "farol-next-preview-runtime" | "farol-dev-runtime";
  runtimeServiceName: "Farol Next Runtime" | "Farol Dev Runtime";
  codexHome: string;
}>;

/**
 * Only the app-owned development launcher may opt into DEV. Packaged builds
 * and direct Electron starts remain Preview. An unexpected non-empty marker
 * fails closed instead of accidentally selecting either owner's state.
 */
export function desktopEnvironment(
  marker: string | undefined,
): DesktopEnvironment {
  if (marker === undefined || marker === "") return "preview";
  if (marker === "dev") return "dev";
  throw new Error("DESKTOP_ENVIRONMENT_INVALID");
}

// Build admission and profile identity are independent. Sharing NEW state
// does not make a development build an exact packaged candidate.
export function desktopProfileEnvironment(
  buildEnvironment: DesktopEnvironment,
  marker: string | undefined,
  acceptanceProfile: string | undefined,
): DesktopEnvironment {
  if (marker === undefined) return buildEnvironment;
  if (
    marker !== "shared-new" ||
    buildEnvironment !== "dev" ||
    acceptanceProfile !== undefined
  ) {
    throw new Error("DESKTOP_PROFILE_SELECTION_INVALID");
  }
  return "preview";
}

const E2E_ROOT_MARKER = ".farol-next-e2e-root";
const E2E_ROOT_NAME =
  /^(?:farol-next-e2e-home|farol-dev-onboarding-startup|onboarding-visual)-[A-Za-z0-9]{6,}$/u;
const E2E_APP_DATA_NAMES = new Set([
  "farol-e2e-app-data",
  "app-data",
  "legacy-app-data",
  "failed-app-data",
]);
const E2E_HOME_NAMES = new Set(["home", "failed-home"]);

function isolatedDevE2EAppData(
  override: string | undefined,
  testRoot: string | undefined,
  testHome: string | undefined,
  testProof: string | undefined,
): string {
  const invalid = () => new Error("DESKTOP_E2E_APP_DATA_INVALID");
  if (
    override === undefined ||
    testRoot === undefined ||
    testHome === undefined ||
    testProof === undefined ||
    ![override, testRoot, testHome].every(
      (value) => path.isAbsolute(value) && !value.includes("\0"),
    ) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(testProof) ||
    !E2E_ROOT_NAME.test(path.basename(testRoot)) ||
    path.dirname(override) !== testRoot ||
    !E2E_APP_DATA_NAMES.has(path.basename(override)) ||
    !(
      testHome === testRoot ||
      (path.dirname(testHome) === testRoot &&
        E2E_HOME_NAMES.has(path.basename(testHome)))
    )
  ) {
    throw invalid();
  }
  try {
    const parent = fs.realpathSync(path.dirname(testRoot));
    // Test homes are minted beneath the OS temporary directory, never beneath
    // an owner profile or a repository. TMPDIR itself may point at testRoot.
    if (
      parent !== "/tmp" &&
      parent !== "/private/tmp" &&
      !/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(parent)
    )
      throw invalid();
    const rootInfo = fs.lstatSync(testRoot);
    const homeInfo = fs.lstatSync(testHome);
    const appDataInfo = fs.lstatSync(override);
    for (const info of [rootInfo, homeInfo, appDataInfo]) {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0
      ) {
        throw invalid();
      }
    }
    const realRoot = fs.realpathSync(testRoot);
    if (realRoot !== path.join(parent, path.basename(testRoot)))
      throw invalid();
    const realHome = fs.realpathSync(testHome);
    if (
      realHome !==
      (testHome === testRoot
        ? realRoot
        : path.join(realRoot, path.basename(testHome)))
    ) {
      throw invalid();
    }
    if (
      fs.realpathSync(override) !== path.join(realRoot, path.basename(override))
    ) {
      throw invalid();
    }
    const marker = path.join(realRoot, E2E_ROOT_MARKER);
    const markerInfo = fs.lstatSync(marker);
    if (
      !markerInfo.isFile() ||
      markerInfo.isSymbolicLink() ||
      (markerInfo.mode & 0o077) !== 0 ||
      markerInfo.size > 64 ||
      fs.readFileSync(marker, "utf8") !== testProof
    ) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
  return override;
}

export function desktopAppDataPath(
  environment: DesktopEnvironment,
  nativeAppData: string,
  options: Readonly<{
    enabled: boolean;
    override: string | undefined;
    acceptanceProfile?: string | undefined;
    testRoot?: string | undefined;
    testHome?: string | undefined;
    testProof?: string | undefined;
  }>,
): string {
  if (
    options.acceptanceProfile !== undefined &&
    options.acceptanceProfile !== "1"
  ) {
    throw new Error("DESKTOP_ACCEPTANCE_PROFILE_INVALID");
  }
  if (options.acceptanceProfile === "1") {
    if (environment !== "dev" || options.enabled) {
      throw new Error("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
    }
    // A real, persistent first-run profile. No E2E seams and no mutation of
    // the ordinary DEV directory. The launcher owns the marker.
    return path.join(nativeAppData, "Farol Dev Acceptance");
  }
  if (environment !== "dev" || !options.enabled) return nativeAppData;
  // Validate before Electron selects userData/sessionData or opens a lock. A
  // missing override must never fall back to the ordinary owner's DEV profile.
  return isolatedDevE2EAppData(
    options.override,
    options.testRoot,
    options.testHome,
    options.testProof,
  );
}

export function desktopIdentity(
  environment: DesktopEnvironment,
  appData: string,
  devDataDirectoryName: DevDataDirectoryName = DEV_DATA_DIRECTORY_NAME,
): DesktopIdentity {
  if (!path.isAbsolute(appData) || appData.includes("\0")) {
    throw new Error("DESKTOP_APP_DATA_INVALID");
  }
  const dev = environment === "dev";
  if (
    dev &&
    devDataDirectoryName !== DEV_DATA_DIRECTORY_NAME &&
    devDataDirectoryName !== LEGACY_DEV_DATA_DIRECTORY_NAME
  ) {
    throw new Error("DEV_PROFILE_DIRECTORY_INVALID");
  }
  const userData = path.join(
    appData,
    dev ? devDataDirectoryName : "Farol Next Preview",
  );
  return {
    environment,
    displayName: dev ? DEV_DISPLAY_NAME : "Farol",
    displayEdition: dev ? "Development" : "Developer Preview",
    applicationId: dev ? "local.farol.dev" : "local.farol.next.preview",
    applicationName: dev ? DEV_DISPLAY_NAME : "Farol Next Preview",
    userData,
    sessionData: userData,
    runtimePartition: dev
      ? "persist:farol-dev-runtime"
      : "persist:farol-next-preview",
    chatGptPartition: dev
      ? "persist:farol-dev-chatgpt"
      : "persist:farol-next-chatgpt",
    runtimeIdentity: dev ? "farol-dev-runtime" : "farol-next-preview-runtime",
    runtimeServiceName: dev ? "Farol Dev Runtime" : "Farol Next Runtime",
    codexHome: path.join(userData, "farol-next-private", "codex-home"),
  };
}

export function codexChildHomePath(
  environment: DesktopEnvironment,
  privateCodexHome: string,
  configuredCodexHome: string | undefined,
): string | undefined {
  if (!path.isAbsolute(privateCodexHome) || privateCodexHome.includes("\0")) {
    throw new Error("DESKTOP_CODEX_HOME_INVALID");
  }
  if (environment === "dev") return privateCodexHome;
  return configuredCodexHome !== undefined &&
    path.isAbsolute(configuredCodexHome) &&
    !configuredCodexHome.includes("\0")
    ? configuredCodexHome
    : undefined;
}

// Model configuration follows build authority, independently of shared profile identity.
export function desktopCodexConfigPath(
  buildEnvironment: DesktopEnvironment,
  identity: DesktopIdentity,
  nativeHome: string,
): string {
  return path.join(
    buildEnvironment === "dev"
      ? identity.codexHome
      : path.join(nativeHome, ".codex"),
    "config.toml",
  );
}

export function desktopCodexChildHomes(
  buildEnvironment: DesktopEnvironment,
  identity: DesktopIdentity,
  nativeHome: string,
  configuredCodexHome: string | undefined,
): Readonly<{ codexHomePath: string | undefined; processHomePath: string }> {
  return {
    codexHomePath: codexChildHomePath(
      buildEnvironment,
      identity.codexHome,
      configuredCodexHome,
    ),
    processHomePath:
      buildEnvironment === "dev"
        ? path.join(identity.userData, "farol-next-private", "process-home")
        : nativeHome,
  };
}

export function isolatedDevMcpProofAllowed(
  buildEnvironment: DesktopEnvironment,
  profileEnvironment: DesktopEnvironment,
): boolean {
  return buildEnvironment === "dev" && profileEnvironment === "dev";
}
