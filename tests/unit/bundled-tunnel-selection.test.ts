import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import { TUNNEL_CLIENT } from "../../apps/desktop/tunnel-client-contract";

// Executes the actual composition functions with controlled ports. This is
// selection/refusal evidence, not native execution or upstream qualification.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
function declaration(name: string) {
  const node = tree.program.body.find(
    (n) => n.type === "FunctionDeclaration" && n.id?.name === name,
  );
  if (!node || node.start === null || node.end === null)
    throw Error("TUNNEL_COMPOSITION_MISSING");
  return source.slice(node.start, node.end);
}
function harness(fixture?: string, running = false) {
  const directory = "/qualified/app/resources";
  const probe = {
    executablePath: path.join(directory, TUNNEL_CLIENT.entry),
    executableSha256: TUNNEL_CLIENT.sha256,
    version: TUNNEL_CLIENT.version,
    protocol: "openai-tunnel-client/v1",
  };
  const probeTunnelClient = vi.fn(async () => probe);
  const recordSecureMcpTunnelClient = vi.fn(async () => ({ ok: true }));
  const globals = {
    directory,
    path,
    TUNNEL_CLIENT,
    e2eTunnelClientExecutable: () => fixture,
    configuration: { recordSecureMcpTunnelClient },
    probeTunnelClient,
    secureMcpConnectorRuntime: { isRunning: () => running },
    configurationFailure: (code: string) => ({ ok: false, code }),
    ProductConfigurationResultSchema: { parse: (result: unknown) => result },
  };
  const select = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration("selectedTunnelClientExecutable"))}; selectedTunnelClientExecutable`,
    globals,
  ) as () => Promise<string>;
  const verify = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration("verifyTunnelClientExecutable"))}; verifyTunnelClientExecutable`,
    globals,
  ) as (
    selected: string,
    expected?: { canonicalPath: string; sha256: string },
  ) => Promise<unknown>;
  return {
    select,
    verify,
    probeTunnelClient,
    recordSecureMcpTunnelClient,
    directory,
  };
}
it("selects the app resource without a file picker or host discovery", async () => {
  const h = harness();
  expect(await h.select()).toBe(path.join(h.directory, TUNNEL_CLIENT.entry));
});
it("refuses an external selection before probing or recording it", async () => {
  const h = harness();
  expect(await h.verify("/opt/homebrew/bin/tunnel-client")).toEqual({
    ok: false,
    code: "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
  });
  expect(h.probeTunnelClient).not.toHaveBeenCalled();
  expect(h.recordSecureMcpTunnelClient).not.toHaveBeenCalled();
});
it("pins app-owned bytes independently of a supplied discovery expectation", async () => {
  const h = harness();
  const selected = path.join(h.directory, TUNNEL_CLIENT.entry);
  await h.verify(selected, {
    canonicalPath: "/arbitrary",
    sha256: "f".repeat(64),
  });
  expect(h.probeTunnelClient).toHaveBeenCalledWith({
    executablePath: selected,
    expectedDiscovery: {
      canonicalPath: selected,
      sha256: TUNNEL_CLIENT.sha256,
    },
  });
  expect(h.recordSecureMcpTunnelClient).toHaveBeenCalledTimes(1);
});
it("keeps the guarded exact E2E fixture selection without accepting another path", async () => {
  const fixture = "/test-owned/tunnel-client";
  const h = harness(fixture);
  expect(await h.select()).toBe(fixture);
  await h.verify(fixture);
  expect(h.probeTunnelClient).toHaveBeenCalledWith({ executablePath: fixture });
  h.probeTunnelClient.mockClear();
  await h.verify("/another/tunnel-client");
  expect(h.probeTunnelClient).not.toHaveBeenCalled();
});
it("does not replace an active connector's saved executable", async () => {
  const h = harness(undefined, true);
  const selected = path.join(h.directory, TUNNEL_CLIENT.entry);
  expect(await h.verify(selected)).toEqual({
    ok: false,
    code: "CONNECTOR_STOP_REQUIRED",
  });
  expect(h.recordSecureMcpTunnelClient).not.toHaveBeenCalled();
});
