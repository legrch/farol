import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_RESOURCE_MANIFEST,
  assertResourceManifest,
} from "../../tooling/resource-contract.mjs";

const vnextRoot = path.resolve(import.meta.dirname, "../..");

describe("Farol resource ownership", () => {
  it("declares every implemented identity and keeps absent integrations absent", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(vnextRoot, "resources.json"), "utf8"),
    );

    const packageDocument = JSON.parse(
      await fs.readFile(path.join(vnextRoot, "package.json"), "utf8"),
    );
    expect(manifest).toEqual({
      ...EXPECTED_RESOURCE_MANIFEST,
      product: {
        ...EXPECTED_RESOURCE_MANIFEST.product,
        version: packageDocument.version,
        updateChannel: packageDocument.farolRelease.updateChannel,
      },
      integrations: {
        ...EXPECTED_RESOURCE_MANIFEST.integrations,
        updater: "farol-owned-github-releases",
      },
    });
    expect(() => assertResourceManifest(manifest)).not.toThrow();
  });

  it.each([
    ["application", ["application", "userData"], "${appData}/Farol"],
    ["runtime", ["runtime", "process"], "Farol Next Runtime"],
    ["processes", ["processes", 0, "name"], "Farol Next Preview"],
    ["native Computer", ["integrations", "nativeComputer"], "present"],
    ["native Agent", ["integrations", "nativeAgent"], "present"],
    ["login item", ["integrations", "loginItem"], "registered"],
    ["exclusions", ["exclusions", 0], "~/.farol-next"],
  ])("rejects drift in the %s declaration", (_name, segments, replacement) => {
    const changed = structuredClone(EXPECTED_RESOURCE_MANIFEST);
    let cursor = changed;
    for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
    cursor[segments.at(-1)] = replacement;
    expect(() => assertResourceManifest(changed)).toThrow(
      "PACKAGE_RESOURCE_MANIFEST_INVALID",
    );
  });
});
