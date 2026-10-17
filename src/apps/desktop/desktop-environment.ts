import fs from "node:fs";
import path from "node:path";
import {
  DEV_DATA_DIRECTORY_NAME,
  LEGACY_DEV_DATA_DIRECTORY_NAME,
  type DevDataDirectoryName,
} from "./dev-profile-directory.ts";

export const DEV_DISPLAY_NAME = "Farol Dev";

// Declaration only. Runtime admission requires the single-instance, renderer,
// setup and connector contracts to accept this distinct environment, plus
// verification of updater exclusion and independent child configuration.
// Until that coordinated change, desktopEnvironment rejects owner-preview.
export const OWNER_PREVIEW_IDENTITY = Object.freeze({
  environment: "owner-preview",
  displayName: "Farol Preview",
  displayEdition: "",
  applicationId: "local.farol.owner.preview",
  applicationName: "Farol Preview",
  dataDirectoryName: "Farol Preview",
  runtimePartition: "persist:farol-owner-preview-runtime",
  chatGptPartition: "persist:farol-owner-preview-chatgpt",
  runtimeIdentity: "farol-owner-preview-runtime",
  runtimeServiceName: "Farol Preview Runtime",
} as const);

/** Fixed prospective identity; this neither selects nor opens a profile. */
export function ownerPreviewIdentity(appData: string) {
  if (!path.isAbsolute(appData) || appData.includes("\0")) {
    throw new Error("DESKTOP_APP_DATA_INVALID");
  }
  const { dataDirectoryName, ...identity } = OWNER_PREVIEW_IDENTITY;
  const userData = path.join(appData, dataDirectoryName);
  return {
    ...identity,
    userData,
    sessionData: userData,
    codexHome: path.join(userData, "farol-next-private", "codex-home"),
  };
}

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

// Production and ordinary Dev own separate state. The retired shared marker
// fails before profile access; build admission remains independently enforced.
export function desktopProfileEnvironment(
  buildEnvironment: DesktopEnvironment,
  marker: string | undefined,
  _acceptanceProfile: string | undefined,
): DesktopEnvironment {
  if (marker !== undefined) {
    throw new Error("DESKTOP_PROFILE_SELECTION_INVALID");
  }
  return buildEnvironment;
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

function isolatedE2EAppData(
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

const REVIEW_NAMESPACE = "Farol Dev Review";
const REVIEW_RECEIPT = ".farol-dev-review-profile";
const REVIEW_OPENED = ".farol-dev-review-opened";
const REVIEW_MARKER =
  /^review:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function freshReviewAppData(nativeAppData: string, marker: string): string {
  const invalid = () => new Error("DESKTOP_REVIEW_PROFILE_INVALID");
  const token = REVIEW_MARKER.exec(marker)?.[1];
  if (
    token === undefined ||
    nativeAppData.includes("\0") ||
    !path.isAbsolute(nativeAppData) ||
    path.resolve(nativeAppData) !== nativeAppData
  )
    throw invalid();
  const namespace = path.join(nativeAppData, REVIEW_NAMESPACE);
  const root = path.join(namespace, token);
  try {
    const directories = [nativeAppData, namespace, root];
    const before = directories.map((directory, index) => {
      const info = fs.lstatSync(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0 ||
        (index > 0 && (info.mode & 0o777) !== 0o700) ||
        fs.realpathSync(directory) !== directory
      )
        throw invalid();
      return info;
    });
    // Only a freshly minted leaf is admitted, before any Electron state opens.
    // A prior/partial launch is retained and cannot be silently reopened.
    const names = fs.readdirSync(root);
    if (names.length !== 1 || names[0] !== REVIEW_RECEIPT) throw invalid();
    const receipt = path.join(root, REVIEW_RECEIPT);
    const fd = fs.openSync(
      receipt,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const info = fs.fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size !== token.length
      )
        throw invalid();
      const bytes = Buffer.alloc(token.length + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      const named = fs.lstatSync(receipt);
      if (
        count !== token.length ||
        bytes.subarray(0, count).toString("utf8") !== token ||
        after.size !== info.size ||
        after.mode !== info.mode ||
        after.uid !== info.uid ||
        after.nlink !== info.nlink ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs ||
        named.dev !== info.dev ||
        named.ino !== info.ino
      )
        throw invalid();
    } finally {
      fs.closeSync(fd);
    }
    directories.forEach((directory, index) => {
      const now = fs.lstatSync(directory);
      const prior = before[index];
      if (
        prior === undefined ||
        now.dev !== prior.dev ||
        now.ino !== prior.ino ||
        now.mode !== prior.mode ||
        now.uid !== prior.uid ||
        fs.realpathSync(directory) !== directory
      )
        throw invalid();
    });
    // Exclusive admission also fences two concurrent starts of the same identity.
    fs.writeFileSync(path.join(root, REVIEW_OPENED), token, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw invalid();
  }
  return root;
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
  if (options.acceptanceProfile?.startsWith("review:") === true) {
    if (
      environment !== "dev" ||
      options.enabled ||
      options.override !== undefined ||
      options.testRoot !== undefined ||
      options.testProof !== undefined
    ) {
      throw new Error("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
    }
    return freshReviewAppData(nativeAppData, options.acceptanceProfile);
  }
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
  if (!options.enabled) return nativeAppData;
  // Validate before Electron selects userData/sessionData or opens a lock. A
  // missing override must never fall back to either ordinary owner profile.
  return isolatedE2EAppData(
    options.override,
    options.testRoot,
    options.testHome,
    options.testProof,
  );
}

/** The app-data root has already passed desktopAppDataPath's E2E proof. */
export function desktopUserDataPath(
  identity: DesktopIdentity,
  options: Readonly<{ enabled: boolean; override: string | undefined }>,
): string {
  if (
    !options.enabled ||
    identity.environment === "dev" ||
    options.override === undefined ||
    options.override === ""
  ) {
    return identity.userData;
  }
  const override = options.override;
  const root = path.dirname(path.dirname(identity.userData));
  if (
    override !== identity.userData &&
    !["user-data", "Farol Next Preview user-data"].some(
      (name) => override === path.join(root, name),
    )
  ) {
    throw new Error("DESKTOP_E2E_USER_DATA_INVALID");
  }
  try {
    const info = fs.lstatSync(override);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      fs.realpathSync(override) !==
        path.join(fs.realpathSync(root), path.relative(root, override))
    ) {
      throw new Error("DESKTOP_E2E_USER_DATA_INVALID");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return override;
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
    displayEdition: dev ? "Development" : "",
    applicationId: dev ? "local.farol.dev" : "local.farol.next.preview",
    applicationName: dev ? DEV_DISPLAY_NAME : "Farol",
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

// Model configuration follows build authority and stays private in Dev.
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
