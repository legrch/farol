import path from "node:path";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import type { probeCodexHost } from "../../../src/apps/desktop/codex-host-probe";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { probeTunnelClient } from "../../../src/apps/desktop/tunnel-client-probe";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { TUNNEL_CLIENT } from "../tunnel-client-contract";

// Which Codex and which tunnel-client binary Farol will trust and run: the
// guarded E2E overrides, the owner's file choice, and the verification that
// records a binary only after its probe passes. Main keeps every owner; each
// `let` there is a late getter here, so a value is read at the moment it is
// needed, never at the moment this is built. An E2E override counts only while
// FAROL_E2E is exactly "1", and only as an absolute path with no NUL byte. The
// tunnel client is the one bundled with the app unless an E2E fixture names
// another; any other path is refused before it is probed. Every refusal keeps
// its code, and the probes remain the sole authority on whether a binary runs.

export type ExecutableHostPorts = Readonly<{
  configuration: () => Pick<
    ProductConfigurationService,
    "recordCodexHost" | "recordCodexHostFailure" | "recordSecureMcpTunnelClient"
  > | null;
  secureMcpConnectorRuntime: () => Pick<
    SecureMcpConnectorRuntime,
    "isRunning"
  > | null;
  window: () => BrowserWindow | null;
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<Readonly<{ canceled: boolean; filePaths: string[] }>>;
  statePaths: () => Readonly<{ codexHostProbe: string }>;
  buildIdentity: Readonly<{ buildId: string }>;
  directory: string;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  probeCodexHost: typeof probeCodexHost;
  probeTunnelClient: typeof probeTunnelClient;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createExecutableHost(ports: ExecutableHostPorts) {
  const {
    configuration,
    secureMcpConnectorRuntime,
    window,
    showOpenDialog,
    statePaths,
    buildIdentity,
    directory,
    configurationFailure,
    probeCodexHost,
    probeTunnelClient,
    env,
  } = ports;

  function e2eCodexExecutable(): string | "invalid" | undefined {
    const testExecutable =
      env.FAROL_E2E === "1" ? env.FAROL_E2E_CODEX_EXECUTABLE : undefined;
    if (testExecutable === undefined) return undefined;
    return path.isAbsolute(testExecutable) && !testExecutable.includes("\0")
      ? testExecutable
      : "invalid";
  }

  async function selectedCodexExecutable(): Promise<
    string | "cancelled" | "invalid"
  > {
    const testExecutable = e2eCodexExecutable();
    if (testExecutable !== undefined) return testExecutable;
    const owner = window();
    if (!owner) return "invalid";
    const result = await showOpenDialog(owner, {
      title: "Choose the Codex executable",
      buttonLabel: "Verify Codex",
      properties: ["openFile"],
      securityScopedBookmarks: false,
    });
    if (result.canceled || result.filePaths.length !== 1) return "cancelled";
    const selected = result.filePaths[0];
    return selected && path.isAbsolute(selected) && !selected.includes("\0")
      ? selected
      : "invalid";
  }

  async function verifyCodexExecutable(
    executablePath: string,
    expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
  ): Promise<ProductConfigurationResult> {
    const settings = configuration();
    if (!settings) return configurationFailure("SETTINGS_UNAVAILABLE");
    try {
      const probe = await probeCodexHost({
        executablePath,
        scratchRoot: statePaths().codexHostProbe,
        ...(expectedDiscovery ? { expectedDiscovery } : {}),
      });
      const recorded = await settings.recordCodexHost({
        executablePath: probe.executablePath,
        executableSha256: probe.executableSha256,
        version: probe.version,
        protocol: probe.protocol,
        schemaSha256: probe.schemaSha256,
        taskSource: probe.taskSource,
        buildId: buildIdentity.buildId,
      });
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "host.codex-probe",
          version: probe.version,
          protocol: probe.protocol,
          executableSha256: probe.executableSha256,
          schemaSha256: probe.schemaSha256,
          capabilities: probe.capabilities,
        },
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CODEX_HOST_DISCOVERY_CANDIDATE_STALE") {
        return configurationFailure("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
      }
      const unsupported = code === "CODEX_HOST_INCOMPATIBLE";
      const recorded = await settings.recordCodexHostFailure(
        unsupported ? "unsupported" : "unreachable",
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      if (code === "CODEX_HOST_SELECTION_INVALID") {
        return configurationFailure("CODEX_HOST_SELECTION_INVALID");
      }
      if (code === "CODEX_HOST_EXECUTABLE_UNSAFE") {
        return configurationFailure("CODEX_HOST_EXECUTABLE_UNSAFE");
      }
      if (unsupported) return configurationFailure("CODEX_HOST_INCOMPATIBLE");
      return configurationFailure("CODEX_HOST_PROBE_FAILED");
    }
  }

  function e2eTunnelClientExecutable(): string | "invalid" | undefined {
    const testExecutable =
      env.FAROL_E2E === "1" ? env.FAROL_E2E_TUNNEL_CLIENT : undefined;
    if (testExecutable === undefined) return undefined;
    return path.isAbsolute(testExecutable) && !testExecutable.includes("\0")
      ? testExecutable
      : "invalid";
  }

  async function selectedTunnelClientExecutable(): Promise<
    string | "cancelled" | "invalid"
  > {
    const testExecutable = e2eTunnelClientExecutable();
    if (testExecutable !== undefined) return testExecutable;
    return path.join(directory, TUNNEL_CLIENT.entry);
  }

  async function verifyTunnelClientExecutable(
    executablePath: string,
    expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
  ): Promise<ProductConfigurationResult> {
    const settings = configuration();
    if (!settings) return configurationFailure("SETTINGS_UNAVAILABLE");
    try {
      const fixture = e2eTunnelClientExecutable();
      const bundledPath = path.join(directory, TUNNEL_CLIENT.entry);
      const fixtureSelected =
        fixture !== undefined &&
        fixture !== "invalid" &&
        fixture === executablePath;
      if (!fixtureSelected && executablePath !== bundledPath)
        return configurationFailure("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
      const expected = fixtureSelected
        ? expectedDiscovery
        : { canonicalPath: bundledPath, sha256: TUNNEL_CLIENT.sha256 };
      const probe = await probeTunnelClient({
        executablePath,
        ...(expected ? { expectedDiscovery: expected } : {}),
      });
      if (secureMcpConnectorRuntime()?.isRunning()) {
        return configurationFailure("CONNECTOR_STOP_REQUIRED");
      }
      const recorded = await settings.recordSecureMcpTunnelClient(probe);
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "connector.client-probe",
          version: probe.version,
          protocol: probe.protocol,
          executableSha256: probe.executableSha256,
        },
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE") {
        return configurationFailure("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
      }
      if (code === "TUNNEL_CLIENT_SELECTION_INVALID") {
        return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
      }
      if (code === "TUNNEL_CLIENT_EXECUTABLE_UNSAFE") {
        return configurationFailure("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
      }
      if (code === "TUNNEL_CLIENT_INCOMPATIBLE") {
        return configurationFailure("TUNNEL_CLIENT_INCOMPATIBLE");
      }
      return configurationFailure("TUNNEL_CLIENT_PROBE_FAILED");
    }
  }

  return {
    e2eCodexExecutable,
    selectedCodexExecutable,
    verifyCodexExecutable,
    e2eTunnelClientExecutable,
    selectedTunnelClientExecutable,
    verifyTunnelClientExecutable,
  };
}
