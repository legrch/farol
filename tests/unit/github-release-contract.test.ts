import { describe, expect, it, vi } from "vitest";
import {
  downloadAndVerifyGithubUpdate,
  discoverGithubUpdate as discoverWithBuild,
  findGithubReleaseManifest,
  packageMatchesRelease,
  parseGithubReleaseManifest,
  parseRetainedGithubReleaseManifest,
} from "../../src/modules/release/app/github-release";
import {
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_REPOSITORY,
  RETAINED_GITHUB_RELEASE_REPOSITORY,
  type GithubReleasePorts,
  type ReleaseManifest,
  type RetainedReleaseManifest,
  type RetainedReleaseRecord,
} from "../../src/modules/release/domain/github-release-contract";
import { compareReleaseVersions } from "../../src/modules/release/domain/github-version";

// GitHub-shaped fixtures exercise source policy only; they do not prove live GitHub or installed updates.
const digest = (character: string) => character.repeat(64);
const sourceCommit = "a".repeat(40);
const version = "0.1.1";
const tag = `v${version}`;
const archiveName = `Farol-${version}-darwin-arm64.zip`;
const assetUrl = (name: string, releaseTag = tag) =>
  `https://github.com/legrch/farol/releases/download/${releaseTag}/${name}`;
const cdn = "https://release-assets.githubusercontent.com/asset?token=opaque";
const manifest: ReleaseManifest = {
  schema: "farol.github-release/1",
  repository: "legrch/farol",
  channel: "stable",
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  version,
  buildVersion: "2",
  sourceCommit,
  sourceTreeDigest: digest("b"),
  buildId: digest("c"),
  artifactSha256: digest("d"),
  archiveSha256: digest("e"),
  archiveName,
  archiveSize: 10,
  platform: "darwin",
  arch: "arm64",
  signing: "unsigned",
  notarized: false,
  sourceDirty: false,
};

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/legrch/farol/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "farol-release.json",
        browser_download_url: assetUrl("farol-release.json"),
        size: 900,
        state: "uploaded",
      },
      {
        name: archiveName,
        browser_download_url: assetUrl(archiveName),
        size: 10,
        state: "uploaded",
      },
    ],
    ...overrides,
  };
}

function ports(
  releases: unknown = [release()],
  document: unknown = manifest,
): GithubReleasePorts {
  return {
    fetchJson: vi.fn(async (url) => ({
      ok: true as const,
      value: {
        value: url === GITHUB_RELEASES_API ? releases : document,
        finalUrl: url,
        redirects: [],
      },
    })),
    download: vi.fn(async (url) => ({
      ok: true as const,
      value: {
        handle: "staged-opaque-handle",
        size: 10,
        sha256: digest("e"),
        finalUrl: cdn,
        redirects: [url, cdn],
      },
    })),
    verifyPackage: vi.fn(async () => ({
      ok: true as const,
      value: {
        identity: {
          product: "Farol Next Preview",
          bundleId: "local.farol.next.preview",
          version,
          buildVersion: "2",
          updateChannel: "github-stable",
          buildId: digest("c"),
          sourceCommit,
          sourceTreeDigest: digest("b"),
          artifactSha256: digest("d"),
          signing: "unsigned",
          notarized: false,
        },
        stagedAppPath: "/fixture/stage/Farol Next Preview.app",
        stagingRoot: "/fixture/stage",
      },
    })),
  };
}

function discoverGithubUpdate(
  installedVersion: string,
  channel: "stable" | "owner-beta",
  source: GithubReleasePorts,
  buildVersion = "1",
) {
  return discoverWithBuild(
    { version: installedVersion, buildVersion },
    channel,
    source,
  );
}

describe("new release and retained manifest boundaries", () => {
  const historical: RetainedReleaseManifest = {
    ...manifest,
    repository: RETAINED_GITHUB_RELEASE_REPOSITORY,
  };
  const target = {
    digest: manifest.artifactSha256,
    version: manifest.version,
    buildId: manifest.buildId,
  };
  const record: RetainedReleaseRecord = {
    schema: "farol.ready-update/1",
    handle: "exact-local-archive",
    manifest: historical,
    operation: { target },
  };

  it("pins the producer and live parser to the new repository", () => {
    expect(GITHUB_RELEASE_REPOSITORY).toBe("legrch/farol");
    expect(GITHUB_RELEASES_API).toBe(
      "https://api.github.com/repos/legrch/farol/releases?per_page=100",
    );
    expect(parseGithubReleaseManifest(manifest)).toEqual({
      ok: true,
      value: manifest,
    });
    expect(parseGithubReleaseManifest(historical)).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
  });

  it.each(["legrch/other", "other/farol", "other/farol-releases"])(
    "refuses arbitrary retained repositories (%s)",
    (repository) => {
      expect(
        parseRetainedGithubReleaseManifest({
          ...record,
          manifest: { ...historical, repository },
        }),
      ).toEqual({ ok: false, code: "invalid_manifest" });
    },
  );

  it.each([manifest, historical])(
    "decodes the exact retained operation without rewriting its repository ($repository)",
    (document) => {
      const snapshot = structuredClone(document);
      expect(
        parseRetainedGithubReleaseManifest({ ...record, manifest: document }),
      ).toEqual({ ok: true, value: snapshot });
      expect(document).toEqual(snapshot);
    },
  );

  it.each(["digest", "version", "buildId"] as const)(
    "refuses a retained manifest from a different operation %s",
    (field) => {
      expect(
        parseRetainedGithubReleaseManifest({
          ...record,
          operation: { target: { ...target, [field]: "mismatched" } },
        }),
      ).toEqual({ ok: false, code: "release_mismatch" });
    },
  );

  it("binds unfinished preparation and every supplied target to the same manifest", () => {
    expect(
      parseRetainedGithubReleaseManifest({
        ...record,
        operation: null,
        preparation: { target },
      }),
    ).toEqual({ ok: true, value: historical });
    expect(
      parseRetainedGithubReleaseManifest({
        ...record,
        preparation: { target: { ...target, digest: digest("f") } },
      }),
    ).toEqual({ ok: false, code: "release_mismatch" });
  });

  it("decodes an archive-only Ready record for local package reverification", async () => {
    const decoded = parseRetainedGithubReleaseManifest({
      ...record,
      operation: null,
    });
    if (!decoded.ok) throw new Error("missing retained manifest");
    const verified = await ports().verifyPackage(record.handle, decoded.value);
    if (!verified.ok) throw new Error("missing fixture package");
    expect(packageMatchesRelease(verified.value.identity, decoded.value)).toBe(
      true,
    );
    expect(
      packageMatchesRelease(
        { ...verified.value.identity, buildId: digest("f") },
        decoded.value,
      ),
    ).toBe(false);
  });

  it("requires the retained record schema and a bounded existing handle", () => {
    for (const handle of ["", "x".repeat(4097)])
      expect(parseRetainedGithubReleaseManifest({ ...record, handle })).toEqual(
        { ok: false, code: "invalid_manifest" },
      );
    expect(
      parseRetainedGithubReleaseManifest({
        ...record,
        schema: "other" as RetainedReleaseRecord["schema"],
      }),
    ).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it.each([
    { ...historical, sourceDirty: true },
    { ...historical, archiveName: "foreign.zip" },
    { ...historical, archiveSize: 2_147_483_649 },
    { ...historical, unexpected: true },
  ])("retains strict validation for historical manifests", (document) => {
    expect(
      parseRetainedGithubReleaseManifest({ ...record, manifest: document }),
    ).toEqual({ ok: false, code: "invalid_manifest" });
  });
});

describe("GitHub release version policy", () => {
  it("compares semantic versions, including numeric prerelease fields", () => {
    expect(compareReleaseVersions("0.2.0", "0.1.99")).toBe(1);
    expect(
      compareReleaseVersions("0.1.1-owner.beta.10", "0.1.1-owner.beta.2"),
    ).toBe(1);
    expect(compareReleaseVersions("0.1.1", "0.1.1-owner.beta.10")).toBe(1);
    expect(compareReleaseVersions("01.0.0", "1.0.0")).toBeNull();
  });
});

describe("GitHub update discovery", () => {
  it("carries bounded release notes as inert text and ignores oversized bodies", async () => {
    const notes = "Navigation is clearer.\n<script>not executable</script>";
    expect(
      await discoverGithubUpdate(
        "0.1.0",
        "stable",
        ports([release({ body: notes })]),
      ),
    ).toMatchObject({ ok: true, value: { notes } });
    const oversized = await discoverGithubUpdate(
      "0.1.0",
      "stable",
      ports([release({ body: "x".repeat(4097) })]),
    );
    expect(oversized).toMatchObject({ ok: true });
    if (oversized.ok) expect(oversized.value?.notes).toBeUndefined();
  });

  it("selects the exact newer release and manifest", async () => {
    const source = ports();
    const result = await discoverGithubUpdate("0.1.0", "stable", source);
    expect(result).toMatchObject({ ok: true, value: { tag, manifest } });
    expect(source.fetchJson).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/legrch/farol/releases?per_page=100",
      1_048_576,
    );
    expect(source.fetchJson).toHaveBeenNthCalledWith(
      2,
      assetUrl("farol-release.json"),
      16_384,
    );
  });

  it("returns no update for empty, same and lower versions", async () => {
    expect(await discoverGithubUpdate("0.1.0", "stable", ports([]))).toEqual({
      ok: true,
      value: null,
    });
    expect(await discoverGithubUpdate("0.1.1", "stable", ports())).toEqual({
      ok: true,
      value: null,
    });
    expect(await discoverGithubUpdate("0.2.0", "stable", ports())).toEqual({
      ok: true,
      value: null,
    });
  });

  it.each([false, true])(
    "does not claim a complete catalogue from a full GitHub page (eligible=%s)",
    async (eligible) => {
      const page = Array.from({ length: 100 }, () => release({ draft: true }));
      if (eligible) page[0] = release();
      const source = ports(page);
      expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
        ok: false,
        code: "release_catalogue_incomplete",
      });
      expect(source.fetchJson).toHaveBeenCalledTimes(1);
      expect(source.download).not.toHaveBeenCalled();
    },
  );

  it("rejects non-increasing build numbers and invalid installed identity", async () => {
    expect(await discoverGithubUpdate("0.1.0", "stable", ports(), "2")).toEqual(
      {
        ok: false,
        code: "release_mismatch",
      },
    );
    expect(await discoverGithubUpdate("0.1.0", "stable", ports(), "3")).toEqual(
      { ok: false, code: "release_mismatch" },
    );
    expect(await discoverGithubUpdate("0.1.0", "stable", ports(), "0")).toEqual(
      {
        ok: false,
        code: "invalid_installed_version",
      },
    );
  });

  it("excludes draft and prerelease from stable, and selects explicit owner beta", async () => {
    expect(
      await discoverGithubUpdate(
        "0.1.0",
        "stable",
        ports([release({ draft: true })]),
      ),
    ).toEqual({ ok: true, value: null });
    const betaVersion = "0.1.1-owner.beta.1";
    const betaTag = `v${betaVersion}`;
    const betaName = `Farol-${betaVersion}-darwin-arm64.zip`;
    const beta = release({
      tag_name: betaTag,
      html_url: `https://github.com/legrch/farol/releases/tag/${betaTag}`,
      prerelease: true,
      assets: [
        {
          name: "farol-release.json",
          browser_download_url: assetUrl("farol-release.json", betaTag),
          size: 900,
          state: "uploaded",
        },
        {
          name: betaName,
          browser_download_url: assetUrl(betaName, betaTag),
          size: 10,
          state: "uploaded",
        },
      ],
    });
    expect(
      await discoverGithubUpdate("0.1.0", "stable", ports([beta])),
    ).toEqual({ ok: true, value: null });
    expect(
      await discoverGithubUpdate(
        "0.1.0",
        "owner-beta",
        ports([beta], {
          ...manifest,
          channel: "owner-beta",
          version: betaVersion,
          archiveName: betaName,
        }),
      ),
    ).toMatchObject({ ok: true, value: { tag: betaTag } });
  });

  it.each([
    [
      "old release in the new catalogue",
      [
        release({
          html_url: `https://github.com/legrch/farol-releases/releases/tag/${tag}`,
        }),
      ],
      manifest,
      "invalid_release_metadata",
    ],
    [
      "old manifest under new asset paths",
      [release()],
      { ...manifest, repository: "legrch/farol-releases" },
      "invalid_manifest",
    ],
    [
      "missing manifest",
      [release({ assets: [release().assets[1]] })],
      manifest,
      "missing_asset",
    ],
    [
      "duplicate archive",
      [release({ assets: [...release().assets, release().assets[1]] })],
      manifest,
      "wrong_provenance",
    ],
    [
      "incomplete upload",
      [
        release({
          assets: release().assets.map((asset) => ({ ...asset, state: "new" })),
        }),
      ],
      manifest,
      "wrong_provenance",
    ],
    [
      "duplicate newer version",
      [release(), release()],
      manifest,
      "invalid_release_metadata",
    ],
    [
      "malformed release",
      [release({ tag_name: "latest" })],
      manifest,
      "invalid_release_metadata",
    ],
    [
      "wrong repository",
      [
        release({
          html_url: "https://github.com/other/repo/releases/tag/v0.1.1",
        }),
      ],
      manifest,
      "invalid_release_metadata",
    ],
    [
      "wrong asset",
      [
        release({
          assets: [
            {
              name: archiveName,
              browser_download_url: "https://evil.example/archive.zip",
              size: 10,
              state: "uploaded",
            },
          ],
        }),
      ],
      manifest,
      "wrong_provenance",
    ],
    [
      "missing archive",
      [release({ assets: [release().assets[0]] })],
      manifest,
      "missing_asset",
    ],
    [
      "wrong version",
      [release()],
      {
        ...manifest,
        version: "0.1.2",
        archiveName: "Farol-0.1.2-darwin-arm64.zip",
      },
      "release_mismatch",
    ],
    [
      "wrong platform",
      [release()],
      { ...manifest, arch: "x64" },
      "invalid_manifest",
    ],
    [
      "dirty source",
      [release()],
      { ...manifest, sourceDirty: true },
      "invalid_manifest",
    ],
    [
      "oversize archive",
      [release()],
      { ...manifest, archiveSize: 2_147_483_649 },
      "invalid_manifest",
    ],
  ])("rejects %s", async (_label, releases, document, code) => {
    expect(
      await discoverGithubUpdate("0.1.0", "stable", ports(releases, document)),
    ).toEqual({ ok: false, code });
  });

  it.each(["farol-release.json", archiveName])(
    "rejects old or foreign ownership of %s before fetching a manifest",
    async (name) => {
      for (const repository of [
        "legrch/farol-releases",
        "other/farol",
        "legrch/other",
      ]) {
        const source = ports([
          release({
            assets: release().assets.map((asset) =>
              asset.name === name
                ? {
                    ...asset,
                    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
                  }
                : asset,
            ),
          }),
        ]);
        expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
          ok: false,
          code: "wrong_provenance",
        });
        expect(source.fetchJson).toHaveBeenCalledTimes(1);
        expect(source.download).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects foreign API response, redirect and transport failure", async () => {
    const wrong = {
      ...ports(),
      fetchJson: vi.fn(async () => ({
        ok: true as const,
        value: {
          value: [release()],
          finalUrl: "https://evil.example/releases",
          redirects: [],
        },
      })),
    };
    expect(await discoverGithubUpdate("0.1.0", "stable", wrong)).toEqual({
      ok: false,
      code: "wrong_provenance",
    });
    const failed = {
      ...ports(),
      fetchJson: vi.fn(async () => ({
        ok: false as const,
        kind: "network_failure" as const,
      })),
    };
    expect(await discoverGithubUpdate("0.1.0", "stable", failed)).toEqual({
      ok: false,
      code: "network_failure",
    });
    expect(failed.fetchJson).toHaveBeenCalledExactlyOnceWith(
      GITHUB_RELEASES_API,
      1_048_576,
    );
  });

  it("rejects manifest asset redirects outside GitHub's release CDN", async () => {
    const source = ports();
    const redirected = {
      ...source,
      fetchJson: vi.fn(async (url: string) => ({
        ok: true as const,
        value: {
          value: url === GITHUB_RELEASES_API ? [release()] : manifest,
          finalUrl:
            url === GITHUB_RELEASES_API ? url : "https://evil.example/manifest",
          redirects:
            url === GITHUB_RELEASES_API
              ? []
              : [url, "https://evil.example/manifest"],
        },
      })),
    };
    expect(await discoverGithubUpdate("0.1.0", "stable", redirected)).toEqual({
      ok: false,
      code: "wrong_provenance",
    });
  });
});

describe("published manifest lookup for first-launch adoption", () => {
  const installed = { version, buildVersion: "2" };

  it("selects the single release of the exact installed version and its manifest", async () => {
    const source = ports([
      release({
        tag_name: "v0.1.0",
        html_url: "https://github.com/legrch/farol/releases/tag/v0.1.0",
        assets: [],
      }),
      release(),
    ]);
    expect(
      await findGithubReleaseManifest(installed, "stable", source),
    ).toEqual({ ok: true, value: manifest });
    expect(source.fetchJson).toHaveBeenNthCalledWith(
      1,
      GITHUB_RELEASES_API,
      1_048_576,
    );
    expect(source.fetchJson).toHaveBeenNthCalledWith(
      2,
      assetUrl("farol-release.json"),
      16_384,
    );
    expect(source.download).not.toHaveBeenCalled();
  });

  it("skips a draft and reports an unpublished version as not found", async () => {
    expect(
      await findGithubReleaseManifest(
        installed,
        "stable",
        ports([release({ draft: true }), release()]),
      ),
    ).toEqual({ ok: true, value: manifest });
    for (const releases of [[], [release({ draft: true })]]) {
      const source = ports(releases);
      expect(
        await findGithubReleaseManifest(installed, "stable", source),
      ).toEqual({
        ok: false,
        code: "release_not_found",
      });
      expect(source.fetchJson).toHaveBeenCalledTimes(1);
    }
    expect(
      await findGithubReleaseManifest(
        { version: "0.2.0", buildVersion: "2" },
        "stable",
        ports(),
      ),
    ).toEqual({ ok: false, code: "release_not_found" });
  });

  it("refuses a duplicate exact version as ambiguous", async () => {
    const source = ports([release(), release()]);
    expect(
      await findGithubReleaseManifest(installed, "stable", source),
    ).toEqual({
      ok: false,
      code: "invalid_release_metadata",
    });
    expect(source.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("does not select a release of another channel", async () => {
    const source = ports();
    expect(
      await findGithubReleaseManifest(installed, "owner-beta", source),
    ).toEqual({ ok: false, code: "release_not_found" });
    expect(source.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("rejects an installed build number that the published manifest does not carry", async () => {
    expect(
      await findGithubReleaseManifest(
        { version, buildVersion: "3" },
        "stable",
        ports(),
      ),
    ).toEqual({ ok: false, code: "release_mismatch" });
    expect(
      await findGithubReleaseManifest(
        { version, buildVersion: "0" },
        "stable",
        ports(),
      ),
    ).toEqual({ ok: false, code: "invalid_installed_version" });
  });

  it("rejects a manifest of another channel than the one asked for", async () => {
    const beta = "0.1.1-owner.beta.1";
    const betaTag = `v${beta}`;
    const betaArchive = `Farol-${beta}-darwin-arm64.zip`;
    const betaRelease = release({
      tag_name: betaTag,
      html_url: `https://github.com/legrch/farol/releases/tag/${betaTag}`,
      prerelease: true,
      assets: [
        {
          name: "farol-release.json",
          browser_download_url: assetUrl("farol-release.json", betaTag),
          size: 900,
          state: "uploaded",
        },
        {
          name: betaArchive,
          browser_download_url: assetUrl(betaArchive, betaTag),
          size: 10,
          state: "uploaded",
        },
      ],
    });
    const betaManifest = {
      ...manifest,
      channel: "owner-beta",
      version: beta,
      archiveName: betaArchive,
    };
    expect(
      await findGithubReleaseManifest(
        { version: beta, buildVersion: "2" },
        "owner-beta",
        ports([betaRelease], betaManifest),
      ),
    ).toEqual({ ok: true, value: betaManifest });
    expect(
      await findGithubReleaseManifest(
        { version: beta, buildVersion: "2" },
        "owner-beta",
        ports([betaRelease], { ...betaManifest, channel: "stable" }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("does not claim a complete catalogue from a full GitHub page", async () => {
    const page = Array.from({ length: 100 }, () => release({ draft: true }));
    page[0] = release();
    const source = ports(page);
    expect(
      await findGithubReleaseManifest(installed, "stable", source),
    ).toEqual({
      ok: false,
      code: "release_catalogue_incomplete",
    });
    expect(source.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign provenance for the catalogue and for the manifest", async () => {
    const wrongCatalogue = {
      ...ports(),
      fetchJson: vi.fn(async () => ({
        ok: true as const,
        value: {
          value: [release()],
          finalUrl: "https://evil.example/releases",
          redirects: [],
        },
      })),
    };
    expect(
      await findGithubReleaseManifest(installed, "stable", wrongCatalogue),
    ).toEqual({ ok: false, code: "wrong_provenance" });
    const wrongManifest = {
      ...ports(),
      fetchJson: vi.fn(async (url: string) => ({
        ok: true as const,
        value: {
          value: url === GITHUB_RELEASES_API ? [release()] : manifest,
          finalUrl:
            url === GITHUB_RELEASES_API ? url : "https://evil.example/manifest",
          redirects:
            url === GITHUB_RELEASES_API
              ? []
              : [url, "https://evil.example/manifest"],
        },
      })),
    };
    expect(
      await findGithubReleaseManifest(installed, "stable", wrongManifest),
    ).toEqual({ ok: false, code: "wrong_provenance" });
  });

  it("reports a transport failure without a result", async () => {
    const failed = {
      ...ports(),
      fetchJson: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    expect(
      await findGithubReleaseManifest(installed, "stable", failed),
    ).toEqual({
      ok: false,
      code: "network_failure",
    });
  });
});

describe("newer release manifest format", () => {
  const newer = { ...manifest, schema: "farol.github-release/2" };
  const versionOf = (index: number) => `0.1.${index}`;

  // A catalogue of releases keyed by version; `documents` maps a version to the
  // exact manifest document that release serves. The source records every
  // manifest URL it was asked for.
  function catalogue(documents: Readonly<Record<string, unknown>>) {
    const releases = Object.keys(documents).map((releaseVersion) => {
      const releaseTag = `v${releaseVersion}`;
      const name = `Farol-${releaseVersion}-darwin-arm64.zip`;
      return release({
        tag_name: releaseTag,
        html_url: `https://github.com/legrch/farol/releases/tag/${releaseTag}`,
        assets: [
          {
            name: "farol-release.json",
            browser_download_url: assetUrl("farol-release.json", releaseTag),
            size: 900,
            state: "uploaded",
          },
          {
            name,
            browser_download_url: assetUrl(name, releaseTag),
            size: 10,
            state: "uploaded",
          },
        ],
      });
    });
    const manifestUrls: string[] = [];
    const source: GithubReleasePorts = {
      ...ports(),
      fetchJson: vi.fn(async (url: string) => {
        if (url === GITHUB_RELEASES_API)
          return {
            ok: true as const,
            value: { value: releases, finalUrl: url, redirects: [] },
          };
        manifestUrls.push(url);
        const releaseVersion = /\/download\/v([^/]+)\//u.exec(url)![1]!;
        return {
          ok: true as const,
          value: {
            value: documents[releaseVersion],
            finalUrl: url,
            redirects: [],
          },
        };
      }),
    };
    return { source, manifestUrls };
  }
  const valid = (releaseVersion: string) => ({
    ...manifest,
    version: releaseVersion,
    archiveName: `Farol-${releaseVersion}-darwin-arm64.zip`,
  });
  const tagsOf = (urls: readonly string[]) =>
    urls.map((url) => /\/download\/(v[^/]+)\//u.exec(url)![1]);

  it.each([
    ["a /2 manifest", newer],
    ["a /2 manifest with extra keys", { ...newer, signature: "x", extra: [1] }],
    ["a /2 manifest with nothing else", { schema: "farol.github-release/2" }],
    ["a /1000 manifest", { schema: "farol.github-release/1000" }],
    ["a /9999 manifest", { schema: "farol.github-release/9999" }],
  ])("reports %s as a newer release format", (_name, document) => {
    expect(parseGithubReleaseManifest(document)).toEqual({
      ok: false,
      code: "release_format_newer",
    });
  });

  it.each([
    ["a leading zero", "farol.github-release/02"],
    ["version zero", "farol.github-release/0"],
    ["a leading space", " farol.github-release/2"],
    ["a trailing space", "farol.github-release/2 "],
    ["a trailing newline", "farol.github-release/2\n"],
    ["a five digit number", "farol.github-release/10000"],
    ["a non digit", "farol.github-release/2a"],
    ["no number", "farol.github-release/"],
    ["another product", "other.github-release/2"],
    ["another case", "Farol.github-release/2"],
    ["a negative number", "farol.github-release/-2"],
  ])("keeps a schema with %s an invalid manifest", (_name, schema) => {
    expect(parseGithubReleaseManifest({ ...manifest, schema })).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
  });

  it.each([2, null, undefined, ["farol.github-release/2"], {}])(
    "keeps a non-string schema %j an invalid manifest",
    (schema) => {
      expect(parseGithubReleaseManifest({ ...manifest, schema })).toEqual({
        ok: false,
        code: "invalid_manifest",
      });
    },
  );

  it("keeps a /1 field violation and a non-object an invalid manifest", () => {
    expect(
      parseGithubReleaseManifest({ ...manifest, signing: "developer-id" }),
    ).toEqual({ ok: false, code: "invalid_manifest" });
    expect(parseGithubReleaseManifest([newer])).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
    expect(parseGithubReleaseManifest("farol.github-release/2")).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
  });

  it("does not make the retained decoder accept or reclassify a newer format", () => {
    expect(
      parseRetainedGithubReleaseManifest({
        schema: "farol.ready-update/1",
        handle: "exact-local-archive",
        manifest: newer,
        operation: null,
      }),
    ).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it("reaches the lower bridge release when the newest one is a newer format", async () => {
    const { source, manifestUrls } = catalogue({
      "0.1.3": newer,
      "0.1.2": valid("0.1.2"),
      "0.1.1": valid("0.1.1"),
    });
    const result = await discoverGithubUpdate("0.1.0", "stable", source);
    expect(result).toMatchObject({
      ok: true,
      value: { tag: "v0.1.2", manifest: { version: "0.1.2" } },
    });
    expect(tagsOf(manifestUrls)).toEqual(["v0.1.3", "v0.1.2"]);
  });

  it("walks the catalogue in descending version order whatever its order", async () => {
    const { source, manifestUrls } = catalogue({
      "0.1.2": newer,
      "0.1.4": newer,
      "0.1.1": valid("0.1.1"),
      "0.1.3": newer,
    });
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toMatchObject(
      { ok: true, value: { tag: "v0.1.1" } },
    );
    expect(tagsOf(manifestUrls)).toEqual([
      "v0.1.4",
      "v0.1.3",
      "v0.1.2",
      "v0.1.1",
    ]);
  });

  it("reports a newer format when every eligible release is one", async () => {
    const { source, manifestUrls } = catalogue({
      "0.1.2": newer,
      "0.1.1": newer,
    });
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
      ok: false,
      code: "release_format_newer",
    });
    expect(manifestUrls).toHaveLength(2);
    expect(source.download).not.toHaveBeenCalled();
  });

  it("returns a malformed /1 manifest instead of skipping past it", async () => {
    const { source, manifestUrls } = catalogue({
      "0.1.3": newer,
      "0.1.2": { ...valid("0.1.2"), signing: "developer-id" },
      "0.1.1": valid("0.1.1"),
    });
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
    expect(tagsOf(manifestUrls)).toEqual(["v0.1.3", "v0.1.2"]);
  });

  it("does not skip past a mismatched or non-increasing bridge", async () => {
    const mismatch = catalogue({
      "0.1.2": newer,
      "0.1.1": valid("0.1.9"),
    });
    expect(
      await discoverGithubUpdate("0.1.0", "stable", mismatch.source),
    ).toEqual({ ok: false, code: "release_mismatch" });
    const lowBuild = catalogue({
      "0.1.2": newer,
      "0.1.1": { ...valid("0.1.1"), buildVersion: "1" },
    });
    expect(
      await discoverGithubUpdate("0.1.0", "stable", lowBuild.source, "1"),
    ).toEqual({ ok: false, code: "release_mismatch" });
  });

  it("stops after four consecutive newer formats without a fifth manifest fetch", async () => {
    const { source, manifestUrls } = catalogue({
      [versionOf(6)]: newer,
      [versionOf(5)]: newer,
      [versionOf(4)]: newer,
      [versionOf(3)]: newer,
      [versionOf(2)]: newer,
      [versionOf(1)]: valid(versionOf(1)),
    });
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
      ok: false,
      code: "release_format_newer",
    });
    // The catalogue fetch plus exactly four manifest fetches.
    expect(source.fetchJson).toHaveBeenCalledTimes(5);
    expect(tagsOf(manifestUrls)).toEqual([
      "v0.1.6",
      "v0.1.5",
      "v0.1.4",
      "v0.1.3",
    ]);
  });

  it("still reaches a bridge behind three newer formats", async () => {
    const { source, manifestUrls } = catalogue({
      [versionOf(4)]: newer,
      [versionOf(3)]: newer,
      [versionOf(2)]: newer,
      [versionOf(1)]: valid(versionOf(1)),
    });
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toMatchObject(
      { ok: true, value: { tag: `v${versionOf(1)}` } },
    );
    expect(manifestUrls).toHaveLength(4);
  });

  it("never selects a version at or below the installed one", async () => {
    const { source, manifestUrls } = catalogue({
      "0.1.2": newer,
      "0.1.1": valid("0.1.1"),
      "0.1.0": valid("0.1.0"),
    });
    // Installed is 0.1.1: only 0.1.2 is eligible and it is unreadable.
    expect(await discoverGithubUpdate("0.1.1", "stable", source)).toEqual({
      ok: false,
      code: "release_format_newer",
    });
    expect(tagsOf(manifestUrls)).toEqual(["v0.1.2"]);
  });

  it("returns no update when nothing is newer, even if lower releases exist", async () => {
    const { source } = catalogue({ "0.1.1": newer, "0.1.0": newer });
    expect(await discoverGithubUpdate("0.1.1", "stable", source)).toEqual({
      ok: true,
      value: null,
    });
    expect(source.fetchJson).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the newest", 0],
    ["a lower", 1],
  ])(
    "aborts on a duplicate eligible version of %s release",
    async (_name, at) => {
      const base = catalogue({ "0.1.2": newer, "0.1.1": valid("0.1.1") });
      const original = base.source.fetchJson;
      const withDuplicate: GithubReleasePorts = {
        ...base.source,
        fetchJson: vi.fn(async (url: string, max: number) => {
          const answer = await original(url, max);
          if (url !== GITHUB_RELEASES_API || !answer.ok) return answer;
          const list = answer.value.value as unknown[];
          return {
            ok: true as const,
            value: { ...answer.value, value: [...list, list[at]] },
          };
        }),
      };
      expect(
        await discoverGithubUpdate("0.1.0", "stable", withDuplicate),
      ).toEqual({ ok: false, code: "invalid_release_metadata" });
      // Only the catalogue was fetched: no manifest is trusted from an ambiguous list.
      expect(withDuplicate.fetchJson).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts on malformed release metadata before any manifest is fetched", async () => {
    const source = ports([release({ tag_name: "not-a-tag" }), release()]);
    expect(await discoverGithubUpdate("0.1.0", "stable", source)).toEqual({
      ok: false,
      code: "invalid_release_metadata",
    });
    expect(source.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a release whose manifest is a newer format", async () => {
    const { source } = catalogue({ [version]: newer });
    expect(
      await findGithubReleaseManifest(
        { version, buildVersion: "2" },
        "stable",
        source,
      ),
    ).toEqual({ ok: false, code: "release_format_newer" });
  });
});

describe("staged archive verification", () => {
  it("matches retained staged packages by build version and owner-beta update channel", () => {
    const betaManifest = {
      ...manifest,
      channel: "owner-beta" as const,
      version: "0.1.1-owner.beta.1",
      archiveName: "Farol-0.1.1-owner.beta.1-darwin-arm64.zip",
    };
    const packageIdentity = {
      product: betaManifest.product,
      bundleId: betaManifest.bundleId,
      version: betaManifest.version,
      buildVersion: betaManifest.buildVersion,
      updateChannel: "github-owner-beta",
      buildId: betaManifest.buildId,
      sourceCommit: betaManifest.sourceCommit,
      sourceTreeDigest: betaManifest.sourceTreeDigest,
      artifactSha256: betaManifest.artifactSha256,
      signing: betaManifest.signing,
      notarized: betaManifest.notarized,
    };
    expect(packageMatchesRelease(packageIdentity, betaManifest)).toBe(true);
    expect(
      packageMatchesRelease(
        { ...packageIdentity, buildVersion: "1" },
        betaManifest,
      ),
    ).toBe(false);
    expect(
      packageMatchesRelease(
        { ...packageIdentity, updateChannel: "local-preview-only" },
        betaManifest,
      ),
    ).toBe(false);
    expect(
      packageMatchesRelease(
        { ...packageIdentity, updateChannel: "github-stable" },
        betaManifest,
      ),
    ).toBe(false);
  });

  it("requires matching archive and internal package identity", async () => {
    const source = ports();
    const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
    if (!candidate.ok || !candidate.value) throw new Error("missing candidate");
    expect(
      await downloadAndVerifyGithubUpdate(candidate.value, source),
    ).toMatchObject({
      ok: true,
      value: {
        handle: "staged-opaque-handle",
        manifest,
        stagedAppPath: "/fixture/stage/Farol Next Preview.app",
        stagingRoot: "/fixture/stage",
      },
    });
    expect(source.verifyPackage).toHaveBeenCalledWith(
      "staged-opaque-handle",
      manifest,
    );
  });

  it.each([
    [
      "interruption",
      { ok: false as const, kind: "interrupted" as const },
      "interrupted",
    ],
    [
      "network failure",
      { ok: false as const, kind: "network_failure" as const },
      "network_failure",
    ],
    ["oversize", { ok: false as const, kind: "oversize" as const }, "oversize"],
  ])("does not mark %s ready", async (_label, response, code) => {
    const source = ports();
    const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
    if (!candidate.ok || !candidate.value) throw new Error("missing candidate");
    const failed = { ...source, download: vi.fn(async () => response) };
    expect(
      await downloadAndVerifyGithubUpdate(candidate.value, failed),
    ).toEqual({ ok: false, code });
    expect(source.verifyPackage).not.toHaveBeenCalled();
  });

  it("rejects archive checksum, internal digest and foreign redirect", async () => {
    const source = ports();
    const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
    if (!candidate.ok || !candidate.value) throw new Error("missing candidate");
    const badChecksum = {
      ...source,
      download: vi.fn(async (url: string) => ({
        ok: true as const,
        value: {
          handle: "staged",
          size: 10,
          sha256: digest("0"),
          finalUrl: url,
          redirects: [],
        },
      })),
    };
    expect(
      await downloadAndVerifyGithubUpdate(candidate.value, badChecksum),
    ).toEqual({ ok: false, code: "checksum_mismatch" });
    const foreignRedirect = {
      ...source,
      download: vi.fn(async (url: string) => ({
        ok: true as const,
        value: {
          handle: "staged",
          size: 10,
          sha256: digest("e"),
          finalUrl: "https://evil.example/asset",
          redirects: [url, "https://evil.example/asset"],
        },
      })),
    };
    expect(
      await downloadAndVerifyGithubUpdate(candidate.value, foreignRedirect),
    ).toEqual({ ok: false, code: "wrong_provenance" });
    const badPackage = {
      ...source,
      verifyPackage: vi.fn(async () => ({
        ok: true as const,
        value: {
          identity: {
            product: "Farol Next Preview",
            bundleId: "local.farol.next.preview",
            version,
            buildVersion: "2",
            updateChannel: "github-stable",
            buildId: digest("c"),
            sourceCommit,
            sourceTreeDigest: digest("b"),
            artifactSha256: digest("0"),
            signing: "unsigned",
            notarized: false,
          },
          stagedAppPath: "/fixture/stage/Farol Next Preview.app",
          stagingRoot: "/fixture/stage",
        },
      })),
    };
    expect(
      await downloadAndVerifyGithubUpdate(candidate.value, badPackage),
    ).toEqual({ ok: false, code: "package_mismatch" });
  });

  it("refuses a forged direct-download candidate before using the transport", async () => {
    const source = ports();
    const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
    if (!candidate.ok || !candidate.value) throw new Error("missing candidate");
    const forged = {
      ...candidate.value,
      archiveAsset: {
        ...candidate.value.archiveAsset,
        url: "https://evil.example/asset",
      },
    };
    expect(await downloadAndVerifyGithubUpdate(forged, source)).toEqual({
      ok: false,
      code: "release_mismatch",
    });
    expect(source.download).not.toHaveBeenCalled();
  });

  it.each(["manifestAsset", "archiveAsset"] as const)(
    "rejects old or wrong-owner %s paths in a direct candidate",
    async (field) => {
      const source = ports();
      const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
      if (!candidate.ok || !candidate.value)
        throw new Error("missing candidate");
      for (const repository of [
        "legrch/farol-releases",
        "other/farol",
        "legrch/other",
      ]) {
        const asset = candidate.value[field];
        const forged = {
          ...candidate.value,
          [field]: {
            ...asset,
            url: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
          },
        };
        expect(await downloadAndVerifyGithubUpdate(forged, source)).toEqual({
          ok: false,
          code: "release_mismatch",
        });
      }
      expect(source.download).not.toHaveBeenCalled();
      expect(source.verifyPackage).not.toHaveBeenCalled();
    },
  );

  it("refuses a decoded historical manifest as a new download candidate", async () => {
    const source = ports();
    const candidate = await discoverGithubUpdate("0.1.0", "stable", source);
    if (!candidate.ok || !candidate.value) throw new Error("missing candidate");
    const historical = parseRetainedGithubReleaseManifest({
      schema: "farol.ready-update/1",
      handle: "exact-local-archive",
      operation: null,
      manifest: { ...manifest, repository: RETAINED_GITHUB_RELEASE_REPOSITORY },
    });
    if (!historical.ok) throw new Error("missing historical manifest");
    expect(
      await downloadAndVerifyGithubUpdate(
        {
          ...candidate.value,
          manifest: historical.value as ReleaseManifest,
        },
        source,
      ),
    ).toEqual({ ok: false, code: "invalid_manifest" });
    expect(source.download).not.toHaveBeenCalled();
    expect(source.verifyPackage).not.toHaveBeenCalled();
  });
});
