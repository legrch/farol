// Harness identities are product-owned values. Attest this import surface and
// its transitive inputs with the same readBuildInput hook as packaged scripts;
// do not turn it into a test-only exception at the candidate boundary.
export const WITNESS_HARNESS_ENTRIES = Object.freeze([
  "tooling/harness-identity.ts",
  "tooling/exact-package-witness-inputs.mjs",
]);
export const EXACT_PACKAGE_WITNESSES = Object.freeze([
  Object.freeze({
    entry: "tests/e2e/go-computer-mcp.e2e.entry.ts",
    testInputs: Object.freeze([
      "tests/e2e/go-computer-mcp.e2e.entry.ts",
      "tests/e2e/go-computer-mcp.diagnostics.ts",
      "tests/e2e/go-git-shell-journey.ts",
      "tests/fixtures/ordinary-git-environment.mjs",
    ]),
  }),
]);

export function assertWitnessInputCoverage(inputs, ledgerPaths, testInputs) {
  const declared = new Set(ledgerPaths);
  const testOwned = new Set(testInputs);
  for (const input of inputs)
    if (!declared.has(input) && !testOwned.has(input))
      throw new Error(`WITNESS_INPUT_UNDECLARED:${input}`);
}

// Compile only: no native execution, profile allocation or provider call. This
// sees the same actual graph as each exact-package witness, including exports
// and dependencies, rather than accepting directory/pattern exceptions.
export async function checkExactPackageWitnessInputs({
  root,
  build,
  ledgerPaths,
}) {
  for (const witness of EXACT_PACKAGE_WITNESSES) {
    const compiled = await build({
      absWorkingDir: root,
      entryPoints: [witness.entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    assertWitnessInputCoverage(
      Object.keys(compiled.metafile.inputs),
      ledgerPaths,
      witness.testInputs,
    );
  }
}
