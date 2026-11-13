import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const nextRoot = path.resolve(here, "../..");
const checker = path.join(nextRoot, "tooling/check-source-slicing.mjs");
const fixtures = path.join(here, "fixtures/source-slicing");

interface Summary {
  scanned: number;
  offenders: number;
  byMechanism: Record<string, number>;
  textOnly: number;
  findings: { code: string; detail: string }[];
}

function check(root: string) {
  const result = spawnSync(
    process.execPath,
    [checker, "--root", root, "--json"],
    { cwd: nextRoot, encoding: "utf8" },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    summary: JSON.parse(result.stdout || "null") as Summary | null,
  };
}

describe("the source-slicing ban", () => {
  it("accepts the real tests against the checked-in allowlist", () => {
    const result = check(nextRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.findings).toEqual([]);
  });

  it("accepts a test that imports the code under test", () => {
    const result = check(path.join(fixtures, "clean"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(0);
  });

  it("allows a test that only asserts on source text, and counts it", () => {
    const result = check(path.join(fixtures, "text-only"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(0);
    expect(result.summary?.textOnly).toBe(1);
  });

  it("does not accuse execution that never touches production source", () => {
    const result = check(path.join(fixtures, "unrelated-read"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(0);
  });

  it("accepts an allowlisted offender exactly as listed", () => {
    const result = check(path.join(fixtures, "listed"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(1);
  });

  // Every execution mechanism the detector knows, each as a new offender.
  it.each(["vm", "function", "eval", "transpile", "esbuild"])(
    "refuses a new %s offender",
    (mechanism) => {
      const result = check(path.join(fixtures, mechanism));
      expect(result.status).toBe(1);
      expect(result.summary?.findings.map((f) => f.code)).toEqual([
        "SLICING_NEW_OFFENDER",
      ]);
      expect(result.summary?.byMechanism).toEqual({ [mechanism]: 1 });
    },
  );

  it("refuses an offender missing from a non-empty allowlist", () => {
    const result = check(path.join(fixtures, "new-offender"));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code).sort()).toEqual([
      "SLICING_ALLOWLIST_STALE",
      "SLICING_NEW_OFFENDER",
    ]);
  });

  it("refuses a stale allowlist entry", () => {
    const result = check(path.join(fixtures, "stale"));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code)).toEqual([
      "SLICING_ALLOWLIST_STALE",
    ]);
  });
});
