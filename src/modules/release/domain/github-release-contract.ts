import type { ReleaseChannel } from "./github-version";

export const GITHUB_RELEASE_REPOSITORY = "legrch/farol";
// Historical manifests are local recovery evidence, never a second feed.
export const RETAINED_GITHUB_RELEASE_REPOSITORY = "legrch/farol-releases";
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_RELEASE_REPOSITORY}/releases?per_page=100`;
export const RELEASE_MANIFEST_ASSET = "farol-release.json";
export const MAX_RELEASES_JSON_BYTES = 1_048_576;
export const MAX_MANIFEST_BYTES = 16_384;
export const MAX_ARCHIVE_BYTES = 2_147_483_648;
export const FAROL_BUNDLE_ID = "local.farol.next.preview";

export type GithubReleaseErrorCode =
  | "invalid_installed_version"
  | "invalid_release_metadata"
  | "release_catalogue_incomplete"
  | "release_not_found"
  | "invalid_manifest"
  | "release_mismatch"
  | "wrong_provenance"
  | "missing_asset"
  | "oversize"
  | "network_failure"
  | "interrupted"
  | "checksum_mismatch"
  | "package_mismatch";

export type Outcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: GithubReleaseErrorCode }>;

export type ReleaseManifest = Readonly<{
  schema: "farol.github-release/1";
  repository: typeof GITHUB_RELEASE_REPOSITORY;
  channel: ReleaseChannel;
  product: "Farol Next Preview";
  bundleId: typeof FAROL_BUNDLE_ID;
  version: string;
  buildVersion: string;
  sourceCommit: string;
  sourceTreeDigest: string;
  buildId: string;
  artifactSha256: string;
  archiveSha256: string;
  archiveName: string;
  archiveSize: number;
  platform: "darwin";
  arch: "arm64";
  signing: "unsigned";
  notarized: false;
  sourceDirty: false;
}>;

export type RetainedReleaseManifest = Omit<ReleaseManifest, "repository"> &
  Readonly<{
    repository:
      | typeof GITHUB_RELEASE_REPOSITORY
      | typeof RETAINED_GITHUB_RELEASE_REPOSITORY;
  }>;

export type RetainedReleaseRecord = Readonly<{
  schema: "farol.ready-update/1";
  handle: string;
  manifest: unknown;
  operation: Readonly<{ target: RetainedReleaseTarget }> | null;
  preparation?: Readonly<{ target: RetainedReleaseTarget }> | undefined;
}>;
type RetainedReleaseTarget = Readonly<{
  digest: string;
  version: string;
  buildId: string;
}>;

export type InstalledReleaseIdentity = Readonly<{
  version: string;
  buildVersion: string;
}>;

export type ReleaseAsset = Readonly<{
  name: string;
  url: string;
  size: number;
}>;
export type UpdateCandidate = Readonly<{
  manifest: ReleaseManifest;
  manifestAsset: ReleaseAsset;
  archiveAsset: ReleaseAsset;
  tag: string;
  notes?: string;
}>;

export type FetchedJson = Readonly<{
  value: unknown;
  finalUrl: string;
  redirects: readonly string[];
}>;

export type DownloadedArchive = Readonly<{
  handle: string;
  size: number;
  sha256: string;
  finalUrl: string;
  redirects: readonly string[];
}>;

export type PackageIdentity = Readonly<{
  product: string;
  bundleId: string;
  version: string;
  buildVersion: string;
  updateChannel: string;
  buildId: string;
  sourceCommit: string;
  sourceTreeDigest: string;
  artifactSha256: string;
  signing: string;
  notarized: boolean;
}>;

export type VerifiedPackage = Readonly<{
  identity: PackageIdentity;
  stagedAppPath: string;
  stagingRoot: string;
}>;

export type VerifiedGithubUpdate = Readonly<{
  handle: string;
  manifest: RetainedReleaseManifest;
  identity: PackageIdentity;
  stagedAppPath: string;
  stagingRoot: string;
}>;

export type PortFailure = Readonly<{
  ok: false;
  kind: "network_failure" | "interrupted" | "oversize" | "package_mismatch";
}>;

export type GithubReleasePorts = Readonly<{
  // Implementations must enforce byte limits while streaming, not after buffering.
  fetchJson(
    url: string,
    maxBytes: number,
  ): Promise<Readonly<{ ok: true; value: FetchedJson }> | PortFailure>;
  download(
    url: string,
    maxBytes: number,
    onProgress?: (receivedBytes: number) => void,
  ): Promise<Readonly<{ ok: true; value: DownloadedArchive }> | PortFailure>;
  // Must rehash the staged bytes and verify the extracted package with the existing package verifier.
  verifyPackage(
    handle: string,
    manifest: RetainedReleaseManifest,
  ): Promise<Readonly<{ ok: true; value: VerifiedPackage }> | PortFailure>;
}>;
