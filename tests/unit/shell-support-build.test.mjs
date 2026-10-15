import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  declareShellSupport,
  SHELL_PLATFORM,
} from "../../tooling/shell-support.mjs";
import { parseShellSupportDeclaration } from "../../apps/desktop/bridge/shell-support.ts";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source.ts";

// Producer/consumer and source-input checks only. The copied source is not
// compiled or executed; no native support, release or permission is issued.
const repository = fileURLToPath(new URL("../..", import.meta.url));
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
function values() {
  const identity = createBuildIdentity({
    version: "0.2.0-owner.beta.11",
    buildVersion: "25",
    updateChannel: "github-owner-beta",
    builtAt: "2026-10-12T00:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    sourceDirty: false,
  });
  const core = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: identity.buildId,
      sourceSHA: identity.sourceCommit,
      sourceTreeDigest: identity.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: { path: "farol-backend", size: 128, sha256: "c".repeat(64) },
  };
  return { identity, core };
}
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-shell-build-fixture-")),
  );
  roots.push(root);
  const inputs = [
    ...SHELL_PLATFORM.compilerInputs,
    SHELL_PLATFORM.watchdogSource,
  ];
  for (const input of inputs) {
    const target = path.join(root, input.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Immutable source fixture from public baseline6e8ddbd. Its digest is the
    // existing independent qualification pin; never learn a pin from live bytes.
    const source =
      input.path === "modules/computer/infra/process/process.go"
        ? "tests/fixtures/shell-qualified-process.go.txt"
        : input.path;
    await fs.copyFile(path.join(repository, source), target);
  }
  return { root, ...values() };
}

describe("independent build Shell support", () => {
  it("produces the exact runtime declaration and non-executed watchdog resource", async () => {
    const { root, core, identity } = await fixture();
    const result = await declareShellSupport(root, core, identity);
    expect(parseShellSupportDeclaration(result.support)).toEqual(
      result.support,
    );
    expect(Buffer.from(result.watchdogSourceBase64, "base64").toString()).toBe(
      SHELL_WATCHDOG_SOURCE,
    );
    expect(result.support.qualification.sha256).toBe(
      createHash("sha256").update(JSON.stringify(SHELL_PLATFORM)).digest("hex"),
    );
    expect(result.support.qualification.compilerSHA256).toBe(
      createHash("sha256")
        .update(JSON.stringify(SHELL_PLATFORM.compilerInputs))
        .digest("hex"),
    );
    expect(Object.isFrozen(result.support.core.binary)).toBe(true);
    expect(Object.isFrozen(result.support.executables)).toBe(true);
    core.binary.sha256 = "d".repeat(64);
    expect(result.support.core.binary.sha256).toBe("c".repeat(64));
  });

  it("refuses live source while its independent process qualification pin differs", async () => {
    const { core, identity } = values();
    const input = SHELL_PLATFORM.compilerInputs.find(
      (entry) => entry.path === "modules/computer/infra/process/process.go",
    );
    const actual = createHash("sha256")
      .update(await fs.readFile(path.join(repository, input.path)))
      .digest("hex");
    if (actual === input.sha256) {
      await expect(
        declareShellSupport(repository, core, identity),
      ).resolves.toHaveProperty("support");
    } else {
      await expect(
        declareShellSupport(repository, core, identity),
      ).rejects.toThrow("SHELL_SUPPORT_INPUT_CHANGED");
    }
  });

  it.each(["core", "dirty", "architecture"])(
    "refuses %s crossing before selecting support",
    async (kind) => {
      const { core, identity } = values();
      if (kind === "core") core.build.sourceSHA = "f".repeat(40);
      if (kind === "dirty") identity.sourceDirty = true;
      if (kind === "architecture") core.build.platform.goarch = "amd64";
      await expect(
        declareShellSupport(repository, core, identity),
      ).rejects.toThrow();
    },
  );

  it.each(["changed", "new-file", "removed", "symlink", "hardlink"])(
    "refuses %s compiler input instead of refreshing its pin",
    async (kind) => {
      const f = await fixture();
      const file = path.join(f.root, SHELL_PLATFORM.compilerInputs[0].path);
      if (kind === "changed")
        await fs.appendFile(file, "\n// changed compiler\n");
      if (kind === "new-file")
        await fs.writeFile(
          path.join(path.dirname(file), "unexpected.go"),
          "package process\n",
        );
      if (kind === "removed") await fs.unlink(file);
      if (kind === "symlink") {
        await fs.rename(file, `${file}.retained`);
        await fs.symlink(`${file}.retained`, file);
      }
      if (kind === "hardlink") await fs.link(file, `${file}.alias`);
      await expect(
        declareShellSupport(f.root, f.core, f.identity),
      ).rejects.toThrow(/SHELL_SUPPORT_/u);
    },
  );

  it("refuses changed watchdog source even if the compiler is unchanged", async () => {
    const f = await fixture();
    await fs.appendFile(
      path.join(f.root, SHELL_PLATFORM.watchdogSource.path),
      "\n// changed source\n",
    );
    await expect(
      declareShellSupport(f.root, f.core, f.identity),
    ).rejects.toThrow("SHELL_SUPPORT_INPUT_CHANGED");
  });
});
