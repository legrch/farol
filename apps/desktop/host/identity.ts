import path from "node:path";
import {
  desktopAppDataPath,
  desktopEnvironment,
  desktopIdentity,
  desktopProfileEnvironment,
  desktopUserDataPath,
  prepareOwnerPreviewProfile,
} from "../../../src/apps/desktop/desktop-environment";
import { terminateDesktopStartup } from "../../../src/apps/desktop/desktop-startup-failure";
import { resolvePhysicalDevDataDirectoryName } from "../../../src/apps/desktop/dev-profile-directory";

// Boot identity: which Farol this process is (production, Owner Preview, Dev,
// E2E) and where its data lives. It runs once, at import time, before any
// profile read, instance lock or browser session, and it redirects Electron's
// `home`, `userData` and `sessionData` paths itself, in the same order main did
// inline. An invalid environment or profile ends startup through the existing
// failure writer; nothing here retries or repairs a profile.

export type BootIdentityApp = Readonly<{
  getPath: (name: "appData" | "userData" | "sessionData") => string;
  setPath: (name: "home" | "userData" | "sessionData", value: string) => void;
  commandLine: Readonly<{ getSwitchValue: (name: string) => string }>;
}>;

export type BootIdentityPorts = Readonly<{
  app: BootIdentityApp;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  stderr: Readonly<{ write: (message: string) => unknown }>;
  exit: (code: number) => never;
}>;

export function selectBootIdentity(ports: BootIdentityPorts) {
  const { app, env, argv, stderr, exit } = ports;
  const buildEnvironment = desktopEnvironment(env.FAROL_ENVIRONMENT);
  const runtimeEnvironment = (() => {
    try {
      return desktopProfileEnvironment(
        buildEnvironment,
        env.FAROL_PROFILE_MODE,
        env.FAROL_ACCEPTANCE_PROFILE,
      );
    } catch (error) {
      terminateDesktopStartup(error, buildEnvironment, {
        write: (message) => stderr.write(message),
        exit: (code) => exit(code),
      });
      throw error;
    }
  })();
  const isolatedE2EHome = env.FAROL_E2E === "1" ? env.HOME : undefined;
  const desktopAppData = (() => {
    try {
      return desktopAppDataPath(buildEnvironment, app.getPath("appData"), {
        enabled: env.FAROL_E2E === "1",
        override: env.FAROL_E2E_APP_DATA,
        acceptanceProfile: env.FAROL_ACCEPTANCE_PROFILE,
        testRoot: env.FAROL_E2E_TEST_ROOT,
        testHome: isolatedE2EHome,
        testProof: env.FAROL_E2E_TEST_PROOF,
      });
    } catch (error) {
      // An invalid E2E profile must fail before Electron selects any owner path
      // or shows an uncaught-exception dialog.
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => stderr.write(message),
        exit: (code) => exit(code),
      });
      throw error;
    }
  })();
  // On macOS Electron's native home may ignore the child's HOME environment.
  // The existing app-data proof has already validated this exact private HOME;
  // select it before Go/native child composition can observe the owner's home.
  if (isolatedE2EHome !== undefined) app.setPath("home", isolatedE2EHome);
  const declaredDesktopIdentity = (() => {
    try {
      if (runtimeEnvironment === "owner-preview")
        prepareOwnerPreviewProfile(desktopAppData);
      return desktopIdentity(
        runtimeEnvironment,
        desktopAppData,
        runtimeEnvironment === "dev"
          ? resolvePhysicalDevDataDirectoryName(desktopAppData)
          : undefined,
      );
    } catch (error) {
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => stderr.write(message),
        exit: (code) => exit(code),
      });
      throw error;
    }
  })();
  const selectedDesktopUserData = (() => {
    try {
      return desktopUserDataPath(declaredDesktopIdentity, {
        enabled: env.FAROL_E2E === "1",
        override: app.commandLine.getSwitchValue("user-data-dir"),
        devProfileArguments: argv,
      });
    } catch (error) {
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => stderr.write(message),
        exit: (code) => exit(code),
      });
      throw error;
    }
  })();
  // Visible product names must not select storage. Pin both paths before any
  // profile read, instance lock or browser session; E2E keeps its proven root.
  app.setPath("userData", selectedDesktopUserData);
  app.setPath("sessionData", selectedDesktopUserData);
  const activeDesktopIdentity = {
    ...declaredDesktopIdentity,
    // Storage selection does not change development build admission or edition.
    displayEdition:
      buildEnvironment === "dev"
        ? "Development"
        : declaredDesktopIdentity.displayEdition,
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    codexHome: path.join(
      app.getPath("userData"),
      "farol-private",
      "codex-home",
    ),
  } as const;
  // `buildIdentity.product` ("Farol") is the release identity —
  // it is validated against the packaged app name, the bundle ID, and the
  // build digest, and stays exactly that everywhere those checks read it.
  // Everywhere the app is only naming itself to the owner (the window title,
  // the macOS app menu, the About panel), it reads "Farol" with a
  // development edition only for Task Dev. Release identity remains unchanged.
  const displayProductName = activeDesktopIdentity.displayName;
  const displayEdition = activeDesktopIdentity.displayEdition;
  const displayWindowTitle = [displayProductName, displayEdition]
    .filter(Boolean)
    .join(" · ");
  return {
    buildEnvironment,
    runtimeEnvironment,
    isolatedE2EHome,
    activeDesktopIdentity,
    displayProductName,
    displayEdition,
    displayWindowTitle,
  } as const;
}
