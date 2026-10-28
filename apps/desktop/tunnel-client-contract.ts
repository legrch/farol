// Reviewed upstream v0.0.14, not a locally learned executable expectation.
// The app uses the full CLI: configure/init, doctor and run.
export const TUNNEL_CLIENT = Object.freeze({
  version: "0.0.14",
  entry: "tunnel-client",
  platform: "darwin",
  arch: "arm64",
  size: 20_405_442,
  sha256: "309fd85da5a8c2ca8dae920deea8ac10a4d7934ed18ac46e7df0c200139cc9c5",
  upstream: "https://github.com/openai/tunnel-client/releases/tag/v0.0.14",
  archiveURL:
    "https://persistent.oaistatic.com/tunnel-client/v0.0.14/tunnel-client-v0.0.14-darwin-arm64.zip",
  archiveSHA256:
    "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64",
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
