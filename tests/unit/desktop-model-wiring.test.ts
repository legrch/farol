import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The model route readers and the Codex host path helpers live in
// apps/desktop/runtime/model.ts and are tested there with injected ports.
// Nothing else checks which main-process state each port reads, that the
// wrappers main keeps still reach the one owner, or that every factory still
// receives them by their old names, so a swapped getter or a port left on a
// stale copy would pass every other test. This asserts the wiring as text; it
// executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{
  source: string;
  block: string;
  flat: string;
}> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("\nconst modelHost = createModelHost({");
  expect(begin).toBeGreaterThanOrEqual(0);
  const block = source
    .slice(begin, source.indexOf("\n});\n", begin) + 4)
    .replace(/\s+/g, " ");
  return { source, block, flat: source.replace(/\s+/g, " ") };
}

describe("model route host wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, block } = await read();
    for (const name of ["window", "configuration", "modelLifecycle"]) {
      expect(block).toContain(` ${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares each const owner, main helper and pure function by reference, assigning nothing back", async () => {
    const { source, block } = await read();
    for (const name of [
      "app",
      "dialog",
      "os",
      "statePaths",
      "buildIdentity",
      "buildEnvironment",
      "activeDesktopIdentity",
      "FAROL_MODEL_ENABLED",
      "FAROL_PROVIDER_ID",
      "ROUTE_B_MODEL",
      "desktopCodexConfigPath",
      "desktopCodexChildHomes",
      "detectCodexHostPresence",
    ]) {
      expect(block).toContain(` ${name},`);
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(block).toContain(" env: process.env,");
    expect(block).not.toMatch(/\(value\) =>/);
    expect(block).not.toMatch(/ set[A-Z]\w*:/);
  });

  it("keeps none of the moved bodies in main", async () => {
    const { source, flat } = await read();
    expect(source).not.toContain("codexHostHomePath");
    for (const fragment of [
      "SUPPORT_EXPORT_E2E_TARGET_INVALID",
      "Farol-Support-",
      "showSaveDialog",
      "FAROL_MODEL_E2E_CODEX_CONFIG_PATH",
      "resp_e2e",
      "msg_e2e",
      "S35-TA-2",
      "bearer-token",
      "detectCodexHostPresence({",
      "CODEX_HOST_RUNTIME_UNSAFE",
      "CODEX_HOST_HOME_UNSAFE",
      "CODEX_HOST_PROCESS_HOME_UNSAFE",
      "desktopCodexChildHomes(buildEnvironment",
    ])
      expect(flat).not.toContain(fragment);
    expect(source.match(/createModelHost\(/g)).toHaveLength(1);
  });

  it("keeps thin wrappers under the old names, each reaching the one owner", async () => {
    const { source } = await read();
    const wrapper = (header: string, call: string) => {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return modelHost.${call};\n}\n`,
      );
    };
    wrapper(
      "async function selectedSupportExportTarget(): Promise<string | null> {",
      "selectedSupportExportTarget()",
    );
    wrapper(
      "function farolModelCodexConfigPath(): string {",
      "farolModelCodexConfigPath()",
    );
    wrapper(
      'function syntheticModelTurnHandler(\n  text: string,\n): NonNullable<\n  ConstructorParameters<typeof FarolModelLifecycle>[0]["handler"]\n> {',
      "syntheticModelTurnHandler(text)",
    );
    wrapper(
      "async function farolModelProviderSpec(): Promise<FarolModelProviderSpec | null> {",
      "farolModelProviderSpec()",
    );
    wrapper(
      'async function farolModelCodexHostPresence(): Promise<\n  "running" | "not_running" | "unknown"\n> {',
      "farolModelCodexHostPresence()",
    );
    wrapper(
      "async function codexHostRuntimeRoot(): Promise<string> {",
      "codexHostRuntimeRoot()",
    );
    wrapper(
      "async function codexHostHomeOption(): Promise<\n  Readonly<{ codexHomePath?: string }>\n> {",
      "codexHostHomeOption()",
    );
    wrapper(
      "async function codexHostProcessHomePath(): Promise<string> {",
      "codexHostProcessHomePath()",
    );
  });

  it("leaves the Computer MCP lifecycle and its stop in main", async () => {
    const { source } = await read();
    expect(source).toContain(
      "function computerMcpLifecycle(): PrivateMcpLifecycle {",
    );
    expect(source).toContain("async function stopAndConfirmComputerMcp(");
    expect(source).toContain("new PrivateMcpLifecycle(");
  });

  it("still passes the wrappers to each factory by their old names", async () => {
    const { source, flat } = await read();
    // The two product-agent / connector-host ports, the configuration model and
    // support factories, and the model start.
    expect(
      source.match(
        /\n\s+codexHostRuntimeRoot,\n\s+codexHostProcessHomePath,\n\s+codexHostHomeOption,/g,
      ),
    ).toHaveLength(2);
    expect(flat).toContain(
      " farolModelProviderSpec, farolModelCodexConfigPath, farolModelCodexHostPresence, previewFarolModelConfigBlock,",
    );
    expect(flat).toContain(
      " configurationFailure, openExternal: (url) => shell.openExternal(url), selectedSupportExportTarget,",
    );
    expect(flat).toContain(" homePath: await codexHostProcessHomePath(),");
  });

  it("keeps the synthetic reply behind the E2E double gate in main", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      'const modelSyntheticReply = process.env.FAROL_E2E === "1" ? process.env.FAROL_MODEL_E2E_SYNTHETIC_REPLY : undefined;',
    );
    expect(flat).toContain(
      "syntheticReply: modelSyntheticReply, stateRoot: statePaths().modelEndpoint,",
    );
    expect(flat).toContain("syntheticTurn: syntheticModelTurnHandler,");
    expect(flat.match(/syntheticModelTurnHandler\(/g)).toHaveLength(2);
  });

  it("creates the owner at module level after the constants it copies and before main", async () => {
    const { source } = await read();
    const created = source.indexOf("\nconst modelHost = createModelHost({");
    for (const earlier of [
      "\nconst buildIdentity = ",
      // The boot identity provides buildEnvironment and activeDesktopIdentity.
      "\n} = selectBootIdentity({",
      "\nlet window: ",
      "\nlet configuration: ",
      "\nlet modelLifecycle: ",
    ]) {
      const at = source.indexOf(earlier);
      expect(at, earlier).toBeGreaterThanOrEqual(0);
      expect(created, earlier).toBeGreaterThan(at);
    }
    expect(created).toBeLessThan(source.indexOf("\nasync function main("));
  });
});
