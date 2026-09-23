import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  codexChildHomePath,
  desktopAppDataPath,
  desktopEnvironment,
  desktopIdentity,
} from "../../src/apps/desktop/desktop-environment";

describe("desktop environment identity", () => {
  const appData = "/Users/example/Library/Application Support";

  it("gives task dev a persistent identity separate from packaged Preview and Legacy", () => {
    const dev = desktopIdentity("dev", appData);
    const preview = desktopIdentity("preview", appData);

    expect(dev).toEqual({
      environment: "dev",
      displayName: "Farol Dev",
      displayEdition: "Development",
      applicationId: "local.farol.dev",
      applicationName: "Farol Dev",
      userData: path.join(appData, "Farol Dev"),
      sessionData: path.join(appData, "Farol Dev"),
      runtimePartition: "persist:farol-dev-runtime",
      chatGptPartition: "persist:farol-dev-chatgpt",
      runtimeIdentity: "farol-dev-runtime",
      runtimeServiceName: "Farol Dev Runtime",
      codexHome: path.join(
        appData,
        "Farol Dev",
        "farol-next-private",
        "codex-home",
      ),
    });
    expect(dev.userData).not.toBe(preview.userData);
    expect(dev.sessionData).not.toBe(preview.sessionData);
    expect(dev.runtimePartition).not.toBe(preview.runtimePartition);
    expect(dev.chatGptPartition).not.toBe(preview.chatGptPartition);
    expect(dev.applicationId).not.toBe(preview.applicationId);
    expect(dev.userData).not.toContain(".farol");
    expect(dev.chatGptPartition).not.toBe("persist:farol-chatgpt");
    expect(dev.chatGptPartition).not.toBe("persist:codex-chatgpt-web");
  });

  it("keeps the existing packaged Preview identity unchanged", () => {
    expect(desktopIdentity("preview", appData)).toMatchObject({
      applicationId: "local.farol.next.preview",
      applicationName: "Farol Next Preview",
      userData: path.join(appData, "Farol Next Preview"),
      sessionData: path.join(appData, "Farol Next Preview"),
      runtimePartition: "persist:farol-next-preview",
      chatGptPartition: "persist:farol-next-chatgpt",
      runtimeIdentity: "farol-next-preview-runtime",
      runtimeServiceName: "Farol Next Runtime",
    });
  });

  it("accepts only the launcher's explicit marker", () => {
    expect(desktopEnvironment(undefined)).toBe("preview");
    expect(desktopEnvironment("dev")).toBe("dev");
    expect(() => desktopEnvironment("preview")).toThrow(
      "DESKTOP_ENVIRONMENT_INVALID",
    );
    expect(() => desktopEnvironment("DEV")).toThrow(
      "DESKTOP_ENVIRONMENT_INVALID",
    );
  });

  it("allows an isolated DEV app-data root only behind the explicit E2E gate", () => {
    const isolated = "/private/tmp/farol-dev-e2e-app-data";
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: true,
        override: isolated,
      }),
    ).toBe(isolated);
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: false,
        override: isolated,
      }),
    ).toBe(appData);
    expect(
      desktopAppDataPath("preview", appData, {
        enabled: true,
        override: isolated,
      }),
    ).toBe(appData);
    expect(() =>
      desktopAppDataPath("dev", appData, {
        enabled: true,
        override: "relative/e2e-state",
      }),
    ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
  });

  it("selects a stable real acceptance profile without changing the ordinary DEV path", () => {
    const acceptance = path.join(appData, "Farol Dev Acceptance");
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: false,
        override: undefined,
        acceptanceProfile: "1",
      }),
    ).toBe(acceptance);
    expect(desktopIdentity("dev", acceptance).userData).toBe(
      path.join(acceptance, "Farol Dev"),
    );
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: false,
        override: undefined,
      }),
    ).toBe(appData);
    expect(() =>
      desktopAppDataPath("dev", appData, {
        enabled: true,
        override: "/private/tmp/e2e",
        acceptanceProfile: "1",
      }),
    ).toThrow("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
    expect(() =>
      desktopAppDataPath("dev", appData, {
        enabled: false,
        override: undefined,
        acceptanceProfile: "unexpected",
      }),
    ).toThrow("DESKTOP_ACCEPTANCE_PROFILE_INVALID");
  });

  it("forces only DEV children into the app-owned Codex home", () => {
    const privateHome = "/private/farol-dev/codex-home";
    expect(codexChildHomePath("dev", privateHome, "/Users/owner/.codex")).toBe(
      privateHome,
    );
    expect(codexChildHomePath("preview", privateHome, undefined)).toBe(
      undefined,
    );
    expect(
      codexChildHomePath("preview", privateHome, "/tmp/preview-codex"),
    ).toBe("/tmp/preview-codex");
  });
});
