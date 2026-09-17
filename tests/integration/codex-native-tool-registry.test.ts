import { describe, expect, it } from "vitest";

import { CodexNativeToolRegistry } from "../../src/apps/desktop/codex-native-tool-registry";

const command = {
  type: "function",
  name: "exec_command",
  description: "Run one command.",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string", minLength: 1 } },
    required: ["cmd"],
    additionalProperties: false,
  },
  strict: true,
} as const;

describe("Codex native tool registry", () => {
  it("resolves only exact advertised top-level and namespaced schemas", () => {
    const registry = CodexNativeToolRegistry.parse([
      command,
      {
        type: "namespace",
        name: "multi_agent_v1",
        description: "Native child controls.",
        tools: [
          {
            type: "function",
            name: "wait_agent",
            parameters: {
              type: "object",
              properties: {
                targets: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  minItems: 1,
                },
              },
              required: ["targets"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);

    expect(
      registry.resolve({
        name: "exec_command",
        arguments: { cmd: "printf safe" },
      }),
    ).toMatchObject({
      name: "exec_command",
      namespace: null,
      encodedArguments: JSON.stringify({ cmd: "printf safe" }),
    });
    expect(
      registry.resolve({
        namespace: "multi_agent_v1",
        name: "wait_agent",
        arguments: { targets: ["agent-a"] },
      }),
    ).toMatchObject({
      name: "wait_agent",
      namespace: "multi_agent_v1",
    });

    expect(() =>
      registry.resolve({
        name: "wait_agent",
        arguments: { targets: ["agent-a"] },
      }),
    ).toThrow("CODEX_TOOL_NOT_ADVERTISED");
    expect(() =>
      registry.resolve({
        name: "exec_command",
        arguments: { cmd: "printf safe", sandbox_permissions: "full" },
      }),
    ).toThrow("CODEX_TOOL_ARGUMENTS_INVALID");
    expect(() =>
      registry.resolve({ name: "exec_command", arguments: { cmd: 7 } }),
    ).toThrow("CODEX_TOOL_ARGUMENTS_INVALID");
  });

  it("refuses ambiguous identities and unsupported schema semantics", () => {
    expect(() => CodexNativeToolRegistry.parse([command, command])).toThrow(
      "CODEX_TOOL_CATALOGUE_INVALID",
    );
    expect(() =>
      CodexNativeToolRegistry.parse([
        {
          ...command,
          parameters: {
            type: "object",
            unevaluatedProperties: false,
          },
        },
      ]),
    ).toThrow("CODEX_TOOL_SCHEMA_UNSUPPORTED");
    expect(() =>
      CodexNativeToolRegistry.parse([
        {
          ...command,
          parameters: {
            type: "object",
            properties: { cmd: { $ref: "https://example.test/schema" } },
          },
        },
      ]),
    ).toThrow("CODEX_TOOL_SCHEMA_UNSUPPORTED");
  });

  it("binds the fingerprint to the exact host catalogue", () => {
    const initial = CodexNativeToolRegistry.parse([command]);
    const changed = CodexNativeToolRegistry.parse([
      {
        ...command,
        parameters: {
          ...command.parameters,
          properties: { cmd: { type: "string", minLength: 2 } },
        },
      },
    ]);
    expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
  });
});
