import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexChildHomePath,
  desktopCodexChildHomes,
  desktopCodexConfigPath,
  desktopAppDataPath,
  desktopUserDataPath,
  desktopEnvironment,
  desktopIdentity,
  desktopProfileEnvironment,
  isolatedDevMcpProofAllowed,
} from "../../src/apps/desktop/desktop-environment";

const isolatedHomes: string[] = [];
function ordinaryBootProfile() {
  const source = fs.readFileSync(
    new URL("../../src/apps/desktop/main.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("const buildEnvironment =");
  const end = source.indexOf("// `buildIdentity.product`", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const calls: string[] = [];
  // Model Electron's new productName default, then execute only the actual
  // profile-selection boot statements. No Electron or owner state is loaded.
  const paths: Record<string, string> = {
    appData: "/Users/example/Library/Application Support",
    userData: "/Users/example/Library/Application Support/Farol",
    sessionData: "/Users/example/Library/Application Support/Farol",
  };
  const result = runInNewContext(
    transformSync(`${source.slice(begin, end)}\nactiveDesktopIdentity;`, {
      loader: "ts",
    }).code,
    {
      process: { env: {} },
      path,
      desktopEnvironment,
      desktopProfileEnvironment,
      desktopAppDataPath,
      desktopUserDataPath,
      desktopIdentity,
      app: {
        commandLine: { getSwitchValue: () => "" },
        getPath(name: string) {
          calls.push(`get:${name}`);
          return paths[name];
        },
        setPath(name: string, value: string) {
          calls.push(`set:${name}`);
          paths[name] = value;
        },
      },
    },
    { timeout: 1000 },
  );
  return { result, calls };
}
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

  it("pins normal production boot to preserved NEW storage before its first read", () => {
    const { result, calls } = ordinaryBootProfile();
    expect(result.userData).toBe(path.join(appData, "Farol Next Preview"));
    expect(result.sessionData).toBe(result.userData);
    expect(result.codexHome).toBe(
      path.join(result.userData, "farol-next-private", "codex-home"),
    );
    for (const name of ["userData", "sessionData"]) {
      expect(calls.indexOf(`set:${name}`)).toBeGreaterThan(-1);
      expect(calls.indexOf(`set:${name}`)).toBeLessThan(
        calls.indexOf(`get:${name}`),
      );
    }
  });

  it.each(["preview", "dev"] as const)(
    "uses the %s visible name for macOS without changing storage identity",
    (buildEnvironment) => {
      const source = fs.readFileSync(
        new URL("../../src/apps/desktop/main.ts", import.meta.url),
        "utf8",
      );
      const assignment = /process\.title\s*=[^;]+;/u.exec(source)?.[0];
      expect(assignment).toBeDefined();
      const process = { title: "Electron" };
      runInNewContext(assignment!, {
        process,
        buildEnvironment,
        activeDesktopIdentity: desktopIdentity(buildEnvironment, appData),
        productName: "Farol Next Preview",
      });
      expect(process.title).toBe(
        buildEnvironment === "dev" ? "Farol Dev" : "Farol",
      );
    },
  );

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
    expect(preview.applicationName).toBe("Farol");
    expect(preview.userData).toBe(path.join(appData, "Farol Next Preview"));
    expect(preview.applicationId).toBe("local.farol.next.preview");
    expect(dev.userData).not.toContain(".farol");
    expect(dev.chatGptPartition).not.toBe("persist:farol-chatgpt");
    expect(dev.chatGptPartition).not.toBe("persist:codex-chatgpt-web");
  });

  it("keeps ordinary Dev identity independent while retaining development admission", () => {
    const buildEnvironment = desktopEnvironment("dev");
    const profile = desktopProfileEnvironment(
      buildEnvironment,
      undefined,
      undefined,
    );
    expect(buildEnvironment).toBe("dev");
    expect(profile).toBe("dev");
    expect(desktopIdentity(profile, appData)).not.toEqual(
      desktopIdentity("preview", appData),
    );
    expect(
      desktopAppDataPath(buildEnvironment, appData, {
        enabled: false,
        override: undefined,
      }),
    ).toBe(appData);
  });

  it("keeps both Codex child homes private in ordinary Dev", () => {
    const build = desktopEnvironment("dev");
    const profile = desktopProfileEnvironment(build, undefined, undefined);
    const identity = desktopIdentity(profile, appData);
    const selected = desktopCodexChildHomes(
      build,
      identity,
      "/Users/owner",
      "/Users/owner/.codex",
    );
    expect(selected.codexHomePath).toBe(identity.codexHome);
    expect(selected.processHomePath).toBe(
      path.join(identity.userData, "farol-next-private", "process-home"),
    );
    expect(selected.processHomePath).not.toBe("/Users/owner");
    expect(selected.codexHomePath).not.toBe("/Users/owner/.codex");
    expect(
      desktopCodexChildHomes("preview", identity, "/Users/owner", undefined),
    ).toEqual({ codexHomePath: undefined, processHomePath: "/Users/owner" });
  });

  it("keeps model configuration inside the ordinary Dev profile", () => {
    const build = desktopEnvironment("dev");
    const identity = desktopIdentity(
      desktopProfileEnvironment(build, undefined, undefined),
      appData,
    );
    const target = desktopCodexConfigPath(build, identity, "/Users/owner");
    expect(target).toBe(path.join(identity.codexHome, "config.toml"));
    expect(target).not.toBe("/Users/owner/.codex/config.toml");
  });

  it("retains isolated Dev and packaged Preview model configuration targets", () => {
    const dev = desktopIdentity("dev", appData);
    const preview = desktopIdentity("preview", appData);
    expect(desktopCodexConfigPath("dev", dev, "/Users/owner")).toBe(
      path.join(dev.codexHome, "config.toml"),
    );
    expect(desktopCodexConfigPath("preview", preview, "/Users/owner")).toBe(
      "/Users/owner/.codex/config.toml",
    );
  });

  it("keeps fixture proof mutations outside production state", () => {
    const build = desktopEnvironment("dev");
    const production = desktopProfileEnvironment(
      "preview",
      undefined,
      undefined,
    );
    const isolated = desktopProfileEnvironment(build, undefined, "1");
    expect(isolatedDevMcpProofAllowed(build, production)).toBe(false);
    expect(isolatedDevMcpProofAllowed(build, isolated)).toBe(true);
    expect(isolatedDevMcpProofAllowed("preview", "preview")).toBe(false);
    expect(isolatedDevMcpProofAllowed("preview", "dev")).toBe(false);
  });

  it("preserves explicit acceptance and ordinary packaged profile selection", () => {
    expect(desktopProfileEnvironment("dev", undefined, "1")).toBe("dev");
    expect(desktopProfileEnvironment("dev", undefined, undefined)).toBe("dev");
    expect(desktopProfileEnvironment("preview", undefined, undefined)).toBe(
      "preview",
    );
  });

  it("rejects an unsupported marker or conflicting shared selection before state access", () => {
    for (const marker of [
      "",
      "dev",
      "preview",
      "/profile",
      "Shared-New",
      "shared-new",
    ]) {
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

  it("keeps production state identity while using the Farol application name", () => {
    expect(desktopIdentity("preview", appData)).toMatchObject({
      applicationId: "local.farol.next.preview",
      applicationName: "Farol",
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

  it("allows only the exact fresh E2E app-data root for Dev and production", () => {
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
        testHome: isolated.home,
        testRoot: isolated.home,
        testProof: isolated.proof,
      }),
    ).toBe(isolated.appData);
  });

  it("retains the proven preview fixture override without allowing owner paths", () => {
    const isolated = isolatedAppData();
    const identity = desktopIdentity("preview", isolated.appData);
    const override = path.join(isolated.home, "user-data");
    expect(desktopUserDataPath(identity, { enabled: true, override })).toBe(
      override,
    );
    expect(desktopUserDataPath(identity, { enabled: true, override: "" })).toBe(
      identity.userData,
    );
    expect(desktopUserDataPath(identity, { enabled: false, override })).toBe(
      identity.userData,
    );
    const dev = desktopIdentity("dev", isolated.appData);
    expect(desktopUserDataPath(dev, { enabled: true, override })).toBe(
      dev.userData,
    );
    for (const selected of [
      path.join(appData, "Farol"),
      path.join(isolated.home, "other"),
      `${override}/..`,
    ]) {
      expect(() =>
        desktopUserDataPath(identity, { enabled: true, override: selected }),
      ).toThrow("DESKTOP_E2E_USER_DATA_INVALID");
    }
    const elsewhere = isolatedAppData();
    fs.symlinkSync(elsewhere.appData, override);
    expect(() =>
      desktopUserDataPath(identity, { enabled: true, override }),
    ).toThrow("DESKTOP_E2E_USER_DATA_INVALID");
  });

  it.each(["dev", "preview"] as const)(
    "rejects missing, outside-root, and symlinked %s E2E paths before startup",
    (environment) => {
      const isolated = isolatedAppData();
      const outside = isolatedAppData();
      const options = {
        enabled: true,
        testHome: isolated.home,
        testRoot: isolated.home,
        testProof: isolated.proof,
      };
      for (const override of [
        undefined,
        "relative/e2e-state",
        outside.appData,
      ]) {
        expect(() =>
          desktopAppDataPath(environment, appData, { ...options, override }),
        ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
      }
      expect(() =>
        desktopAppDataPath(environment, appData, {
          ...options,
          override: isolated.appData,
          testProof: outside.proof,
        }),
      ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
      fs.rmSync(isolated.appData, { recursive: true });
      fs.symlinkSync(outside.appData, isolated.appData);
      expect(() =>
        desktopAppDataPath(environment, appData, {
          ...options,
          override: isolated.appData,
        }),
      ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
    },
  );

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

describe("fresh review profile selection", () => {
  const marker = "review:8dc34907-9b18-4cbd-9486-9cfde2d05c75";
  it.each([
    { environment: "preview" as const, enabled: false, override: undefined },
    { environment: "dev" as const, enabled: true, override: undefined },
    {
      environment: "dev" as const,
      enabled: false,
      override: "/fixture/override",
    },
  ])(
    "rejects a conflicting environment before filesystem access: %j",
    (option) => {
      expect(() =>
        desktopAppDataPath(option.environment, "/missing/appData", {
          enabled: option.enabled,
          override: option.override,
          acceptanceProfile: marker,
        }),
      ).toThrow("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
    },
  );
  it("rejects an E2E proof on a fresh dev profile", () => {
    expect(() =>
      desktopAppDataPath("dev", "/missing/appData", {
        enabled: false,
        override: undefined,
        acceptanceProfile: marker,
        testProof: "inherited",
      }),
    ).toThrow("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
  });
  it.each([
    "review:../owner",
    "review:",
    "review:00000000-0000-0000-0000-000000000000",
  ])("refuses malformed fresh identities %s", (acceptanceProfile) => {
    expect(() =>
      desktopAppDataPath("dev", "/missing/appData", {
        enabled: false,
        override: undefined,
        acceptanceProfile,
      }),
    ).toThrow("DESKTOP_REVIEW_PROFILE_INVALID");
  });
});
