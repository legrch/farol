import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
