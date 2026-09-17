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
    expect(registry.inventory()).toEqual([
      { name: "exec_command", namespace: null },
      { name: "wait_agent", namespace: "multi_agent_v1" },
    ]);
    expect(registry.describe()).toEqual({
      fingerprint: registry.fingerprint,
      tools: [
        {
          name: "exec_command",
          namespace: null,
          description: "Run one command.",
          parameters: command.parameters,
        },
        {
          name: "wait_agent",
          namespace: "multi_agent_v1",
          description: null,
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
      unsupported: [],
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
    ).toThrow("CODEX_TOOL_SCHEMA_UNSUPPORTED_UNEVALUATEDPROPERTIES");
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

  it("reports unsupported host entries without granting them", () => {
    const registry = CodexNativeToolRegistry.parse([
      command,
      { type: "web_search", name: "search" },
      { type: "local_shell" },
    ]);

    expect(registry.describe().unsupported).toEqual([
      { type: "web_search", name: "search" },
      { type: "local_shell", name: null },
    ]);
    expect(() => registry.resolve({ name: "search", arguments: {} })).toThrow(
      "CODEX_TOOL_NOT_ADVERTISED",
    );
  });

  it("accepts a bounded installed-host catalogue without widening one schema", () => {
    const catalogue = Array.from({ length: 96 }, (_value, index) => ({
      ...command,
      name: `native_tool_${index}`,
      description: `Native host tool ${index}. ${"x".repeat(3_000)}`,
    }));

    expect(CodexNativeToolRegistry.parse(catalogue).inventory()).toHaveLength(
      96,
    );

    const oversized = Array.from({ length: 100 }, (_value, index) => ({
      ...command,
      name: `oversized_tool_${index}`,
      description: "x".repeat(8_000),
    }));
    expect(() => CodexNativeToolRegistry.parse(oversized)).toThrow(
      "CODEX_TOOL_CATALOGUE_TOO_LARGE",
    );
  });

  it("validates recursive 2020-12 host schemas through local refs", () => {
    const registry = CodexNativeToolRegistry.parse([
      {
        type: "function",
        name: "create_tree",
        parameters: {
          $defs: {
            node: {
              type: "object",
              properties: {
                value: { type: "string" },
                children: {
                  type: "array",
                  items: { $ref: "#/$defs/node" },
                },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
          type: "object",
          properties: { root: { $ref: "#/$defs/node" } },
          required: ["root"],
          additionalProperties: false,
        },
      },
    ]);

    expect(
      registry.resolve({
        name: "create_tree",
        arguments: {
          root: {
            value: "root",
            children: [{ value: "child", children: [] }],
          },
        },
      }),
    ).toMatchObject({ name: "create_tree" });
    expect(() =>
      registry.resolve({
        name: "create_tree",
        arguments: { root: { value: "root", children: [{ value: 7 }] } },
      }),
    ).toThrow("CODEX_TOOL_ARGUMENTS_INVALID");
  });
});
