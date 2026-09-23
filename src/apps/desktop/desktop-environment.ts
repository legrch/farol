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

export function desktopAppDataPath(
  environment: DesktopEnvironment,
  nativeAppData: string,
  options: Readonly<{
    enabled: boolean;
    override: string | undefined;
    acceptanceProfile?: string | undefined;
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
  if (
    environment !== "dev" ||
    !options.enabled ||
    options.override === undefined
  ) {
    return nativeAppData;
  }
  if (!path.isAbsolute(options.override) || options.override.includes("\0")) {
    throw new Error("DESKTOP_E2E_APP_DATA_INVALID");
  }
  return options.override;
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
