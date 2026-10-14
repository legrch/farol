import { build } from "esbuild";
import { describe, it, expect } from "vitest";
import { assertPreviewRuntimeHostScope } from "../../tooling/preview-runtime-scope.mjs";
describe("local in-memory preview host scope", () => {
  it("validates the complete actual runtime dependency closure", async () => {
    const result = await build({
      entryPoints: ["src/apps/runtime/main.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      metafile: true,
      external: ["electron"],
    });
    expect(() => assertPreviewRuntimeHostScope(result.metafile)).not.toThrow();
  });
  it.each([
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "electron",
    "external-program",
  ])("rejects host-effect dependency %s", (path) => {
    expect(() =>
      assertPreviewRuntimeHostScope({
        outputs: { "runtime.cjs": { imports: [{ path, external: true }] } },
      }),
    ).toThrow("PREVIEW_RUNTIME_HOST_EFFECT_DEPENDENCY_REFUSED");
  });
});
