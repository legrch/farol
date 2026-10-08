import fs from "node:fs";
import { expect, it } from "vitest";
import { assertPackageResourceManifest } from "../../tooling/verify-package-content.mjs";

it("keeps checked-in release and resource identities consistent", () => {
  const read = (name) =>
    JSON.parse(
      fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"),
    );
  const pkg = read("package.json");
  const resources = read("resources.json");
  const artifact = {
    version: pkg.version,
    updateChannel: pkg.farolRelease.updateChannel,
  };
  expect(() =>
    assertPackageResourceManifest(
      resources,
      artifact,
      pkg.version,
      artifact.updateChannel,
    ),
  ).not.toThrow();
  expect(() =>
    assertPackageResourceManifest(
      {
        ...resources,
        product: { ...resources.product, version: `${pkg.version}0` },
      },
      artifact,
      pkg.version,
      artifact.updateChannel,
    ),
  ).toThrow("PACKAGE_RESOURCE_VERSION_MISMATCH");
});
