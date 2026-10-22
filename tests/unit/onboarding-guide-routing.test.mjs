import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { onboardingHelpUrl } from "../../src/apps/desktop/onboarding-help";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";

// Execute the actual main-process help case with only its external boundary
// replaced. This is source routing evidence, not an Electron/package test.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(main, { sourceType: "module", plugins: ["typescript"] });
let helpCase;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.type === "StringLiteral" &&
    node.test.value === "onboarding.open-help"
  )
    helpCase = main.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach((child) => {
        if (child?.type) visit(child);
      });
    else if (value?.type) visit(value);
  }
}
visit(tree);
if (!helpCase) throw new Error("ONBOARDING_HELP_CASE_MISSING");
const compiled = `async function handle() { switch (command.kind) { ${helpCase} } } handle`;

function harness(destination, { rejectOpen = false } = {}) {
  const openExternal = vi.fn(async () => {
    if (rejectOpen) throw new Error("controlled external-open refusal");
  });
  const snapshot = vi.fn(() => ({ status: "controlled-source-test" }));
  const configurationFailure = vi.fn((code) => ({ ok: false, code }));
  const context = {
    command: { kind: "onboarding.open-help", destination },
    shell: { openExternal },
    onboardingHelpUrl,
    configuration: { snapshot },
    ProductConfigurationResultSchema: { parse: (value) => value },
    configurationFailure,
  };
  return {
    handle: vm.runInNewContext(stripTypeScriptTypes(compiled), context),
    context,
    openExternal,
    snapshot,
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
        snapshot: { status: "controlled-source-test" },
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
