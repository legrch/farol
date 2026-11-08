import fs from "node:fs";
import { expect, it } from "vitest";
import { assertReleasePreflight } from "../../tooling/release-preflight.mjs";

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
