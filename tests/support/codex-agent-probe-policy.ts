import { CodexNativeToolRegistry } from "../../src/apps/desktop/codex-native-tool-registry";

// TEST ONLY. This plan does not change the product's tool grants or launch
// policy. It distinguishes the host's catalogue from the two exact calls a
// deterministic synthetic provider is permitted to emit in a lineage probe.
const COLLABORATION = new Set([
  "spawn_agent",
  "send_input",
  "resume_agent",
  "wait_agent",
  "close_agent",
]);
const CATALOGUE_ONLY = new Set(["list", "read"]);
const DYNAMIC = new Set([
  "farol_agent_authority",
  "farol_agent_workspace_probe",
]);
const opaqueId = /^[A-Za-z0-9_-]{1,160}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CodexAgentProbePolicy {
  private readonly registry: CodexNativeToolRegistry;
  readonly catalogueOnly: readonly string[];

  constructor(tools: readonly unknown[]) {
    this.registry = CodexNativeToolRegistry.parse(tools);
    const catalogue = this.registry.describe();
    if (catalogue.unsupported.length > 0) {
      throw new Error("AGENT_PROBE_UNSUPPORTED_INVENTORY");
    }
    const catalogueOnly: string[] = [];
    for (const tool of catalogue.tools) {
      if (tool.namespace === "skills" && CATALOGUE_ONLY.has(tool.name)) {
        catalogueOnly.push(`skills.${tool.name}`);
      } else if (
        !(
          tool.namespace === "multi_agent_v1" && COLLABORATION.has(tool.name)
        ) &&
        !(tool.namespace === null && DYNAMIC.has(tool.name))
      ) {
        throw new Error("AGENT_PROBE_UNEXPECTED_INVENTORY");
      }
    }
    for (const name of ["spawn_agent", "wait_agent"]) {
      const matches = catalogue.tools.filter(
        (tool) => tool.namespace === "multi_agent_v1" && tool.name === name,
      );
      const schema = matches[0]?.parameters;
      if (
        matches.length !== 1 ||
        !record(schema) ||
        !record(schema.properties)
      ) {
        throw new Error("AGENT_PROBE_REQUIRED_SCHEMA_MISSING");
      }
      const properties = schema.properties;
      const requiredFields =
        name === "spawn_agent"
          ? ["message", "fork_context"]
          : ["targets", "timeout_ms"];
      if (requiredFields.some((field) => !Object.hasOwn(properties, field))) {
        throw new Error("AGENT_PROBE_REQUIRED_SCHEMA_MISSING");
      }
    }
    this.catalogueOnly = Object.freeze(catalogueOnly.sort());
  }

  spawn(message: string) {
    if (
      typeof message !== "string" ||
      message.length < 1 ||
      message.length > 8192
    ) {
      throw new Error("AGENT_PROBE_INPUT_INVALID");
    }
    return this.registry.resolve({
      name: "spawn_agent",
      namespace: "multi_agent_v1",
      arguments: {
        message,
        // Native spawn overrides validate against the built-in model catalogue.
        // A custom-provider parent instead supplies its route by inheritance.
        // The harness must prove both parent and child routes independently;
        // omission is not permission to accept a different model/provider.
        // Effort overrides have the same built-in-catalogue restriction.
        // The probe checks the effective effort on every provider request.
        fork_context: false,
      },
    });
  }

  wait(childId: string) {
    if (typeof childId !== "string" || !opaqueId.test(childId)) {
      throw new Error("AGENT_PROBE_INPUT_INVALID");
    }
    return this.registry.resolve({
      name: "wait_agent",
      namespace: "multi_agent_v1",
      arguments: { targets: [childId], timeout_ms: 10000 },
    });
  }
}
