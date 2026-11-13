import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const nextRoot = path.resolve(here, "../..");
const checker = path.join(nextRoot, "tooling/check-source-slicing.mjs");
const fixtures = path.join(here, "fixtures/source-slicing");

interface Summary {
  scanned: number;
  offenders: number;
  byMechanism: Record<string, number>;
  textOnly: number;
  waived: number;
  waivedFiles: { file: string; reason: string; mechanisms: string[] }[];
  findings: { code: string; detail: string }[];
}

function run(root: string, extra: string[]) {
  return spawnSync(process.execPath, [checker, "--root", root, ...extra], {
    cwd: nextRoot,
    encoding: "utf8",
  });
}

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const dir of temporaryRoots)
    fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryRoot(
  testSource: string,
  allowlist: Record<string, string[]> | null,
): string {
  const parent = path.join(nextRoot, "_output", "tmp");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "slicing-"));
  temporaryRoots.push(dir);
  fs.mkdirSync(path.join(dir, "tests/unit"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests/architecture"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests/unit/case.mjs"), testSource);
  if (allowlist)
    fs.writeFileSync(
      path.join(dir, "tests/architecture/source-slicing-allowlist.json"),
      JSON.stringify({ schema: 1, files: allowlist }),
    );
  return dir;
}

function listed(dir: string): Record<string, string[]> {
  const file = path.join(
    dir,
    "tests/architecture/source-slicing-allowlist.json",
  );
  return (
    JSON.parse(fs.readFileSync(file, "utf8")) as {
      files: Record<string, string[]>;
    }
  ).files;
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
  it.each([
    "vm",
    "function",
    "eval",
    "transpile",
    "esbuild",
    "esbuild-template",
  ])("refuses a new %s offender", (mechanism) => {
    const result = check(path.join(fixtures, mechanism));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code)).toEqual([
      "SLICING_NEW_OFFENDER",
    ]);
    const expected = mechanism.replace("-template", "");
    // A transpile always ends in a dynamic load, which is its own signal.
    expect(result.summary?.byMechanism).toEqual(
      expected === "transpile" ? { load: 1, transpile: 1 } : { [expected]: 1 },
    );
  });

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

  // False-positive shapes that must never block a PR.
  it.each([
    "fp-fixture-vm",
    "fp-title",
    "fp-import-specifier",
    "fp-literal-code",
    "fp-anchor",
    "fp-import-real",
    "fp-shared-ctx",
    "fp-import-method",
  ])("does not accuse %s", (name) => {
    const result = check(path.join(fixtures, name));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(0);
  });

  // Shapes the data-flow analysis must keep catching.
  it.each([
    ["join-binding", "vm"],
    ["alias-named", "vm"],
    ["alias-namespace", "vm"],
    ["alias-require", "vm"],
    ["alias-promises", "vm"],
    ["transform-sync", "transpile"],
    ["transform-async", "transpile"],
    ["let-assign", "vm"],
    ["helper-reader", "vm"],
    ["helper-executor", "vm"],
    ["for-of", "vm"],
    ["push-collect", "vm"],
    ["member-assign", "vm"],
    ["callback-readfile", "vm"],
    ["callback-then", "vm"],
    ["vm-require-call", "vm"],
    ["vm-await-import", "vm"],
    ["load-data-url", "load"],
    ["load-tempfile", "load"],
    ["load-compile", "load"],
    ["helper-prefix", "vm"],
    ["rebound-root", "vm"],
    ["object-literal", "vm"],
    ["join-receiver", "vm"],
    ["find-callback", "vm"],
    ["shadowed-callee", "vm"],
    ["raw-import", "vm"],
  ])("catches %s as %s", (name, mechanism) => {
    const result = check(path.join(fixtures, name));
    expect(result.status).toBe(1);
    expect(result.summary?.byMechanism).toEqual(
      mechanism === "transpile"
        ? { load: 1, transpile: 1 }
        : { [mechanism]: 1 },
    );
  });

  it("lets a reviewed waiver exempt a false positive and counts it", () => {
    const result = check(path.join(fixtures, "waived"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary?.offenders).toBe(0);
    expect(result.summary?.waived).toBe(1);
  });

  it("refuses a waiver without a reason", () => {
    const result = check(path.join(fixtures, "waiver-no-reason"));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code)).toEqual([
      "SLICING_WAIVER_INVALID",
    ]);
  });

  it("refuses a stale waiver on a file that is not flagged", () => {
    const result = check(path.join(fixtures, "waiver-stale"));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code)).toEqual([
      "SLICING_WAIVER_STALE",
    ]);
  });

  it.each(["waiver-in-string", "waiver-in-block"])(
    "does not honour a waiver written in %s",
    (name) => {
      const result = check(path.join(fixtures, name));
      expect(result.status).toBe(1);
      expect(result.summary?.waived).toBe(0);
      expect(result.summary?.findings.map((f) => f.code)).toEqual([
        "SLICING_NEW_OFFENDER",
      ]);
    },
  );

  it("refuses a waiver on an allowlisted legacy slicer", () => {
    const result = check(path.join(fixtures, "waiver-legacy"));
    expect(result.status).toBe(1);
    expect(result.summary?.findings.map((f) => f.code)).toContain(
      "SLICING_WAIVER_ON_LEGACY",
    );
    expect(result.summary?.waivedFiles[0]?.mechanisms).toEqual(["vm"]);
  });

  it("--write-allowlist refuses to trade an entry for a waiver", () => {
    const dir = temporaryRoot(
      '// source-slicing: allowed \u2014 reviewed: trade attempt\nimport fs from "node:fs";\nimport vm from "node:vm";\nvm.runInNewContext(fs.readFileSync("src/a/b.ts", "utf8"), {});\n',
      { "tests/unit/case.mjs": ["vm"] },
    );
    const result = run(dir, ["--write-allowlist"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be waived");
    expect(listed(dir)).toEqual({ "tests/unit/case.mjs": ["vm"] });
  });

  describe("allowlist writers", () => {
    const vmOnly =
      'import fs from "node:fs";\nimport vm from "node:vm";\nvm.runInNewContext(fs.readFileSync("src/a/b.ts", "utf8"), {});\n';
    const vmAndFunction =
      vmOnly + 'new Function(fs.readFileSync("src/a/b.ts", "utf8"));\n';
    const entry = "tests/unit/case.mjs";

    it("--write-allowlist drops entries that no longer offend", () => {
      const dir = temporaryRoot("export {};\n", { [entry]: ["vm"] });
      const result = run(dir, ["--write-allowlist"]);
      expect(result.status, result.stderr).toBe(0);
      expect(listed(dir)).toEqual({});
    });

    it("--write-allowlist drops a mechanism that no longer offends", () => {
      const dir = temporaryRoot(vmOnly, { [entry]: ["vm", "function"] });
      const result = run(dir, ["--write-allowlist"]);
      expect(result.status, result.stderr).toBe(0);
      expect(listed(dir)).toEqual({ [entry]: ["vm"] });
    });

    it("--write-allowlist refuses a new mechanism on a listed file", () => {
      const dir = temporaryRoot(vmAndFunction, { [entry]: ["vm"] });
      const result = run(dir, ["--write-allowlist"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("new mechanism (function)");
      expect(listed(dir)).toEqual({ [entry]: ["vm"] });
    });

    it("--write-allowlist refuses a new offender", () => {
      const dir = temporaryRoot(vmOnly, {});
      const result = run(dir, ["--write-allowlist"]);
      expect(result.status).toBe(1);
      expect(listed(dir)).toEqual({});
    });

    it("--init-allowlist refuses when the allowlist is not empty", () => {
      const dir = temporaryRoot(vmOnly, { "tests/unit/other.mjs": ["vm"] });
      const result = run(dir, ["--init-allowlist"]);
      expect(result.status).toBe(1);
      expect(listed(dir)).toEqual({ "tests/unit/other.mjs": ["vm"] });
    });

    it("--init-allowlist refuses even a committed empty allowlist", () => {
      const dir = temporaryRoot(vmOnly, {});
      const result = run(dir, ["--init-allowlist"]);
      expect(result.status).toBe(1);
      expect(listed(dir)).toEqual({});
    });

    it("--init-allowlist --force-init rewrites an existing allowlist", () => {
      const dir = temporaryRoot(vmOnly, {});
      const result = run(dir, ["--init-allowlist", "--force-init"]);
      expect(result.status, result.stderr).toBe(0);
      expect(listed(dir)).toEqual({ [entry]: ["vm"] });
    });

    it("--init-allowlist creates a missing allowlist", () => {
      const dir = temporaryRoot(vmOnly, null);
      const result = run(dir, ["--init-allowlist"]);
      expect(result.status, result.stderr).toBe(0);
      expect(listed(dir)).toEqual({ [entry]: ["vm"] });
    });
  });
});
