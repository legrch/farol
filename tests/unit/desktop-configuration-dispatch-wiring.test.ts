import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The product configuration dispatch lives in
// apps/desktop/configuration/dispatch.ts and is tested there with injected
// ports. Nothing else checks which main-process owner each port reads, that
// the E2E reply fault is still the one process-wide budget, or that every
// consumer still reaches the dispatch through main's old names, so a swapped
// accessor or a port left on a stale copy would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const dispatchSource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/configuration/dispatch.ts",
);

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function configurationDispatch() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = flat(source.slice(begin, source.indexOf("\n}\n", begin) + 2));
  return { source, body };
}

describe("configuration dispatch wiring in main", () => {
  it("lends the settings let as a late getter and keeps it declared", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain("configuration: () => configuration,");
    expect(source).toMatch(/\nlet configuration\b/);
    expect(source).toContain("let configurationDispatchCache");
  });

  it("lends each configuration accessor late, read at the moment a command arrives", async () => {
    const { body } = await factoryBody();
    for (const name of [
      "connectorCheck",
      "configurationDeep",
      "configurationComputer",
      "configurationChatgpt",
      "configurationSupport",
      "configurationConnector",
      "devProof",
      "configurationHost",
      "configurationModel",
    ])
      expect(body).toContain(`${name}: () => ${name}(),`);
    expect(body).toContain(
      "configureProductObserved: (value) => configurationObserved().configureProductObserved(value),",
    );
  });

  it("lends the helpers and the one reply fault by reference, never a copy", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "configurationFailure",
      "operationsStore",
      "configurationReplyFault",
    ])
      expect(body).toContain(` ${name},`);
    // The fault's dropped-reply count is one budget for the whole process.
    expect(
      source.match(
        /\nconst configurationReplyFault = createConfigurationReplyFault\(process\.env\);/g,
      ),
    ).toHaveLength(1);
    expect(source.match(/createConfigurationReplyFault\(/g)).toHaveLength(1);
  });

  it("keeps thin wrappers under the old names for every remaining caller", async () => {
    const { source } = await factoryBody();
    for (const wrapper of [
      "function configureProduct(value: unknown): Promise<ProductConfigurationResult> { return configurationDispatch().configureProduct(value); }",
      "function deliverConfigurationReply( commandKind: string, result: ProductConfigurationResult, ): ProductConfigurationResult | Promise<ProductConfigurationResult> { return configurationDispatch().deliverConfigurationReply(commandKind, result); }",
      "async function configureAdmittedProduct( command: ProductConfigurationCommand, ): Promise<ProductConfigurationResult> { return configurationDispatch().configureAdmittedProduct(command); }",
    ])
      expect(flat(source)).toContain(wrapper);
    // Each consumer still receives main's own function, not a dispatch member.
    expect(source).toContain("\n    configureProduct,\n");
    expect(source.match(/\n {4}configureAdmittedProduct,\n/g)).toHaveLength(3);
    expect(source.match(/\n {4}deliverConfigurationReply,\n/g)).toHaveLength(2);
  });

  it("no longer holds the dispatch's own bodies", async () => {
    const source = await readFile(mainSource, "utf8");
    for (const gone of [
      "farol-e2e:reply-dropped",
      "CODEX_HOST_MODEL_UNAVAILABLE",
      "switch (command.kind)",
      "ProductConfigurationCommandSchema",
      "async function configureProductObserved(",
    ])
      expect(source).not.toContain(gone);
  });

  it("imports nothing from the module trees", async () => {
    const source = await readFile(dispatchSource, "utf8");
    expect(source).not.toMatch(/from "[^"]*\/modules\//u);
  });
});
