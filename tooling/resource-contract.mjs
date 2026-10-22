import { isDeepStrictEqual } from "node:util";
import { ELECTRON_RUNTIME } from "./runtime-contract.mjs";

export const EXPECTED_RESOURCE_MANIFEST = Object.freeze({
  schema: "farol.resource-manifest/1",
  product: {
    name: "Farol",
    version: "0.1.0-preview.0",
    bundleId: "io.github.legrch.farol",
    updateChannel: "local-preview-only",
  },
  application: {
    singleInstanceScope: "userData",
    userData: "${appData}/io.github.legrch.farol",
    sessionData: "${appData}/io.github.legrch.farol",
    browserPartition: "persist:farol-runtime",
    state: "contained-in-userData",
    cache: "contained-in-sessionData",
    logs: "absent",
    packageReceipt: "_output/package/artifact.json",
    promotionReceipt: "sibling-of-promoted-app",
  },
  runtime: {
    process: "Farol Runtime",
    owner: "Farol main process",
    transport: "http-sse-loopback",
    port: "os-allocated-loopback",
    bearer: "per-launch-memory-only",
    socket: "absent",
    lease: "application-lifetime",
  },
  processes: [
    {
      name: "Farol",
      kind: "electron-main",
      ownedBy: "io.github.legrch.farol",
    },
    {
      name: "Farol Runtime",
      // Schema-1 wire tag retained for previously installed package verifiers.
      // The active implementation uses the owned Node IPC runtime.
      kind: "electron-utility-process",
      ownedBy: "Farol",
    },
    {
      name: "OpenAI tunnel-client",
      kind: "owner-selected-native-connector",
      ownedBy: "Farol when explicitly started",
    },
    {
      name: "Electron renderer/helper",
      kind: "pinned-vendor-runtime",
      ownedBy: `embedded Electron ${ELECTRON_RUNTIME.version}`,
    },
  ],
  integrations: {
    tunnel: "owner-selected-openai-tunnel-client",
    mcpRegistration: "farol-owned-profile-to-packaged-computer-mcp",
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
