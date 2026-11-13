// Co-located tests sit beside production source. This proves none of them is
// part of a build input graph or a packaged entry. The bundle table mirrors the
// production entry points in tooling/build.mjs; the build itself refuses a
// test input through the same assertNotTestInput guard in readBuildInput.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import {
  assertNotTestInput,
  isColocatedTest,
  isTestSource,
} from "../../tooling/test-placement.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const subject = "apps/desktop/host/paths.ts";
const colocated = "apps/desktop/host/paths.test.ts";

const node = { platform: "node", format: "cjs" };
const bundles = [
  [
    "src/apps/desktop/desktop-entry.ts",
    { ...node, external: ["electron", "original-fs"] },
  ],
  ["src/apps/runtime/main.ts", { ...node, external: ["electron"] }],
  ["apps/desktop/computer-mcp/main.ts", node],
  ["src/apps/desktop/preload.ts", { ...node, external: ["electron"] }],
  [
    "src/ui/renderer/entry.tsx",
    { platform: "browser", format: "iife", jsx: "automatic" },
  ],
];

async function inputsOf(entry, options) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    target: "es2022",
    ...options,
  });
  return Object.keys(result.metafile.inputs);
}

describe("co-located tests never reach the build", () => {
  it("names the subject and its test the way the placement rule does", () => {
    expect(isColocatedTest(colocated)).toBe(true);
    expect(isTestSource(subject)).toBe(false);
  });

  it.each([
    colocated,
    "src/ui/renderer/view.test.tsx",
    "src/modules/chat/domain/turn.test.mts",
    "tests/unit/anything.test.mjs",
  ])("the build input guard refuses %s", (file) => {
    expect(() => assertNotTestInput(file)).toThrow(
      `BUILD_INPUT_TEST_SOURCE:${file}`,
    );
  });

  it.each([
    subject,
    "src/ui/renderer/entry.tsx",
    "tooling/update-slot.mjs",
    "node_modules/zod/v4/core/test.test.js",
  ])("the build input guard admits %s", (file) => {
    expect(() => assertNotTestInput(file)).not.toThrow();
  });

  it.each(bundles)(
    "the %s bundle graph holds no test file",
    async (entry, options) => {
      const inputs = await inputsOf(entry, options);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs)
        expect(() => assertNotTestInput(input)).not.toThrow();
    },
  );

  it("bundles the moved subject while its co-located test stays out", async () => {
    const [entry, options] = bundles[0];
    const inputs = await inputsOf(entry, options);
    expect(inputs).toContain(subject);
    expect(inputs).not.toContain(colocated);
  });

  it("packages no test-named entry", () => {
    expect(BUILD_ENTRIES.filter(isTestSource)).toEqual([]);
  });
});
