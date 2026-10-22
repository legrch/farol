import {
  FAROL_BUNDLE_ID,
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_REPOSITORY,
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_NEWER_FORMAT_SKIPS,
  MAX_RELEASES_JSON_BYTES,
  RELEASE_MANIFEST_ASSET,
  RETAINED_GITHUB_RELEASE_REPOSITORY,
  type GithubReleaseErrorCode,
  type GithubReleasePorts,
  type InstalledReleaseIdentity,
  type Outcome,
  type PackageIdentity,
  type ReleaseAsset,
  type ReleaseManifest,
  type RetainedReleaseManifest,
  type RetainedReleaseRecord,
  type UpdateCandidate,
  type VerifiedGithubUpdate,
} from "../domain/github-release-contract";
import {
  compareReleaseVersions,
  parseReleaseVersion,
  versionBelongsToChannel,
  type ReleaseChannel,
} from "../domain/github-version";

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const BUILD_VERSION = /^[1-9][0-9]*$/u;
const RELEASE_MANIFEST_SCHEMA = /^farol\.github-release\/([1-9][0-9]{0,3})$/u;

type RecordValue = Record<string, unknown>;
type Release = Readonly<{
  tag: string;
  version: string;
  assets: readonly ReleaseAsset[];
  notes?: string;
}>;

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const found = Object.keys(value);
  return (
    found.length === keys.length && found.every((key) => keys.includes(key))
  );
}

function failure<T>(code: GithubReleaseErrorCode): Outcome<T> {
  return { ok: false, code };
}

function assetUrl(tag: string, name: string): string {
  return `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function validAssetName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) &&
    !value.includes("..")
  );
}

function parseAsset(value: unknown, tag: string): ReleaseAsset | null {
  const data = object(value);
  if (
    !data ||
    !validAssetName(data.name) ||
    data.browser_download_url !== assetUrl(tag, data.name) ||
    !Number.isSafeInteger(data.size) ||
    (data.size as number) < 1 ||
    (data.size as number) > MAX_ARCHIVE_BYTES ||
    data.state !== "uploaded"
  )
    return null;
  return {
    name: data.name,
    url: data.browser_download_url,
    size: data.size as number,
  };
}

function parseRelease(value: unknown): Outcome<Release | null> {
  const data = object(value);
  if (
    !data ||
    typeof data.tag_name !== "string" ||
    !/^v[0-9][0-9A-Za-z.-]{0,128}$/u.test(data.tag_name) ||
    typeof data.draft !== "boolean" ||
    typeof data.prerelease !== "boolean" ||
    !Array.isArray(data.assets) ||
    data.assets.length > 32 ||
    data.html_url !==
      `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(data.tag_name)}`
  )
    return failure("invalid_release_metadata");
  const version = data.tag_name.slice(1);
  if (!parseReleaseVersion(version)) return failure("invalid_release_metadata");
  if (data.draft) return { ok: true, value: null };
  // A stable release must not advertise a prerelease version or vice versa.
  if (data.prerelease !== version.includes("-"))
    return failure("invalid_release_metadata");
  const assets: ReleaseAsset[] = [];
  for (const raw of data.assets) {
    const asset = parseAsset(raw, data.tag_name);
    if (!asset || assets.some((existing) => existing.name === asset.name))
      return failure("wrong_provenance");
    assets.push(asset);
  }
  // The public release body is untrusted presentation text, never HTML or an
  // installation authority. Ignore oversized bodies instead of truncating.
  const notes =
    typeof data.body === "string" && data.body.length <= 4096
      ? data.body.trim()
      : "";
  return {
    ok: true,
    value: {
      tag: data.tag_name,
      version,
      assets,
      ...(notes ? { notes } : {}),
    },
  };
}

function parseManifest(value: unknown): Outcome<RetainedReleaseManifest> {
  const data = object(value);
  const keys = [
    "schema",
    "repository",
    "channel",
    "product",
    "bundleId",
    "version",
    "buildVersion",
    "sourceCommit",
    "sourceTreeDigest",
    "buildId",
    "artifactSha256",
    "archiveSha256",
    "archiveName",
    "archiveSize",
    "platform",
    "arch",
    "signing",
    "notarized",
    "sourceDirty",
  ];
  if (
    !data ||
    !hasExactKeys(data, keys) ||
    data.schema !== "farol.github-release/1" ||
    (data.repository !== GITHUB_RELEASE_REPOSITORY &&
      data.repository !== RETAINED_GITHUB_RELEASE_REPOSITORY) ||
    !["stable", "owner-beta"].includes(data.channel as string) ||
    data.product !== "Farol" ||
    data.bundleId !== FAROL_BUNDLE_ID ||
    typeof data.version !== "string" ||
    !parseReleaseVersion(data.version) ||
    !versionBelongsToChannel(data.version, data.channel as ReleaseChannel) ||
    typeof data.buildVersion !== "string" ||
    !BUILD_VERSION.test(data.buildVersion) ||
    typeof data.sourceCommit !== "string" ||
    !SHA1.test(data.sourceCommit) ||
    typeof data.sourceTreeDigest !== "string" ||
    !SHA256.test(data.sourceTreeDigest) ||
    typeof data.buildId !== "string" ||
    !SHA256.test(data.buildId) ||
    typeof data.artifactSha256 !== "string" ||
    !SHA256.test(data.artifactSha256) ||
    typeof data.archiveSha256 !== "string" ||
    !SHA256.test(data.archiveSha256) ||
    !validAssetName(data.archiveName) ||
    data.archiveName !== `Farol-${data.version}-darwin-arm64.zip` ||
    !Number.isSafeInteger(data.archiveSize) ||
    (data.archiveSize as number) < 1 ||
    (data.archiveSize as number) > MAX_ARCHIVE_BYTES ||
    data.platform !== "darwin" ||
    data.arch !== "arm64" ||
    data.signing !== "unsigned" ||
    data.notarized !== false ||
    data.sourceDirty !== false
  )
    return failure("invalid_manifest");
  return { ok: true, value: data as RetainedReleaseManifest };
}

/**
 * True only for a manifest that names a release format newer than this client
 * parses: an object whose `schema` is exactly `farol.github-release/N`, N > 1.
 * Nothing else in such a manifest is read or trusted.
 */
function declaresNewerReleaseFormat(value: unknown): boolean {
  const data = object(value);
  if (!data || typeof data.schema !== "string") return false;
  const match = RELEASE_MANIFEST_SCHEMA.exec(data.schema);
  return match !== null && Number(match[1]) > 1;
}

/** Producer and live discovery validation: only the selected new release feed. */
export function parseGithubReleaseManifest(
  value: unknown,
): Outcome<ReleaseManifest> {
  if (declaresNewerReleaseFormat(value)) return failure("release_format_newer");
  const parsed = parseManifest(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.repository !== GITHUB_RELEASE_REPOSITORY)
    return failure("invalid_manifest");
  return { ok: true, value: parsed.value as ReleaseManifest };
}

/** Decode an existing local record; this does not authorize a network request. */
export function parseRetainedGithubReleaseManifest(
  record: RetainedReleaseRecord,
): Outcome<RetainedReleaseManifest> {
  if (
    record.schema !== "farol.ready-update/1" ||
    typeof record.handle !== "string" ||
    record.handle.length < 1 ||
    record.handle.length > 4096
  )
    return failure("invalid_manifest");
  const parsed = parseManifest(record.manifest);
  if (!parsed.ok) return parsed;
  for (const operation of [record.operation, record.preparation]) {
    if (operation === null || operation === undefined) continue;
    if (
      !operation.target ||
      operation.target.digest !== parsed.value.artifactSha256 ||
      operation.target.version !== parsed.value.version ||
      operation.target.buildId !== parsed.value.buildId
    )
      return failure("release_mismatch");
  }
  // Archive-only Ready records still require fresh local archive/package
  // verification before readiness, under the existing retained handle.
  return parsed;
}

function validResponseUrl(
  expected: string,
  finalUrl: string,
  redirects: readonly string[],
  allowAssetRedirect: boolean,
): boolean {
  if (!allowAssetRedirect)
    return redirects.length === 0 && finalUrl === expected;
  if (redirects.length === 0) return finalUrl === expected;
  if (
    redirects.length !== 2 ||
    redirects[0] !== expected ||
    redirects[1] !== finalUrl
  )
    return false;
  return (
    allowedUrl(finalUrl, true) &&
    new URL(finalUrl).hostname === "release-assets.githubusercontent.com"
  );
}

function allowedUrl(value: string, allowAssetRedirect: boolean): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return false;
    if (url.hostname === "github.com")
      return url.pathname.startsWith(
        `/${GITHUB_RELEASE_REPOSITORY}/releases/download/`,
      );
    return (
      allowAssetRedirect &&
      url.hostname === "release-assets.githubusercontent.com"
    );
  } catch {
    return false;
  }
}

/**
 * Fetch the fixed bounded release catalogue. Shared by discovery and adoption so
 * both apply identical size, provenance and completeness checks.
 */
async function fetchReleaseCatalogue(
  ports: Pick<GithubReleasePorts, "fetchJson">,
): Promise<Outcome<readonly unknown[]>> {
  let fetched;
  try {
    fetched = await ports.fetchJson(
      GITHUB_RELEASES_API,
      MAX_RELEASES_JSON_BYTES,
    );
  } catch {
    return failure("network_failure");
  }
  if (!fetched.ok) return failure(fetched.kind);
  if (
    !validResponseUrl(
      GITHUB_RELEASES_API,
      fetched.value.finalUrl,
      fetched.value.redirects,
      false,
    )
  )
    return failure("wrong_provenance");
  if (!Array.isArray(fetched.value.value) || fetched.value.value.length > 100)
    return failure("invalid_release_metadata");
  // A full page does not establish that the fixed bounded catalogue is complete.
  // Never report "up to date" or choose a partial maximum from truncated metadata.
  if (fetched.value.value.length === 100)
    return failure("release_catalogue_incomplete");
  return { ok: true, value: fetched.value.value as readonly unknown[] };
}

/** Fetch and strictly parse the exact manifest asset of one selected release. */
async function fetchReleaseManifest(
  chosen: Release,
  ports: Pick<GithubReleasePorts, "fetchJson">,
): Promise<Outcome<{ manifest: ReleaseManifest; asset: ReleaseAsset }>> {
  const manifestAsset = chosen.assets.find(
    (asset) => asset.name === RELEASE_MANIFEST_ASSET,
  );
  if (!manifestAsset || manifestAsset.size > MAX_MANIFEST_BYTES)
    return failure(manifestAsset ? "oversize" : "missing_asset");
  let manifestResponse;
  try {
    manifestResponse = await ports.fetchJson(
      manifestAsset.url,
      MAX_MANIFEST_BYTES,
    );
  } catch {
    return failure("network_failure");
  }
  if (!manifestResponse.ok) return failure(manifestResponse.kind);
  if (
    !validResponseUrl(
      manifestAsset.url,
      manifestResponse.value.finalUrl,
      manifestResponse.value.redirects,
      true,
    )
  )
    return failure("wrong_provenance");
  const manifest = parseGithubReleaseManifest(manifestResponse.value.value);
  if (!manifest.ok) return manifest;
  return {
    ok: true,
    value: { manifest: manifest.value, asset: manifestAsset },
  };
}

export async function discoverGithubUpdate(
  installed: InstalledReleaseIdentity,
  channel: ReleaseChannel,
  ports: Pick<GithubReleasePorts, "fetchJson">,
): Promise<Outcome<UpdateCandidate | null>> {
  if (
    !parseReleaseVersion(installed.version) ||
    !BUILD_VERSION.test(installed.buildVersion)
  )
    return failure("invalid_installed_version");
  const catalogue = await fetchReleaseCatalogue(ports);
  if (!catalogue.ok) return catalogue;
  const eligible: Release[] = [];
  for (const raw of catalogue.value) {
    const parsed = parseRelease(raw);
    if (!parsed.ok) return parsed;
    const release = parsed.value;
    if (!release || !versionBelongsToChannel(release.version, channel))
      continue;
    const comparison = compareReleaseVersions(
      release.version,
      installed.version,
    );
    if (comparison === null) return failure("invalid_release_metadata");
    if (comparison <= 0) continue;
    eligible.push(release);
  }
  // Strictly descending by version. Every version already parsed, so a null
  // comparison cannot occur; an equal pair is an ambiguous duplicate that must
  // abort instead of letting catalogue order pick a release.
  eligible.sort(
    (left, right) => compareReleaseVersions(right.version, left.version) ?? 0,
  );
  for (let index = 1; index < eligible.length; index += 1)
    if (
      compareReleaseVersions(
        eligible[index - 1]!.version,
        eligible[index]!.version,
      ) !== 1
    )
      return failure("invalid_release_metadata");
  // A release in a manifest format this client cannot read is skipped so an
  // older bridge release stays reachable. Any other failure fails closed, and
  // the walk is bounded.
  let skipped = 0;
  for (const chosen of eligible) {
    if (skipped >= MAX_NEWER_FORMAT_SKIPS)
      return failure("release_format_newer");
    const fetchedManifest = await fetchReleaseManifest(chosen, ports);
    if (!fetchedManifest.ok) {
      if (fetchedManifest.code !== "release_format_newer")
        return fetchedManifest;
      skipped += 1;
      continue;
    }
    const { manifest, asset: manifestAsset } = fetchedManifest.value;
    if (manifest.version !== chosen.version || manifest.channel !== channel)
      return failure("release_mismatch");
    if (BigInt(manifest.buildVersion) <= BigInt(installed.buildVersion))
      return failure("release_mismatch");
    const archiveAsset = chosen.assets.find(
      (asset) => asset.name === manifest.archiveName,
    );
    if (!archiveAsset) return failure("missing_asset");
    if (archiveAsset.size !== manifest.archiveSize)
      return failure("release_mismatch");
    return {
      ok: true,
      value: {
        manifest,
        manifestAsset,
        archiveAsset,
        tag: chosen.tag,
        ...(chosen.notes ? { notes: chosen.notes } : {}),
      },
    };
  }
  return skipped > 0
    ? failure("release_format_newer")
    : { ok: true, value: null };
}

/**
 * Find the published manifest of the exact installed release, for first-launch
 * adoption. It applies the same catalogue and manifest checks as discovery but
 * selects the one non-draft release whose version equals the installed one.
 * A match is a statement about what was published, not proof of the installed
 * bytes: the caller must still measure the installed tree against the manifest.
 */
export async function findGithubReleaseManifest(
  installed: InstalledReleaseIdentity,
  channel: ReleaseChannel,
  ports: Pick<GithubReleasePorts, "fetchJson">,
): Promise<Outcome<ReleaseManifest>> {
  if (
    !parseReleaseVersion(installed.version) ||
    !BUILD_VERSION.test(installed.buildVersion)
  )
    return failure("invalid_installed_version");
  const catalogue = await fetchReleaseCatalogue(ports);
  if (!catalogue.ok) return catalogue;
  let chosen: Release | null = null;
  for (const raw of catalogue.value) {
    const parsed = parseRelease(raw);
    if (!parsed.ok) return parsed;
    const release = parsed.value;
    if (!release || !versionBelongsToChannel(release.version, channel))
      continue;
    const comparison = compareReleaseVersions(
      release.version,
      installed.version,
    );
    if (comparison === null) return failure("invalid_release_metadata");
    if (comparison !== 0) continue;
    if (chosen) return failure("invalid_release_metadata");
    chosen = release;
  }
  if (!chosen) return failure("release_not_found");
  const fetchedManifest = await fetchReleaseManifest(chosen, ports);
  if (!fetchedManifest.ok) return fetchedManifest;
  const manifest = fetchedManifest.value.manifest;
  if (
    manifest.version !== installed.version ||
    manifest.version !== chosen.version ||
    manifest.channel !== channel ||
    manifest.buildVersion !== installed.buildVersion
  )
    return failure("release_mismatch");
  return { ok: true, value: manifest };
}

export function packageMatchesRelease(
  actual: PackageIdentity,
  expected: RetainedReleaseManifest,
): boolean {
  return (
    actual.product === expected.product &&
    actual.bundleId === expected.bundleId &&
    actual.version === expected.version &&
    actual.buildVersion === expected.buildVersion &&
    actual.updateChannel ===
      (expected.channel === "owner-beta"
        ? "github-owner-beta"
        : "github-stable") &&
    actual.buildId === expected.buildId &&
    actual.sourceCommit === expected.sourceCommit &&
    actual.sourceTreeDigest === expected.sourceTreeDigest &&
    actual.artifactSha256 === expected.artifactSha256 &&
    actual.signing === expected.signing &&
    actual.notarized === expected.notarized
  );
}

export async function downloadAndVerifyGithubUpdate(
  candidate: UpdateCandidate,
  ports: Pick<GithubReleasePorts, "download" | "verifyPackage">,
): Promise<Outcome<VerifiedGithubUpdate>> {
  const checked = parseGithubReleaseManifest(candidate.manifest);
  if (!checked.ok) return checked;
  if (
    candidate.tag !== `v${candidate.manifest.version}` ||
    candidate.manifestAsset.name !== RELEASE_MANIFEST_ASSET ||
    !Number.isSafeInteger(candidate.manifestAsset.size) ||
    candidate.manifestAsset.size < 1 ||
    candidate.manifestAsset.size > MAX_MANIFEST_BYTES ||
    candidate.manifestAsset.url !==
      assetUrl(candidate.tag, RELEASE_MANIFEST_ASSET) ||
    candidate.archiveAsset.name !== candidate.manifest.archiveName ||
    candidate.archiveAsset.size !== candidate.manifest.archiveSize ||
    candidate.archiveAsset.url !==
      assetUrl(candidate.tag, candidate.archiveAsset.name)
  )
    return failure("release_mismatch");
  let downloaded;
  try {
    downloaded = await ports.download(
      candidate.archiveAsset.url,
      candidate.manifest.archiveSize,
    );
  } catch {
    return failure("network_failure");
  }
  if (!downloaded.ok) return failure(downloaded.kind);
  const archive = downloaded.value;
  if (
    !validResponseUrl(
      candidate.archiveAsset.url,
      archive.finalUrl,
      archive.redirects,
      true,
    )
  )
    return failure("wrong_provenance");
  if (archive.size !== candidate.manifest.archiveSize)
    return failure("release_mismatch");
  if (archive.sha256 !== candidate.manifest.archiveSha256)
    return failure("checksum_mismatch");
  let verified;
  try {
    verified = await ports.verifyPackage(archive.handle, candidate.manifest);
  } catch {
    return failure("package_mismatch");
  }
  if (!verified.ok) return failure(verified.kind);
  if (!packageMatchesRelease(verified.value.identity, candidate.manifest))
    return failure("package_mismatch");
  return {
    ok: true,
    value: {
      handle: archive.handle,
      manifest: candidate.manifest,
      identity: verified.value.identity,
      stagedAppPath: verified.value.stagedAppPath,
      stagingRoot: verified.value.stagingRoot,
    },
  };
}
