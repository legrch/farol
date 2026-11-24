import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createConfigurationSupport } from "../../apps/desktop/configuration/support";
import { onboardingHelpUrl } from "../../src/apps/desktop/onboarding-help";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { scriptedSupportPorts } from "../support/support-configuration-ports";

// Run the production help handler with only its external boundary replaced.
// This is source routing evidence, not an Electron/package test.
function harness(destination, { rejectOpen = false } = {}) {
  const openExternal = vi.fn(async () => {
    if (rejectOpen) throw new Error("controlled external-open refusal");
  });
  const snapshotValue = { status: "error", error: "SETTINGS_READ_FAILED" };
  const snapshot = vi.fn(() => snapshotValue);
  const configurationFailure = vi.fn((code) => ({ ok: false, code }));
  const handler = createConfigurationSupport(
    scriptedSupportPorts({
      configuration: () => ({ snapshot }),
      configurationFailure,
      openExternal,
    }),
  );
  return {
    handle: () =>
      handler.configureAdmittedSupport({
        kind: "onboarding.open-help",
        destination,
      }),
    openExternal,
    snapshot,
    snapshotValue,
    configurationFailure,
  };
}

describe("onboarding help external routing", () => {
  it.each([
    [
      "setup-guide",
      "https://github.com/legrch/farol/blob/main/docs/setup-connection.md",
    ],
    ["tunnels", "https://platform.openai.com/settings/organization/tunnels"],
    ["api-keys", "https://platform.openai.com/settings/organization/api-keys"],
    ["chatgpt", "https://chatgpt.com/plugins"],
  ])(
    "opens the fixed HTTPS destination for %s once",
    async (destination, url) => {
      const h = harness(destination);
      expect(await h.handle()).toEqual({
        ok: true,
        snapshot: h.snapshotValue,
      });
      expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(h.snapshot).toHaveBeenCalledOnce();
      expect(h.configurationFailure).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid destination without opening anything", async () => {
    const h = harness("file:///arbitrary/document.html");
    expect(await h.handle()).toEqual({
      ok: false,
      code: "ONBOARDING_HELP_OPEN_FAILED",
    });
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.configurationFailure).toHaveBeenCalledExactlyOnceWith(
      "ONBOARDING_HELP_OPEN_FAILED",
    );
  });

  it("reports a refused external open without retrying", async () => {
    const h = harness("setup-guide", { rejectOpen: true });
    expect(await h.handle()).toEqual({
      ok: false,
      code: "ONBOARDING_HELP_OPEN_FAILED",
    });
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(
      onboardingHelpUrl("setup-guide"),
    );
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.configurationFailure).toHaveBeenCalledExactlyOnceWith(
      "ONBOARDING_HELP_OPEN_FAILED",
    );
  });
});

it("retains the renderer shell resources in the source packaging contract", () => {
  expect(BUILD_ENTRIES).toContain("shell.js");
  expect(BUILD_ENTRIES).toContain("shell.css");
  const build = fs.readFileSync("tooling/build.mjs", "utf8");
  expect(build).toContain('entryPoints: ["src/ui/renderer/entry.tsx"]');
  expect(build).toContain('outfile: "_output/build/app/shell.js"');
  expect(build).toContain('readBuildInput("src/ui/renderer/shell.html")');
  expect(build).toContain(
    'fs.writeFile("_output/build/app/shell.html", bytes)',
  );
  const html = fs.readFileSync("src/ui/renderer/shell.html", "utf8");
  expect(html).toContain('src="shell.js"');
  expect(html).toContain('href="shell.css"');
  const packager = fs.readFileSync("tooling/package.mjs", "utf8");
  expect(packager).toContain("for (const entry of entries)");
  expect(packager).toContain("path.join(appResources, entry)");
  expect(
    path.basename(
      fileURLToPath(new URL("../src/ui/renderer/shell.html", import.meta.url)),
    ),
  ).toBe("shell.html");
});
