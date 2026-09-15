import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const nextRoot = path.resolve(here, "../..");
const checker = path.join(nextRoot, "tooling/check-architecture.mjs");
const fixtures = path.join(here, "fixtures");

function check(root: string) {
  return spawnSync(process.execPath, [checker, "--root", root, "--json"], {
    cwd: nextRoot,
    encoding: "utf8",
  });
}

describe("the executable architecture boundary", () => {
  it("accepts shared infrastructure consumed through two ports", () => {
    const result = check(path.join(fixtures, "positive-shared-infra"));
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  const denied = [
    ["domain-to-infra", "ARCH_LAYER_DIRECTION"],
    ["cross-module-backdoor", "ARCH_CROSS_MODULE"],
    ["contract-domain-leak", "ARCH_CONTRACT_LEAK"],
    ["alias-to-boot", "ARCH_MODULE_TO_BOOT"],
    ["dynamic-import", "ARCH_DYNAMIC_IMPORT"],
    ["cycle", "ARCH_CYCLE"],
    ["host-in-pure-zone", "ARCH_PURE_HOST_IMPORT"],
    ["host-global-in-pure-zone", "ARCH_PURE_HOST_GLOBAL"],
    ["hidden-extension-in-pure-zone", "ARCH_PURE_HOST_IMPORT"],
    ["require-host-in-pure-zone", "ARCH_PURE_HOST_IMPORT"],
    ["external-in-pure-zone", "ARCH_PURE_EXTERNAL_IMPORT"],
    ["production-testkit", "ARCH_PRODUCTION_TESTKIT"],
    ["unclassified", "ARCH_UNCLASSIFIED"],
  ] as const;

  for (const [fixture, code] of denied) {
    it(`rejects ${fixture}`, () => {
      const result = check(path.join(fixtures, fixture));
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(code);
    });
  }
});
