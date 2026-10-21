import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
  desktopAppDataPath,
  desktopCodexChildHomes,
  desktopCodexConfigPath,
  desktopEnvironment,
  desktopIdentity,
  desktopUserDataPath,
  isolatedDevMcpProofAllowed,
} from "../../src/apps/desktop/desktop-environment";

// Source/contract witnesses only: no Electron, filesystem ownership, account,
// installed profile, provider, process or packaged launch is exercised here.
describe("owner Preview runtime isolation", () => {
  const appData = "/Users/example/Library/Application Support";
  const identity = desktopIdentity("owner-preview", appData);

  it("selects only the fixed Preview profile and ignores personal child homes", () => {
    expect(desktopEnvironment("owner-preview")).toBe("owner-preview");
    expect(identity.userData).toBe(path.join(appData, "Farol Preview"));
    expect(
      desktopCodexConfigPath("owner-preview", identity, "/Users/owner"),
    ).toBe(path.join(identity.codexHome, "config.toml"));
    expect(
      desktopCodexChildHomes(
        "owner-preview",
        identity,
        "/Users/owner",
        "/Users/owner/.codex",
      ),
    ).toEqual({
      codexHomePath: identity.codexHome,
      processHomePath: path.join(
        identity.userData,
        "farol-private",
        "process-home",
      ),
    });
    expect(
      desktopUserDataPath(identity, {
        enabled: true,
        override: "/Users/owner/other-profile",
      }),
    ).toBe(identity.userData);
  });

  it("cannot inherit Dev acceptance, review or synthetic connector proof", () => {
    for (const marker of ["1", "review:8dc34907-9b18-4cbd-9486-9cfde2d05c75"]) {
      expect(() =>
        desktopAppDataPath("owner-preview", "/missing/appData", {
          enabled: false,
          override: undefined,
          acceptanceProfile: marker,
        }),
      ).toThrow("DESKTOP_ACCEPTANCE_PROFILE_CONFLICT");
    }
    expect(isolatedDevMcpProofAllowed("owner-preview", "owner-preview")).toBe(
      false,
    );
    expect(isolatedDevMcpProofAllowed("dev", "owner-preview")).toBe(false);
    expect(() =>
      desktopAppDataPath("owner-preview", appData, {
        enabled: true,
        override:
          "/Users/owner/Library/Application Support/io.github.legrch.farol",
      }),
    ).toThrow("DESKTOP_E2E_APP_DATA_INVALID");
  });

  it.each(["dev", "owner-preview"] as const)(
    "%s returns before constructing or reading installed-update resources",
    async (buildEnvironment) => {
      const source = fs.readFileSync(
        new URL("../../src/apps/desktop/main.ts", import.meta.url),
        "utf8",
      );
      const begin = source.indexOf(
        "async function initializeInstalledUpdater(): Promise<void>",
      );
      const end = source.indexOf("let activeAuthorityChangeKind:", begin);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const createInstalledUpdateRuntime = vi.fn(() => {
        throw new Error("INSTALLED_RUNTIME_MUST_NOT_BE_CONSTRUCTED");
      });
      const publishInstalledUpdate = vi.fn(() => {
        throw new Error("INSTALLED_RESOURCES_MUST_NOT_BE_OBSERVED");
      });
      const result = runInNewContext(
        transformSync(
          `${source.slice(begin, end)}\ninitializeInstalledUpdater();`,
          { loader: "ts" },
        ).code,
        {
          buildEnvironment,
          createInstalledUpdateRuntime,
          publishInstalledUpdate,
        },
        { timeout: 1000 },
      );
      await expect(result).resolves.toBeUndefined();
      expect(createInstalledUpdateRuntime).not.toHaveBeenCalled();
      expect(publishInstalledUpdate).not.toHaveBeenCalled();
    },
  );
});
