import fs from "node:fs";
import { expect, it } from "vitest";
import {
  assertBuildAdvances,
  assertReleasePreflight,
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

it("requires a new version to advance the build number past the previous release", () => {
  const pkg = read("package.json");
  const at = (version, buildVersion) => ({
    ...pkg,
    version,
    farolRelease: { ...pkg.farolRelease, buildVersion },
  });
  // 0.5.27 reused 0.5.26's build 82; the 0.5.26 updater refused it.
  expect(() =>
    assertBuildAdvances(at("0.5.27", "82"), {
      version: "0.5.26",
      buildVersion: "82",
    }),
  ).toThrow("RELEASE_BUILD_VERSION_NOT_ADVANCED");
  expect(() =>
    assertBuildAdvances(at("0.5.27", "81"), {
      version: "0.5.26",
      buildVersion: "82",
    }),
  ).toThrow("RELEASE_BUILD_VERSION_NOT_ADVANCED");
  expect(() =>
    assertBuildAdvances(at("0.5.28", "83"), {
      version: "0.5.27",
      buildVersion: "82",
    }),
  ).not.toThrow();
  expect(() =>
    assertBuildAdvances(at("0.5.28", "83"), {
      version: "0.5.28",
      buildVersion: "83",
    }),
  ).not.toThrow();
  expect(() => assertBuildAdvances(at("0.5.28", "83"), null)).not.toThrow();
});
