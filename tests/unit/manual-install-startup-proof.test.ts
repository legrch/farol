import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishManualInstallStartupProof } from "../../src/apps/desktop/manual-install-startup-proof";

describe("manual installer startup proof", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  const fixture = () => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "farol-proof-")),
    );
    roots.push(root);
    const directory = path.join(root, "farol-release.Abc12345");
    mkdirSync(directory, { mode: 0o700 });
    return { root, directory };
  };
  const request =
    "--farol-install-proof=Abc12345:11111111-1111-4111-8111-111111111111";
  const build = { version: "0.5.13", buildId: "a".repeat(64) };

  it("writes one nonce and PID bound receipt only for an explicit request", () => {
    const { root, directory } = fixture();
    expect(publishManualInstallStartupProof([], build, 42, root)).toBe(false);
    expect(publishManualInstallStartupProof([request], build, 42, root)).toBe(
      true,
    );
    expect(
      JSON.parse(
        readFileSync(path.join(directory, "startup-proof.json"), "utf8"),
      ),
    ).toEqual({
      schema: "farol.install-startup-proof/1",
      nonce: "11111111-1111-4111-8111-111111111111",
      buildId: build.buildId,
      version: build.version,
      pid: 42,
    });
    expect(() =>
      publishManualInstallStartupProof([request], build, 43, root),
    ).toThrow();
  });

  it("refuses a public directory and malformed or duplicate requests", () => {
    const { root, directory } = fixture();
    chmodSync(directory, 0o755);
    expect(() =>
      publishManualInstallStartupProof([request], build, 42, root),
    ).toThrow("INSTALL_STARTUP_PROOF_UNSAFE");
    chmodSync(directory, 0o700);
    expect(() =>
      publishManualInstallStartupProof([request, request], build, 42, root),
    ).toThrow("INSTALL_STARTUP_PROOF_INVALID");
    expect(() =>
      publishManualInstallStartupProof(
        ["--farol-install-proof=../escape"],
        build,
        42,
        root,
      ),
    ).toThrow("INSTALL_STARTUP_PROOF_INVALID");
  });
});
