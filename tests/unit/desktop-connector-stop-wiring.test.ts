import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The connector stop lives in apps/desktop/connector/stop.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads, that the wrappers main keeps still reach the one owner, or that
// the stop is still lent by its old name to every consumer, so a swapped getter
// or a port left on a stale copy would pass every other test. This asserts the
// wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function connectorStop() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("connector stop wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of ["secureMcpConnectorRuntime", "desktopGoCore"]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares the bridge's saved-chat cell by reference, not a copy of its value", async () => {
    const { body } = await read();
    expect(body).toContain(" saved: bridge.saved,");
    expect(body).not.toContain("bridge.saved.get()");
  });

  it("lends the function ports and builds the concrete lifecycle in main", async () => {
    const { body } = await read();
    expect(body).toContain(" operationsStore, statePaths,");
    expect(body).toContain(
      "createLifecycle: (secureMcpLaunch) => new PrivateMcpLifecycle(secureMcpLaunch),",
    );
  });

  it("builds the stop lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(connectorStopCache ??= createConnectorStop({");
    expect(source).toContain("let connectorStopCache");
  });

  it("keeps thin wrappers that delegate with every argument and no default of their own", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "function computerMcpLifecycle(): PrivateMcpLifecycle { return connectorStop().computerMcpLifecycle(); }",
    );
    expect(flat).toContain(
      'async function stopAndConfirmComputerMcp( ...args: Parameters< ReturnType<typeof connectorStop>["stopAndConfirmComputerMcp"] > ): Promise<void> { return connectorStop().stopAndConfirmComputerMcp(...args); }',
    );
  });

  it("no longer owns the lifecycle singleton or drains the connector itself", async () => {
    const { source } = await read();
    expect(source).not.toContain("desktopComputerMcpLifecycle");
    expect(source).not.toContain("drainComputerConnector");
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { source } = await read();
    // The installed-update host takes the stop as its connector stopper.
    expect(source).toContain("  stopConnector: stopAndConfirmComputerMcp,\n");
    // The supervisor, the connector check and the configuration drain take both.
    const flat = source.replace(/\s+/g, " ");
    expect(flat).toContain(" computerMcpLifecycle, stopAndConfirmComputerMcp,");
    expect(flat).toContain(" stopAndConfirmComputerMcp, computerMcpLifecycle,");
  });
});
