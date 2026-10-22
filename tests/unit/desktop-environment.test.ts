import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexChildHomePath,
  ownerPreviewIdentity,
  assertOwnerPreviewProfileSeparation,
  prepareOwnerPreviewProfile,
  desktopCodexChildHomes,
  desktopCodexConfigPath,
  desktopAppDataPath,
  desktopUserDataPath,
  desktopEnvironment,
  desktopIdentity,
  desktopProfileEnvironment,
  isolatedDevMcpProofAllowed,
} from "../../src/apps/desktop/desktop-environment";

import { terminateDesktopStartup } from "../../src/apps/desktop/desktop-startup-failure";

const isolatedHomes: string[] = [];
function ordinaryBootProfile(
  environment?: string,
  appDataPath = "/Users/example/Library/Application Support",
  calls: string[] = [],
) {
  const source = fs.readFileSync(
    new URL("../../src/apps/desktop/main.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("const buildEnvironment =");
  const end = source.indexOf("// `buildIdentity.product`", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  // Model Electron's new productName default, then execute only the actual
  // profile-selection boot statements. No Electron or owner state is loaded.
  const paths: Record<string, string> = {
    appData: appDataPath,
    userData: "/Users/example/Library/Application Support/Farol",
    sessionData: "/Users/example/Library/Application Support/Farol",
  };
  const result = runInNewContext(
    transformSync(`${source.slice(begin, end)}\nactiveDesktopIdentity;`, {
      loader: "ts",
    }).code,
    {
      process: {
        env: environment ? { FAROL_ENVIRONMENT: environment } : {},
        stderr: {
          write: (message: string) => calls.push(`startup:${message}`),
        },
        exit: (code: number) => {
          throw new Error(`BOOT_EXIT:${code}`);
        },
      },
      path,
      desktopEnvironment,
      desktopProfileEnvironment,
      desktopAppDataPath,
      desktopUserDataPath,
      desktopIdentity,
      assertOwnerPreviewProfileSeparation,
      prepareOwnerPreviewProfile,
      terminateDesktopStartup,
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "farol-e2e-home-"));
  const appData = path.join(home, "farol-e2e-app-data");
  fs.mkdirSync(appData, { mode: 0o700 });
  const proof = randomUUID();
  fs.writeFileSync(path.join(home, ".farol-e2e-root"), proof, {
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

describe("physical Owner Preview profile admission", () => {
  function fixture() {
    const { home, appData } = isolatedAppData();
    // Tests use the physical spelling; production admission rejects aliases.
    const physicalHome = fs.realpathSync.native(home);
    return {
      home: physicalHome,
      appData: path.join(physicalHome, path.basename(appData)),
    };
  }

  it("admits a new fixed profile without creating it or changing app-data", () => {
    const { appData } = fixture();
    const before = fs.statSync(appData);
    expect(assertOwnerPreviewProfileSeparation(appData)).toBeUndefined();
    expect(fs.readdirSync(appData)).toEqual([]);
    const after = fs.statSync(appData);
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.mtimeMs,
      after.ctimeMs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.mtimeMs,
      before.ctimeMs,
    ]);
  });

  it("creates the missing fixed leaf with owner-only access before selecting storage", () => {
    const { appData } = fixture();
    const profile = ownerPreviewIdentity(appData).userData;
    expect(fs.existsSync(profile)).toBe(false);
    const { result } = ordinaryBootProfile("owner-preview", appData);
    expect(result.userData).toBe(profile);
    expect(fs.statSync(profile).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(profile)).toEqual([]);
  });

  it("admits the existing physically separate profile without repairing it", () => {
    const { appData } = fixture();
    const profile = ownerPreviewIdentity(appData).userData;
    fs.mkdirSync(profile, { mode: 0o700 });
    fs.writeFileSync(path.join(profile, "sentinel"), "preserve", {
      mode: 0o600,
    });
    const before = fs.statSync(profile);
    expect(ordinaryBootProfile("owner-preview", appData).result.userData).toBe(
      profile,
    );
    expect(fs.readdirSync(profile)).toEqual(["sentinel"]);
    const after = fs.statSync(profile);
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.mtimeMs,
      after.ctimeMs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.mtimeMs,
      before.ctimeMs,
    ]);
  });

  it("refuses a stopped installed-profile alias before selecting storage or writing locks", () => {
    const { appData } = fixture();
    const installed = path.join(appData, "io.github.legrch.farol");
    fs.mkdirSync(installed, { mode: 0o700 });
    const sentinel = path.join(installed, "sentinel");
    fs.writeFileSync(sentinel, "original owner state", { mode: 0o600 });
    const profile = ownerPreviewIdentity(appData).userData;
    fs.symlinkSync(installed, profile);
    const original = fs.statSync(installed);
    const originalSentinel = fs.statSync(sentinel);
    const alias = fs.lstatSync(profile);
    const calls: string[] = [];
    expect(() => ordinaryBootProfile("owner-preview", appData, calls)).toThrow(
      "BOOT_EXIT:1",
    );
    expect(
      calls.some((call) =>
        call.includes("OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.startsWith("set:"))).toBe(false);
    expect(fs.readdirSync(installed)).toEqual(["sentinel"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("original owner state");
    for (const [name, prior] of [
      [installed, original],
      [sentinel, originalSentinel],
      [profile, alias],
    ] as const) {
      const now = fs.lstatSync(name);
      expect([now.dev, now.ino, now.mode, now.mtimeMs, now.ctimeMs]).toEqual([
        prior.dev,
        prior.ino,
        prior.mode,
        prior.mtimeMs,
        prior.ctimeMs,
      ]);
    }
    expect(fs.readlinkSync(profile)).toBe(installed);
  });

  it.each([
    "farol-private",
    "farol-private/codex-home",
    "farol-private/process-home",
    "farol-private/secure-mcp-connector",
    "farol-private/model-endpoint",
    "farol-state",
    "Partitions",
    "Partitions/farol-owner-preview-runtime",
    "Partitions/farol-owner-preview-chatgpt",
  ])("refuses an aliased %s before any private-state consumer", (relative) => {
    const { appData } = fixture();
    const profile = ownerPreviewIdentity(appData).userData;
    fs.mkdirSync(profile, { mode: 0o700 });
    const installed = path.join(appData, "io.github.legrch.farol");
    fs.mkdirSync(installed, { mode: 0o700 });
    const sentinel = path.join(installed, "original-private-state");
    fs.writeFileSync(sentinel, "preserve fixture state", { mode: 0o600 });
    const alias = path.join(profile, relative);
    fs.mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 });
    fs.symlinkSync(installed, alias);
    const before = fs.statSync(installed);
    const original = fs.statSync(sentinel);
    const link = fs.lstatSync(alias);
    const calls: string[] = [];
    expect(() => ordinaryBootProfile("owner-preview", appData, calls)).toThrow(
      "BOOT_EXIT:1",
    );
    expect(calls.some((call) => call.startsWith("set:"))).toBe(false);
    expect(fs.readdirSync(installed)).toEqual(["original-private-state"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve fixture state");
    for (const [name, prior] of [
      [installed, before],
      [sentinel, original],
      [alias, link],
    ] as const) {
      const now = fs.lstatSync(name);
      expect([now.dev, now.ino, now.mode, now.mtimeMs, now.ctimeMs]).toEqual([
        prior.dev,
        prior.ino,
        prior.mode,
        prior.mtimeMs,
        prior.ctimeMs,
      ]);
    }
    expect(fs.readlinkSync(alias)).toBe(installed);
    expect(fs.existsSync(path.join(installed, "process-home"))).toBe(false);
  });

  it("rejects app-data aliases and writable ancestors without creating a profile", () => {
    const { home, appData } = fixture();
    const alias = path.join(home, "aliased-app-data");
    fs.symlinkSync(appData, alias);
    expect(() => assertOwnerPreviewProfileSeparation(alias)).toThrow(
      "OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE",
    );
    fs.chmodSync(home, 0o777);
    expect(() => assertOwnerPreviewProfileSeparation(appData)).toThrow(
      "OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE",
    );
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it.each([
    "file",
    "readable-profile",
    "writable-profile",
    "writable-app-data",
  ])("rejects %s without repair", (kind) => {
    const { appData } = fixture();
    const profile = ownerPreviewIdentity(appData).userData;
    if (kind === "file") fs.writeFileSync(profile, "preserve", { mode: 0o600 });
    else fs.mkdirSync(profile, { mode: 0o700 });
    const unsafe = kind === "writable-app-data" ? appData : profile;
    if (kind !== "file")
      fs.chmodSync(unsafe, kind === "readable-profile" ? 0o755 : 0o777);
    const before = fs.lstatSync(unsafe);
    expect(() => assertOwnerPreviewProfileSeparation(appData)).toThrow(
      "OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE",
    );
    const after = fs.lstatSync(unsafe);
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.mtimeMs,
      after.ctimeMs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.mtimeMs,
      before.ctimeMs,
    ]);
  });
});

describe("desktop environment identity", () => {
  const appData = "/Users/example/Library/Application Support";

  it("pins normal production boot to preserved NEW storage before its first read", () => {
    const { result, calls } = ordinaryBootProfile();
    expect(result.userData).toBe(path.join(appData, "io.github.legrch.farol"));
    expect(result.sessionData).toBe(result.userData);
    expect(result.codexHome).toBe(
      path.join(result.userData, "farol-private", "codex-home"),
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
        productName: "Farol",
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
      codexHome: path.join(appData, "Farol Dev", "farol-private", "codex-home"),
    });
    expect(dev.userData).not.toBe(preview.userData);
    expect(dev.sessionData).not.toBe(preview.sessionData);
    expect(dev.runtimePartition).not.toBe(preview.runtimePartition);
    expect(dev.chatGptPartition).not.toBe(preview.chatGptPartition);
    expect(dev.applicationId).not.toBe(preview.applicationId);
    expect(preview.applicationName).toBe("Farol");
    expect(preview.userData).toBe(path.join(appData, "io.github.legrch.farol"));
    expect(preview.applicationId).toBe("io.github.legrch.farol");
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
      path.join(identity.userData, "farol-private", "process-home"),
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
      applicationId: "io.github.legrch.farol",
      applicationName: "Farol",
      userData: path.join(appData, "io.github.legrch.farol"),
      sessionData: path.join(appData, "io.github.legrch.farol"),
      runtimePartition: "persist:farol-runtime",
      chatGptPartition: "persist:farol-app-chatgpt",
      runtimeIdentity: "farol-runtime",
      runtimeServiceName: "Farol Runtime",
    });
  });

  it("admits the fixed owner Preview identity independently of installed and Dev profiles", () => {
    const owner = ownerPreviewIdentity(appData);
    expect(owner.environment).toBe("owner-preview");
    expect(owner.applicationName).toBe("Farol Preview");
    expect(owner.applicationId).toBe("local.farol.owner.preview");
    expect(owner.userData).toBe(path.join(appData, "Farol Preview"));
    expect(owner.sessionData).toBe(owner.userData);
    for (const environment of ["preview", "dev"] as const) {
      const existing = desktopIdentity(environment, appData);
      for (const key of [
        "applicationId",
        "userData",
        "sessionData",
        "runtimePartition",
        "chatGptPartition",
        "runtimeIdentity",
        "runtimeServiceName",
        "codexHome",
      ] as const) {
        expect(owner[key]).not.toBe(existing[key]);
      }
    }
    expect(desktopEnvironment(owner.environment)).toBe("owner-preview");
    expect(desktopIdentity("owner-preview", appData)).toEqual(owner);
  });

  it("accepts only the launcher's explicit marker", () => {
    expect(desktopEnvironment(undefined)).toBe("preview");
    expect(desktopEnvironment("dev")).toBe("dev");
    expect(desktopEnvironment("owner-preview")).toBe("owner-preview");
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

  it.each([false, true])(
    "checks a Dev argv profile against independently selected storage (E2E=%s)",
    (enabled) => {
      const ordinary = desktopIdentity("dev", "/fixture/app-data");
      const review = desktopIdentity(
        "dev",
        "/fixture/app-data/Farol Dev Review/disposable",
      );
      for (const [selected, other] of [
        [ordinary, review],
        [review, ordinary],
      ] as const) {
        expect(
          desktopUserDataPath(selected, {
            enabled,
            override: selected.userData,
          }),
        ).toBe(selected.userData);
        expect(() =>
          desktopUserDataPath(selected, {
            enabled,
            override: other.userData,
          }),
        ).toThrow("DESKTOP_DEV_USER_DATA_MISMATCH");
      }
    },
  );

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
    expect(() => desktopUserDataPath(dev, { enabled: true, override })).toThrow(
      "DESKTOP_DEV_USER_DATA_MISMATCH",
    );
    for (const selected of [
      path.join(appData, "io.github.legrch.farol"),
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
