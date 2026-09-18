import { isDeepStrictEqual } from "node:util";

export const EXPECTED_RESOURCE_MANIFEST = Object.freeze({
  schema: "farol.next.resource-manifest/1",
  product: {
    name: "Farol Next Preview",
    version: "0.1.0-preview.0",
    bundleId: "local.farol.next.preview",
    updateChannel: "local-preview-only",
  },
  application: {
    singleInstanceScope: "userData",
    userData: "${appData}/Farol Next Preview",
    sessionData: "${appData}/Farol Next Preview",
    browserPartition: "persist:farol-next-preview",
    state: "contained-in-userData",
    cache: "contained-in-sessionData",
    logs: "absent",
    packageReceipt: "vnext/dist/package/artifact.json",
    promotionReceipt: "sibling-of-promoted-app",
  },
  runtime: {
    process: "Farol Next Runtime",
    owner: "Farol Next Preview main process",
    transport: "http-sse-loopback",
    port: "os-allocated-loopback",
    bearer: "per-launch-memory-only",
    socket: "absent",
    lease: "application-lifetime",
  },
  processes: [
    {
      name: "Farol Next Preview",
      kind: "electron-main",
      ownedBy: "local.farol.next.preview",
    },
    {
      name: "Farol Next Runtime",
      kind: "electron-utility-process",
      ownedBy: "Farol Next Preview",
    },
    {
      name: "OpenAI tunnel-client",
      kind: "owner-selected-native-connector",
      ownedBy: "Farol Next Preview when explicitly started",
    },
    {
      name: "Electron renderer/helper",
      kind: "pinned-vendor-runtime",
      ownedBy: "embedded Electron 44.4.2",
    },
  ],
  integrations: {
    tunnel: "owner-selected-openai-tunnel-client",
    mcpRegistration: "next-owned-profile-to-packaged-computer-mcp",
    providerRegistration: "owner-completed-chatgpt-connector-attachment",
    nativeComputer: "packaged-computer-mcp-via-app-owned-tunnel",
    nativeAgent: "absent",
    updater: "absent",
    loginItem: "absent",
  },
  exclusions: [
    "~/.farol",
    "local.farol.app",
    "persist:farol-chatgpt",
    "codex-chatgpt-web",
    "Legacy launchers, links, state, tunnel, provider route, and update channel",
  ],
});

export function assertResourceManifest(
  candidate,
  code = "PACKAGE_RESOURCE_MANIFEST_INVALID",
) {
  if (!isDeepStrictEqual(candidate, EXPECTED_RESOURCE_MANIFEST)) {
    throw new Error(code);
  }
}
