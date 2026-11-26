import { describe, expect, it } from "vitest";
import {
  cdnUrl,
  httpsUrl,
  initialKind,
  redirected,
  validLimit,
} from "./endpoint";
import {
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_REPOSITORY,
} from "../../domain/github-release-contract";

const asset = `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/download/v1.2.3/app.zip`;

describe("update endpoints", () => {
  it("accepts only plain https urls", () => {
    expect(httpsUrl("https://example.com/a")).not.toBeNull();
    for (const bad of [
      "http://example.com/",
      "https://u@example.com/",
      "https://u:p@example.com/",
      "https://example.com:444/",
      "https://example.com/#x",
      "nonsense",
    ])
      expect(httpsUrl(bad)).toBeNull();
  });

  it("classifies the api and release asset urls exactly", () => {
    expect(initialKind(GITHUB_RELEASES_API)).toBe("api");
    expect(initialKind(asset)).toBe("asset");
    expect(initialKind(`${asset}?x=1`)).toBeNull();
    expect(initialKind(asset.replace("github.com", "evil.example"))).toBeNull();
    expect(initialKind(asset.replace("/v1.2.3/", "/1.2.3/"))).toBeNull();
    expect(initialKind(asset.replace("/v1.2.3/app.zip", "/v1/a/b"))).toBeNull();
    expect(initialKind(`${asset} `)).toBeNull();
  });

  it("accepts only the pinned cdn host with a path", () => {
    const host = "https://release-assets.githubusercontent.com";
    expect(cdnUrl(`${host}/x`)).toBe(true);
    expect(cdnUrl(`${host}/`)).toBe(false);
    expect(cdnUrl("https://githubusercontent.com/x")).toBe(false);
    expect(cdnUrl(`http://release-assets.githubusercontent.com/x`)).toBe(false);
  });

  it("limits and redirects", () => {
    expect(validLimit(10, 10)).toBe(true);
    expect(validLimit(11, 10)).toBe(false);
    expect(validLimit(0, 10)).toBe(false);
    expect(validLimit(1.5, 10)).toBe(false);
    for (const code of [301, 302, 303, 307, 308])
      expect(redirected(code)).toBe(true);
    expect(redirected(200)).toBe(false);
    expect(redirected(304)).toBe(false);
  });
});
