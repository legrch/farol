import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The E2E context fixture lives in apps/desktop/dev/fixture.ts and is tested
// there with injected ports. Nothing else checks which main-process owner each
// port is, that the one wrapper main keeps still reaches the module, or that
// the IPC table still gets it by its old name, so a port left on a stale copy
// or a fixture reachable outside the E2E gate would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const fixtureSource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/dev/fixture.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function contextFixture() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("context fixture wiring in main", () => {
  it("shares the const owners and the context module's functions by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      " env: process.env, demoMode, liveTaskRegistry, contextHost, contextBinding, contextModel, buildHostCompactionHandoff, }",
    );
    // The demo flag is fixed at launch by the launch host.
    expect(source).toMatch(
      /\nconst \{[^}]*\bdemoMode,[^}]*\} = readLaunchArguments\(/,
    );
    for (const owner of ["liveTaskRegistry", "contextHost", "contextModel"])
      expect(source).toMatch(new RegExp(`\\nconst ${owner}\\b`));
    expect(source).toMatch(/\nfunction contextBinding\(/);
    // The codec is the chat module's own, never a copy in main.
    expect(source).toContain(
      'import { buildHostCompactionHandoff } from "../../modules/chat/infra/client/host-compaction-codec";',
    );
  });

  it("builds the fixture lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(contextFixtureCache ??= createContextFixture({");
    expect(source).toContain("let contextFixtureCache");
  });

  it("keeps one thin wrapper that delegates to the fixture under the old name", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      'function runContextFixtureControl( taskId: string, action: "compact-context-fixture" | "confirm-context-fixture", ): Promise<unknown> { return contextFixture().runContextFixtureControl(taskId, action); }',
    );
  });

  it("no longer owns the history, the compaction or the confirmation", async () => {
    const { source } = await read();
    for (const moved of [
      "function contextFixtureHistory",
      "CONTEXT_FIXTURE_UNAVAILABLE",
      "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE",
      "context-receipt-",
      "receipt-context-epoch-",
      "responses_compact",
      "context-compact-",
      "context-confirm-",
      "buildHostCompactionHandoff(",
    ])
      expect(source).not.toContain(moved);
  });

  it("still lends the wrapper to the IPC table by its old name, behind the same control schema", async () => {
    const { flat } = await read();
    expect(flat).toContain(" controlSchema, runContextFixtureControl,");
    const control = await readFile(
      path.resolve(import.meta.dirname, "../../apps/desktop/shell/control.ts"),
      "utf8",
    );
    expect(control).toContain('"compact-context-fixture",');
    expect(control).toContain('"confirm-context-fixture",');
  });

  it("keeps the E2E gate and the demo refusal at the first statement of the control", async () => {
    const fixture = (await readFile(fixtureSource, "utf8")).replace(
      /\s+/g,
      " ",
    );
    expect(fixture).toContain(
      '): Promise<unknown> { if (env.FAROL_E2E !== "1" || demoMode) { return { error: "IPC_CONTROL_INVALID" }; } const task = liveTaskRegistry.get(taskId);',
    );
  });
});
