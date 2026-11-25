import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createExecutableHost,
  type ExecutableHostPorts,
} from "../../apps/desktop/host/executable";
import { TUNNEL_CLIENT } from "../../apps/desktop/tunnel-client-contract";

// Executes the actual composition functions with controlled ports. This is
// selection/refusal evidence, not native execution or upstream qualification.
// The composition lives in apps/desktop/host/executable.ts; the wiring that
// reaches it from main is pinned in desktop-executable-wiring.test.ts.
function harness(fixture?: string, running = false) {
  const directory = "/qualified/app/resources";
  const probe = {
    executablePath: path.join(directory, TUNNEL_CLIENT.entry),
    executableSha256: TUNNEL_CLIENT.sha256,
    version: TUNNEL_CLIENT.version,
    protocol: "openai-tunnel-client/v1",
  };
  const probeTunnelClient = vi.fn(async (..._input: unknown[]) => probe);
  const recordSecureMcpTunnelClient = vi.fn(async () => ({
    ok: true,
    snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
  }));
  const ports = {
    directory,
    env:
      fixture === undefined
        ? {}
        : { FAROL_E2E: "1", FAROL_E2E_TUNNEL_CLIENT: fixture },
    configuration: () => ({ recordSecureMcpTunnelClient }),
    probeTunnelClient,
    secureMcpConnectorRuntime: () => ({ isRunning: () => running }),
    configurationFailure: (code: string) => ({ ok: false, code }),
  };
  const host = createExecutableHost(ports as unknown as ExecutableHostPorts);
  const select = host.selectedTunnelClientExecutable;
  const verify = host.verifyTunnelClientExecutable;
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
