import fs from "node:fs";
import { expect, it } from "vitest";
import {
  assertBuildAdvances,
  assertReleasePreflight,
  reachableReleases,
} from "../../tooling/release-preflight.mjs";

const read = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"),
  );

it("checks the version sources before a package build", () => {
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const resources = read("resources.json");
  expect(assertReleasePreflight(pkg, lock, resources)).toMatchObject({
    version: pkg.version,
    buildVersion: pkg.farolRelease.buildVersion,
    updateChannel: pkg.farolRelease.updateChannel,
  });
  expect(() =>
    assertReleasePreflight(pkg, { ...lock, version: "0.0.0" }, resources),
  ).toThrow("RELEASE_LOCK_IDENTITY_MISMATCH");
  expect(() =>
    assertReleasePreflight(pkg, lock, {
      ...resources,
      product: { ...resources.product, version: "0.0.0" },
    }),
  ).toThrow("PACKAGE_RESOURCE_VERSION_MISMATCH");
});

it("requires a new version to advance the build number past every earlier release", () => {
  const pkg = read("package.json");
  const at = (version, buildVersion) => ({
    ...pkg,
    version,
    farolRelease: { ...pkg.farolRelease, buildVersion },
  });
  const stable = (version, buildVersion) => ({
    version,
    buildVersion,
    updateChannel: "github-stable",
  });
  const history = [stable("0.5.25", "81"), stable("0.5.26", "82")];
  // 0.5.27 reused 0.5.26's build 82; the 0.5.26 updater refused it.
  expect(() => assertBuildAdvances(at("0.5.27", "82"), history)).toThrow(
    "RELEASE_BUILD_VERSION_NOT_ADVANCED",
  );
  // The highest earlier build counts, not the nearest tag.
  expect(() =>
    assertBuildAdvances(at("0.5.27", "82"), [
      stable("0.5.26", "82"),
      stable("0.5.25.1", "81"),
    ]),
  ).toThrow("RELEASE_BUILD_VERSION_NOT_ADVANCED");
  expect(() =>
    assertBuildAdvances(at("0.5.28", "83"), [
      ...history,
      stable("0.5.27", "82"),
    ]),
  ).not.toThrow();
  // Rebuilding the version's own tag and other channels are excluded.
  expect(() =>
    assertBuildAdvances(at("0.5.28", "83"), [stable("0.5.28", "83")]),
  ).not.toThrow();
  expect(() =>
    assertBuildAdvances(at("0.5.28", "83"), [
      {
        version: "0.6.0-owner.beta.1",
        buildVersion: "90",
        updateChannel: "github-owner-beta",
      },
    ]),
  ).not.toThrow();
});

it("reads release tags from Git and fails closed without full history", () => {
  const packages = {
    "v0.5.26": {
      version: "0.5.26",
      farolRelease: { buildVersion: "82", updateChannel: "github-stable" },
    },
    "v0.5.27": {
      version: "0.5.27",
      farolRelease: { buildVersion: "82", updateChannel: "github-stable" },
    },
  };
  const git =
    (shallow, tagPackages = packages) =>
    (...args) => {
      if (args[0] === "rev-parse") return shallow;
      if (args[0] === "tag")
        return [...Object.keys(tagPackages), "vnext", "v1"].join("\n");
      return JSON.stringify(tagPackages[args[1].split(":")[0]]);
    };
  expect(reachableReleases(git("false"))).toEqual([
    { version: "0.5.26", buildVersion: "82", updateChannel: "github-stable" },
    { version: "0.5.27", buildVersion: "82", updateChannel: "github-stable" },
  ]);
  expect(() => reachableReleases(git("true"))).toThrow(
    "RELEASE_HISTORY_UNAVAILABLE",
  );
  // A tag pointing at another version's sources is not a release.
  expect(
    reachableReleases(git("false", { "v0.5.26": packages["v0.5.27"] })),
  ).toEqual([]);
  expect(() =>
    reachableReleases(() => {
      throw new Error("git failed");
    }),
  ).toThrow();
});
