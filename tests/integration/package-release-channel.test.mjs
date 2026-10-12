import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tooling = path.resolve(import.meta.dirname, "../../tooling");
// Exercise the actual CLI's source-metadata selection with a mocked physical
// verifier. Real package-content checks have separate built-byte acceptance.
async function runVerifier(document, expectedChannel) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-channel-cli-")),
  );
  try {
    await fs.mkdir(path.join(root, "tooling"));
    await fs.mkdir(path.join(root, "_output/package"), { recursive: true });
    for (const name of [
      "verify-package.mjs",
      "candidate-contract.mjs",
      "package-layout.mjs",
      "release-identity.mjs",
    ])
      await fs.copyFile(
        path.join(tooling, name),
        path.join(root, "tooling", name),
      );
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(document),
    );
    await fs.writeFile(path.join(root, "resources.json"), "{}");
    await fs.writeFile(
      path.join(root, "_output/package/artifact.json"),
      JSON.stringify({
        schema: 6,
        artifactPath: path.join(root, "_output/package/Farol.app"),
        sourceDirty: false,
      }),
    );
    await fs.writeFile(
      path.join(root, "tooling/verify-package-content.mjs"),
      `
import assert from "node:assert/strict";
export async function verifyPackageContent(options) {
  options.assertArtifactPath();
  assert.equal(options.expectedChannel, ${JSON.stringify(expectedChannel)});
  return {product:"Farol Next Preview", version:options.expectedVersion, artifactSha256:"fixture"};
}
`,
    );
    return spawnSync(
      process.execPath,
      [path.join(root, "tooling/verify-package.mjs")],
      {
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
const release = { buildVersion: "2", updateChannel: "github-owner-beta" };
describe("package CLI release channel", () => {
  it.each(["0.1.0-owner.beta.0", "0.1.0-owner.beta.1"])(
    "uses the declared accepted owner-beta channel for %s",
    async (version) => {
      const result = await runVerifier(
        { version, farolRelease: release },
        "github-owner-beta",
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
    },
  );
  it("keeps an explicit local preview separate", async () => {
    const result = await runVerifier(
      { version: "0.1.0-preview.0" },
      "local-preview-only",
    );
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    { version: "0.1.0-owner.beta.01", farolRelease: release },
    {
      version: "0.1.0-owner.beta.1",
      farolRelease: { ...release, updateChannel: "github-stable" },
    },
  ])(
    "refuses invalid committed release metadata before physical verification",
    async (document) => {
      const result = await runVerifier(document, "github-owner-beta");
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("RELEASE_BUILD_FIELDS_INVALID");
    },
  );
});

it("uses the stable release channel for an ordinary version", async () => {
  const result = await runVerifier(
    {
      version: "0.2.1",
      farolRelease: { buildVersion: "30", updateChannel: "github-stable" },
    },
    "github-stable",
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
