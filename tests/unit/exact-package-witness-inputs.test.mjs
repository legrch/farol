import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import {
  assertWitnessInputCoverage,
  checkExactPackageWitnessInputs,
  EXACT_PACKAGE_WITNESSES,
  WITNESS_HARNESS_ENTRIES,
} from "../../tooling/exact-package-witness-inputs.mjs";

it("keeps identity and witness configuration attested, never test exemptions", () => {
  for (const input of [
    "tooling/harness-identity.ts",
    "tooling/exact-package-witness-inputs.mjs",
  ]) {
    expect(WITNESS_HARNESS_ENTRIES).toContain(input);
    for (const witness of EXACT_PACKAGE_WITNESSES) {
      expect(witness.testInputs).toContain(witness.entry);
      expect(witness.testInputs).not.toContain(input);
    }
  }
});

it.each([
  "tooling/new-helper.ts",
  "src/new-policy.ts",
  "tests/e2e/unreviewed-helper.ts",
  "node_modules/new-package/index.js",
])("rejects an undeclared transitive witness input: %s", (file) => {
  expect(() =>
    assertWitnessInputCoverage(["src/known.ts", file], ["src/known.ts"], []),
  ).toThrow(`WITNESS_INPUT_UNDECLARED:${file}`);
  expect(() => assertWitnessInputCoverage([file], [file], [])).not.toThrow();
});

it("compiles transitive reexports without executing witnesses and refuses a missing ledger input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "witness-imports-"));
  try {
    const entry = EXACT_PACKAGE_WITNESSES[0].entry;
    await fs.mkdir(path.join(root, path.dirname(entry)), { recursive: true });
    await fs.mkdir(path.join(root, "tooling"));
    await fs.writeFile(
      path.join(root, entry),
      'export { value } from "../../tooling/helper.mjs"; throw new Error("MUST_NOT_EXECUTE");',
    );
    await fs.writeFile(
      path.join(root, "tooling/helper.mjs"),
      'export { value } from "./leaf.mjs"; export { EXACT_PACKAGE_WITNESSES } from "./exact-package-witness-inputs.mjs";',
    );
    await fs.copyFile(
      new URL(
        "../../tooling/exact-package-witness-inputs.mjs",
        import.meta.url,
      ),
      path.join(root, "tooling/exact-package-witness-inputs.mjs"),
    );
    await fs.writeFile(
      path.join(root, "tooling/leaf.mjs"),
      "export const value = 1;",
    );
    await expect(
      checkExactPackageWitnessInputs({
        root,
        build,
        ledgerPaths: ["tooling/helper.mjs"],
      }),
    ).rejects.toThrow("WITNESS_INPUT_UNDECLARED:tooling/leaf.mjs");
    await expect(
      checkExactPackageWitnessInputs({
        root,
        build,
        ledgerPaths: ["tooling/helper.mjs", "tooling/leaf.mjs"],
      }),
    ).rejects.toThrow(
      "WITNESS_INPUT_UNDECLARED:tooling/exact-package-witness-inputs.mjs",
    );
    await expect(
      checkExactPackageWitnessInputs({
        root,
        build,
        ledgerPaths: [
          "tooling/helper.mjs",
          "tooling/leaf.mjs",
          "tooling/exact-package-witness-inputs.mjs",
        ],
      }),
    ).resolves.toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
