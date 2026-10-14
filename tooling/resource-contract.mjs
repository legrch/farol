import { isDeepStrictEqual } from "node:util";
import { ELECTRON_RUNTIME } from "./runtime-contract.mjs";

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
    packageReceipt: "_output/package/artifact.json",
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
      // Schema-1 wire tag retained for previously installed package verifiers.
      // The active implementation uses the owned Node IPC runtime.
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
      ownedBy: `embedded Electron ${ELECTRON_RUNTIME.version}`,
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
  const ownerBeta = candidate?.product?.updateChannel === "github-owner-beta";
  const stable = candidate?.product?.updateChannel === "github-stable";
  const expected =
    ownerBeta || stable
      ? {
          ...EXPECTED_RESOURCE_MANIFEST,
          product: {
            ...EXPECTED_RESOURCE_MANIFEST.product,
            version: candidate.product.version,
            updateChannel: candidate.product.updateChannel,
          },
          integrations: {
            ...EXPECTED_RESOURCE_MANIFEST.integrations,
            updater: "farol-owned-github-releases",
          },
        }
      : EXPECTED_RESOURCE_MANIFEST;
  if (
    (ownerBeta &&
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-owner\.beta\.(0|[1-9][0-9]*)$/u.test(
        candidate.product.version,
      )) ||
    (stable &&
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
        candidate.product.version,
      )) ||
    !isDeepStrictEqual(candidate, expected)
  ) {
    throw new Error(code);
  }
}
