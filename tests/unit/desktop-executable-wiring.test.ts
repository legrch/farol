import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The executable host lives in apps/desktop/host/executable.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads, that the wrappers main keeps still reach the one owner, or that
// every consumer still gets them by their old names, so a swapped getter or a
// port left on a stale copy would pass every other test. This asserts the
// wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function executableHost() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("executable host wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of [
      "configuration",
      "window",
      "secureMcpConnectorRuntime",
    ]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares the const owners and the function ports by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      " statePaths, buildIdentity, directory, configurationFailure, probeCodexHost, probeTunnelClient,",
    );
    expect(source).toMatch(/\nconst buildIdentity\b/);
    expect(source).toMatch(/\nconst directory\b/);
    expect(source).toMatch(/\nfunction statePaths\(/);
    expect(source).toMatch(/\nfunction configurationFailure\(/);
    expect(source).toContain(
      'import { probeCodexHost } from "./codex-host-probe";',
    );
  });

  it("reaches the dialog and the environment at the call, through main's own modules", async () => {
    const { body } = await read();
    expect(body).toContain(
      "showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),",
    );
    // The live environment object, so a seam set after start is still seen.
    expect(body).toContain("env: process.env,");
  });

  it("builds the host lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(executableHostCache ??= createExecutableHost({");
    expect(source).toContain("let executableHostCache");
  });

  it("keeps thin wrappers that delegate to the one host under the old names", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      'function e2eCodexExecutable(): string | "invalid" | undefined { return executableHost().e2eCodexExecutable(); }',
    );
    expect(flat).toContain(
      'function selectedCodexExecutable(): Promise<string | "cancelled" | "invalid"> { return executableHost().selectedCodexExecutable(); }',
    );
    expect(flat).toContain(
      "return executableHost().verifyCodexExecutable( executablePath, expectedDiscovery, ); }",
    );
    expect(flat).toContain(
      'function e2eTunnelClientExecutable(): string | "invalid" | undefined { return executableHost().e2eTunnelClientExecutable(); }',
    );
    expect(flat).toContain(
      "return executableHost().selectedTunnelClientExecutable(); }",
    );
    expect(flat).toContain(
      "return executableHost().verifyTunnelClientExecutable( executablePath, expectedDiscovery, ); }",
    );
  });

  it("no longer owns the E2E overrides, the picker or the probes' error mapping", async () => {
    const { source } = await read();
    for (const moved of [
      "FAROL_E2E_CODEX_EXECUTABLE",
      "FAROL_E2E_TUNNEL_CLIENT",
      "Choose the Codex executable",
      "Verify Codex",
      "CODEX_HOST_PROBE_FAILED",
      "CODEX_HOST_EXECUTABLE_UNSAFE",
      "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
      "TUNNEL_CLIENT_PROBE_FAILED",
      "recordCodexHostFailure",
      "recordSecureMcpTunnelClient",
      "TUNNEL_CLIENT.sha256",
    ])
      expect(source).not.toContain(moved);
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { flat } = await read();
    // The connector start takes the fixture check and the verification.
    expect(flat).toContain(
      " e2eTunnelClientExecutable, verifyTunnelClientExecutable, verifySelectedTunnelClient,",
    );
    // The tunnel-client step takes the selection, the fixture check and the
    // verification.
    expect(flat).toContain(
      " selectedTunnelClientExecutable, e2eTunnelClientExecutable,",
    );
    // The Codex step takes the selection, the fixture check and the verification.
    expect(flat).toContain(
      " selectedCodexExecutable, e2eCodexExecutable, verifyCodexExecutable,",
    );
  });
});
