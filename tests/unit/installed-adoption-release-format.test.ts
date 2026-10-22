import { describe, expect, it, vi } from "vitest";
import { resolveAdoptionManifest } from "../../src/apps/desktop/installed-adoption";
import {
  GITHUB_RELEASES_API,
  type ReleaseManifest,
} from "../../src/modules/release/domain/github-release-contract";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";

const digest = (character: string) => character.repeat(64);
const version = "0.2.7";
const tag = `v${version}`;
const archiveName = `Farol-${version}-darwin-arm64.zip`;
const assetUrl = (name: string) =>
  `https://github.com/legrch/farol/releases/download/${tag}/${name}`;

const build: BuildIdentity = {
  schema: 1,
  product: "Farol",
  version,
  bundleId: "io.github.legrch.farol",
  updateChannel: "github-stable",
  buildVersion: "36",
  builtAt: "2026-10-14T12:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: digest("b"),
  sourceDirty: false,
  buildId: digest("c"),
};

const manifest: ReleaseManifest = {
  schema: "farol.github-release/1",
  repository: "legrch/farol",
  channel: "stable",
  product: "Farol",
  bundleId: "io.github.legrch.farol",
  version,
  buildVersion: "36",
  sourceCommit: build.sourceCommit,
  sourceTreeDigest: build.sourceTreeDigest,
  buildId: build.buildId,
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

const catalogue = [
  {
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
  },
];

function fetchJsonFor(document: unknown) {
  return vi.fn(async (url: string) => ({
    ok: true as const,
    value: {
      value: url === GITHUB_RELEASES_API ? catalogue : document,
      finalUrl: url,
      redirects: [],
    },
  }));
}

describe("first-launch adoption of a newer release format", () => {
  it("adopts the matching /1 manifest", async () => {
    expect(
      await resolveAdoptionManifest({
        build,
        fetchJson: fetchJsonFor(manifest),
      }),
    ).toEqual({ ok: true, value: manifest });
  });

  it("refuses a /2 manifest of the installed release as a mismatch, never a success", async () => {
    const result = await resolveAdoptionManifest({
      build,
      fetchJson: fetchJsonFor({
        ...manifest,
        schema: "farol.github-release/2",
      }),
    });
    expect(result).toEqual({
      ok: false,
      code: "UPDATE_ADOPTION_RELEASE_MISMATCH",
    });
  });

  it("keeps the other published-manifest failures on their own codes", async () => {
    expect(
      await resolveAdoptionManifest({
        build,
        fetchJson: fetchJsonFor({ ...manifest, signing: "developer-id" }),
      }),
    ).toEqual({ ok: false, code: "UPDATE_ADOPTION_INVALID_MANIFEST" });
  });
});
