import path from "node:path";

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
  runtimeServiceName: "Farol Next Runtime" | "Farol DEV Runtime";
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
  e2e: Readonly<{ enabled: boolean; override: string | undefined }>,
): string {
  if (environment !== "dev" || !e2e.enabled || e2e.override === undefined) {
    return nativeAppData;
  }
  if (!path.isAbsolute(e2e.override) || e2e.override.includes("\0")) {
    throw new Error("DESKTOP_E2E_APP_DATA_INVALID");
  }
  return e2e.override;
}

export function desktopIdentity(
  environment: DesktopEnvironment,
  appData: string,
): DesktopIdentity {
  if (!path.isAbsolute(appData) || appData.includes("\0")) {
    throw new Error("DESKTOP_APP_DATA_INVALID");
  }
  const dev = environment === "dev";
  const userData = path.join(appData, dev ? "Farol DEV" : "Farol Next Preview");
  return {
    environment,
    displayName: dev ? "Farol DEV" : "Farol",
    displayEdition: dev ? "Development" : "Developer Preview",
    applicationId: dev ? "local.farol.dev" : "local.farol.next.preview",
    applicationName: dev ? "Farol DEV" : "Farol Next Preview",
    userData,
    sessionData: userData,
    runtimePartition: dev
      ? "persist:farol-dev-runtime"
      : "persist:farol-next-preview",
    chatGptPartition: dev
      ? "persist:farol-dev-chatgpt"
      : "persist:farol-next-chatgpt",
    runtimeIdentity: dev ? "farol-dev-runtime" : "farol-next-preview-runtime",
    runtimeServiceName: dev ? "Farol DEV Runtime" : "Farol Next Runtime",
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
