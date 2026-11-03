import fs from "node:fs/promises";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";

// Exercise the actual admission prefix without starting an app or model.
const source = await fs.readFile("src/apps/desktop/main.ts", "utf8");
const start = source.indexOf("async function configureAdmittedProduct(");
const end = source.indexOf("  switch (command.kind)", start);
if (start < 0 || end < 0) throw Error("CONFIGURATION_ADMISSION_MISSING");
const prefix = `${source.slice(start, end)}\nreturn { allowed: true };\n}`;
const code = transformSync(prefix, { loader: "ts", target: "es2022" }).code;

it.each(["host.run-codex-smoke", "host.run-codex-agent-check"])(
  "refuses %s before host launch or settings changes",
  async (kind) => {
    const configurationFailure = vi.fn((error) => ({ ok: false, error }));
    const configuration = new Proxy(
      {},
      {
        get: () => {
          throw Error("HOST_ACCESSED");
        },
      },
    );
    const run = vm.runInNewContext(`${code}\nconfigureAdmittedProduct`, {
      configuration,
      configurationFailure,
    }) as (command: { kind: string }) => Promise<unknown>;
    await expect(run({ kind })).resolves.toEqual({
      ok: false,
      error: "CODEX_HOST_MODEL_UNAVAILABLE",
    });
    expect(configurationFailure).toHaveBeenCalledExactlyOnceWith(
      "CODEX_HOST_MODEL_UNAVAILABLE",
    );
  },
);

it("leaves the separate ChatGPT route eligible for its normal checks", async () => {
  const run = vm.runInNewContext(`${code}\nconfigureAdmittedProduct`, {
    configuration: {},
    configurationFailure: () => {
      throw Error("UNEXPECTED_REFUSAL");
    },
  }) as (command: { kind: string }) => Promise<unknown>;
  await expect(run({ kind: "host.run-route-b-check" })).resolves.toEqual({
    allowed: true,
  });
});
