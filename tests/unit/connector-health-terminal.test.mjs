import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract.ts";

// Execute the actual host branch with injected mechanics; no native child,
// tunnel, state writer or provider is reached by this regression fixture.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
let branch;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.value === "connector.check-health"
  )
    branch = source.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child);
    } else if (value?.type) visit(value);
  }
}
visit(tree);
if (!branch) throw new Error("CONNECTOR_HEALTH_CASE_MISSING");
const generation = "a".repeat(64);
function harness(observation, healthy = false) {
  const snapshot = {
    status: "ready",
    settings: {
      computer: { generation: 7 },
      connectors: {
        secureMcp: {
          generation: 3,
          runtime: {
            state: "ready",
            buildId: "build",
            computerGeneration: 7,
            connectorGeneration: 3,
            runtimeGeneration: generation,
          },
        },
      },
    },
  };
  const context = {
    command: { kind: "connector.check-health" },
    secureMcpConnectorRuntime: {
      checkHealth: vi.fn(async () => healthy),
      getTunnelObservation: vi.fn(() => observation),
    },
    connectorTaskAdmission: false,
    configuration: { snapshot: vi.fn(() => snapshot) },
    buildIdentity: { buildId: "build" },
    recordConnectorRuntime: vi.fn(async () => null),
    configurationFailure: (error) => {
      // The host branch uses a deliberately partial snapshot double. Validate
      // its outgoing error against the real contract with a valid error snapshot.
      const result = ProductConfigurationResultSchema.parse({
        ok: false,
        error,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      });
      return { ok: result.ok, error: result.error };
    },
    ProductConfigurationResultSchema: { parse: (value) => value },
  };
  const handle = vm.runInNewContext(
    stripTypeScriptTypes(
      `async function handle() { switch(command.kind) { ${branch} } } handle`,
    ),
    context,
  );
  return { handle, context, snapshot };
}

it("retains exact-generation terminal UNKNOWN instead of publishing unreachable", async () => {
  const h = harness({
    state: "outcome_unknown",
    runtimeGeneration: generation,
  });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "outcome_unknown",
    generation,
    7,
  );
  expect(h.context.connectorTaskAdmission).toBe(false);
});

it("classifies the dead tunnel without asserting anchor or process-group closure", async () => {
  const h = harness({ state: "exited", runtimeGeneration: generation });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_TUNNEL_EXITED",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "unreachable",
    generation,
    7,
  );
  expect(h.context.connectorTaskAdmission).toBe(false);
});

it("does not publish a different runtime's terminal observation into current Settings", async () => {
  const h = harness({ state: "exited", runtimeGeneration: "b".repeat(64) });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
  });
  expect(h.context.recordConnectorRuntime).not.toHaveBeenCalled();
});

it("does not hide UNKNOWN behind a successful asynchronous health probe", async () => {
  const h = harness(
    { state: "outcome_unknown", runtimeGeneration: generation },
    true,
  );
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "outcome_unknown",
    generation,
    7,
  );
});

it("does not hide a late tunnel exit behind a successful health probe", async () => {
  const h = harness({ state: "exited", runtimeGeneration: generation }, true);
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_TUNNEL_EXITED",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "unreachable",
    generation,
    7,
  );
});

it("does not turn a healthy current endpoint into a terminal operation", async () => {
  const h = harness(null, true);
  expect((await h.handle()).ok).toBe(true);
  expect(h.context.recordConnectorRuntime).not.toHaveBeenCalled();
});
