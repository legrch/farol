import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexChildHomePath,
  desktopAppDataPath,
  desktopEnvironment,
  desktopIdentity,
  desktopProfileEnvironment,
} from "../../src/apps/desktop/desktop-environment";

const isolatedHomes: string[] = [];
function isolatedAppData() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "farol-next-e2e-home-"));
  const appData = path.join(home, "farol-e2e-app-data");
  fs.mkdirSync(appData, { mode: 0o700 });
  const proof = randomUUID();
  fs.writeFileSync(path.join(home, ".farol-next-e2e-root"), proof, {
    mode: 0o600,
  });
  isolatedHomes.push(home);
  return { home, appData, proof };
}
afterEach(() => {
  for (const home of isolatedHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("desktop environment identity", () => {
  const appData = "/Users/example/Library/Application Support";

  it("keeps explicitly isolated DEV identity separate from Preview and Legacy", () => {
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

  it("shares the complete NEW identity while retaining development build admission", () => {
    const buildEnvironment = desktopEnvironment("dev");
    const profile = desktopProfileEnvironment(
      buildEnvironment,
      "shared-new",
      undefined,
    );
    expect(buildEnvironment).toBe("dev");
    expect(profile).toBe("preview");
    expect(desktopIdentity(profile, appData)).toEqual(
      desktopIdentity("preview", appData),
    );
    expect(
      desktopAppDataPath(buildEnvironment, appData, {
        enabled: false,
        override: undefined,
      }),
    ).toBe(appData);
  });

  it("preserves explicit acceptance and ordinary packaged profile selection", () => {
    expect(desktopProfileEnvironment("dev", undefined, "1")).toBe("dev");
    expect(desktopProfileEnvironment("dev", undefined, undefined)).toBe("dev");
    expect(desktopProfileEnvironment("preview", undefined, undefined)).toBe(
      "preview",
    );
  });

  it("rejects an unsupported marker or conflicting shared selection before state access", () => {
    for (const marker of ["", "dev", "preview", "/profile", "Shared-New"]) {
      expect(() => desktopProfileEnvironment("dev", marker, undefined)).toThrow(
        "DESKTOP_PROFILE_SELECTION_INVALID",
      );
    }
    expect(() =>
      desktopProfileEnvironment("preview", "shared-new", undefined),
    ).toThrow("DESKTOP_PROFILE_SELECTION_INVALID");
    expect(() => desktopProfileEnvironment("dev", "shared-new", "1")).toThrow(
      "DESKTOP_PROFILE_SELECTION_INVALID",
    );
    expect(() =>
      desktopProfileEnvironment("dev", "shared-new", "unexpected"),
    ).toThrow("DESKTOP_PROFILE_SELECTION_INVALID");
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

  it("allows only the exact fresh DEV E2E app-data root", () => {
    const isolated = isolatedAppData();
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: true,
        override: isolated.appData,
        testHome: isolated.home,
        testRoot: isolated.home,
        testProof: isolated.proof,
      }),
    ).toBe(isolated.appData);
    expect(
      desktopAppDataPath("dev", appData, {
        enabled: false,
        override: isolated.appData,
      }),
    ).toBe(appData);
    expect(
      desktopAppDataPath("preview", appData, {
        enabled: true,
        override: isolated.appData,
      }),
    ).toBe(appData);
  });

  it("rejects missing, outside-root, and symlinked DEV E2E paths before startup", () => {
    const isolated = isolatedAppData();
    const outside = isolatedAppData();
    const options = {
      enabled: true,
      testHome: isolated.home,
      testRoot: isolated.home,
      testProof: isolated.proof,
    };
    for (const override of [undefined, "relative/e2e-state", outside.appData]) {
      expect(() =>
        desktopAppDataPath("dev", appData, { ...options, override }),
      ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
    }
    expect(() =>
      desktopAppDataPath("dev", appData, {
        ...options,
        override: isolated.appData,
        testProof: outside.proof,
      }),
    ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
    fs.rmSync(isolated.appData, { recursive: true });
    fs.symlinkSync(outside.appData, isolated.appData);
    expect(() =>
      desktopAppDataPath("dev", appData, {
        ...options,
        override: isolated.appData,
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
