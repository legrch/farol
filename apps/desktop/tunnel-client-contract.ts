// Reviewed upstream v0.0.16, not a locally learned executable expectation.
// The app uses the full CLI: configure/init, doctor and run.
// Passive connection status requires its aggregate /health endpoint.
export const TUNNEL_CLIENT = Object.freeze({
  version: "0.0.16",
  entry: "tunnel-client",
  platform: "darwin",
  arch: "arm64",
  size: 21_099_522,
  sha256: "6f1e8d5494d6c4d6c45cd4f6e07b5291459c0b23f4b8cd8266c7a64be3d9a2a0",
  upstream: "https://github.com/openai/tunnel-client/releases/tag/v0.0.16",
  archiveURL:
    "https://persistent.oaistatic.com/tunnel-client/v0.0.16/tunnel-client-v0.0.16-darwin-arm64.zip",
  archiveSHA256:
    "a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62",
});

export const TUNNEL_CLIENT_NOTICES = Object.freeze([
  Object.freeze({
    source: "LICENSE",
    entry: "tunnel-client-LICENSE.txt",
    sha256: "f4c1d7ba32ef5bcf5cf03e2eefec5825ebafedf50fa330a36700a49c605c1ef4",
  }),
  Object.freeze({
    source: "NOTICE",
    entry: "tunnel-client-NOTICE.txt",
    sha256: "1364c020d86ecf948b78b7c655175032068203d13aece70fb0bfe112d7802dc2",
  }),
]);
export const TUNNEL_CLIENT_ENTRIES = Object.freeze(
  [
    TUNNEL_CLIENT.entry,
    ...TUNNEL_CLIENT_NOTICES.map((notice) => notice.entry),
  ].sort(),
);
