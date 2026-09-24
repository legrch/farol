import { describe, expect, it } from "vitest";
import { CodexAgentProbePolicy } from "../support/codex-agent-probe-policy";

// Reduced structural fixtures from the inventory-only 0.155.0-alpha.16.3
// observation. They are not evidence that a child or a skill was executed.
const spawn = {
  type: "function",
  name: "spawn_agent",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
      model: { type: "string" },
      reasoning_effort: { type: "string" },
      fork_context: { type: "boolean" },
    },
    additionalProperties: false,
  },
};
const wait = {
  type: "function",
  name: "wait_agent",
  parameters: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "string" } },
      timeout_ms: { type: "number" },
    },
    required: ["targets"],
    additionalProperties: false,
  },
};
const skill = (name: string) => ({
  type: "function",
  name,
  parameters: { type: "object", properties: {}, additionalProperties: false },
});
const namespace = (name: string, tools: readonly unknown[]) => ({
  type: "namespace",
  name,
  tools,
});
const inventory = () => [
  namespace("multi_agent_v1", [spawn, wait]),
  namespace("skills", [skill("list"), skill("read")]),
];

describe("synthetic native Agent probe policy", () => {
  it("records advertised skills without granting an invocation path", () => {
    const plan = new CodexAgentProbePolicy(inventory());
    expect(plan.catalogueOnly).toEqual(["skills.list", "skills.read"]);
    expect(Object.isFrozen(plan.catalogueOnly)).toBe(true);
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(plan)).sort(),
    ).toEqual(["constructor", "spawn", "wait"]);
    expect(plan.spawn("Read only the explicit synthetic task.")).toMatchObject({
      namespace: "multi_agent_v1",
      name: "spawn_agent",
      arguments: {
        message: "Read only the explicit synthetic task.",
        fork_context: false,
      },
    });
    expect(plan.spawn("Synthetic task").arguments).not.toHaveProperty("model");
    expect(plan.spawn("Synthetic task").arguments).not.toHaveProperty(
      "reasoning_effort",
    );
  });
  it("uses targets in wait_agent and never guesses old wait(ids)", () => {
    const plan = new CodexAgentProbePolicy(inventory());
    expect(plan.wait("owned-child-id")).toMatchObject({
      namespace: "multi_agent_v1",
      name: "wait_agent",
      arguments: { targets: ["owned-child-id"], timeout_ms: 10000 },
    });
    expect(
      () =>
        new CodexAgentProbePolicy([
          namespace("multi_agent_v1", [spawn, { ...wait, name: "wait" }]),
        ]),
    ).toThrow("AGENT_PROBE_UNEXPECTED_INVENTORY");
  });
  it("does not authorize other tools by namespace or matching name", () => {
    for (const extra of [
      namespace("skills", [skill("write")]),
      namespace("other", [spawn]),
      { ...spawn, name: "exec_command" },
      { ...spawn },
    ]) {
      expect(() => new CodexAgentProbePolicy([...inventory(), extra])).toThrow(
        "AGENT_PROBE_UNEXPECTED_INVENTORY",
      );
    }
  });
  it("requires fork controls without overriding the inherited route", () => {
    for (const key of ["fork_context", "message"]) {
      const properties: Record<string, unknown> = {
        ...spawn.parameters.properties,
      };
      delete properties[key];
      expect(
        () =>
          new CodexAgentProbePolicy([
            namespace("multi_agent_v1", [
              { ...spawn, parameters: { ...spawn.parameters, properties } },
              wait,
            ]),
          ]),
      ).toThrow("AGENT_PROBE_REQUIRED_SCHEMA_MISSING");
    }
  });
  it("validates generated arguments with the actual advertised schema", () => {
    const tools = [
      namespace("multi_agent_v1", [
        {
          ...spawn,
          parameters: {
            ...spawn.parameters,
            properties: {
              ...spawn.parameters.properties,
              fork_context: { type: "boolean", const: true },
            },
          },
        },
        wait,
      ]),
    ];
    const plan = new CodexAgentProbePolicy(tools);
    expect(() => plan.spawn("Synthetic task")).toThrow();
  });
  it("bounds input without granting a caller-selected provider or tool", () => {
    const plan = new CodexAgentProbePolicy(inventory());
    for (const value of ["", "x".repeat(8193)]) {
      expect(() => plan.spawn(value)).toThrow("AGENT_PROBE_INPUT_INVALID");
    }
    for (const value of ["", "../unowned", "x".repeat(161)]) {
      expect(() => plan.wait(value)).toThrow("AGENT_PROBE_INPUT_INVALID");
    }
  });
});
