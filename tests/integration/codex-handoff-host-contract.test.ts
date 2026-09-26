import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCodexHandoffHostContract } from "../../src/apps/desktop/codex-host-contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const fields = (...names: string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, {}]));
const typed = (type: string) => ({ type });
const optional = (type: string) => ({ type: [type, "null"] });
const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
const nullableRef = (name: string) => ({ anyOf: [ref(name), typed("null")] });
const list = (name: string) => ({ type: "array", items: ref(name) });
const thread = () => ({
  properties: {
    id: typed("string"),
    projectId: optional("string"),
    cwd: { allOf: [ref("AbsolutePathBuf")] },
    model: optional("string"),
    parentThreadId: optional("string"),
  },
});

async function changeSchema(
  root: string,
  name: string,
  change: (schema: Record<string, any>) => void,
): Promise<void> {
  const file = path.join(root, name);
  const schema = JSON.parse(await fs.readFile(file, "utf8")) as Record<
    string,
    any
  >;
  change(schema);
  await fs.writeFile(file, `${JSON.stringify(schema)}\n`);
}

async function schemaRoot(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-handoff-host-schema-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "v2"));
  const files: Record<string, unknown> = {
    "v2/ThreadStartParams.json": {
      properties: {
        projectId: optional("string"),
        cwd: optional("string"),
        ephemeral: optional("boolean"),
        model: optional("string"),
        allowProviderModelFallback: typed("boolean"),
        sandbox: nullableRef("SandboxMode"),
        approvalPolicy: nullableRef("AskForApproval"),
        dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
      },
    },
    "DynamicToolCallParams.json": {
      required: ["threadId", "turnId", "callId", "tool", "arguments"],
    },
    "ServerRequest.json": {
      oneOf: [{ properties: { method: { enum: ["item/tool/call"] } } }],
    },
    "ClientRequest.json": {
      oneOf: [
        "thread/compact/start",
        "project/list",
        "thread/start",
        "thread/read",
        "thread/turns/list",
        "turn/start",
      ].map((method) => ({
        required: ["id", "method", "params"],
        properties: {
          method: { enum: [method] },
          params: ref(
            {
              "project/list": "ProjectListParams",
              "thread/start": "ThreadStartParams",
              "thread/read": "ThreadReadParams",
              "thread/turns/list": "ThreadTurnsListParams",
              "turn/start": "TurnStartParams",
            }[method] ?? "ThreadCompactStartParams",
          ),
        },
      })),
    },
    "v2/ThreadListParams.json": {
      properties: fields("parentThreadId", "ancestorThreadId"),
    },
    "v2/ProjectListResponse.json": {
      properties: { data: list("Project"), nextCursor: optional("string") },
      definitions: {
        Project: {
          properties: { id: typed("string"), roots: list("ProjectRoot") },
        },
        ProjectRoot: { properties: { path: ref("AbsolutePathBuf") } },
      },
    },
    "v2/ProjectListParams.json": {
      properties: { cursor: optional("string"), limit: optional("integer") },
    },
    "v2/ThreadStartResponse.json": {
      properties: {
        thread: ref("Thread"),
        cwd: ref("AbsolutePathBuf"),
        model: typed("string"),
        sandbox: { allOf: [ref("SandboxPolicy")] },
        approvalPolicy: ref("AskForApproval"),
      },
      definitions: { Thread: thread() },
    },
    "v2/TurnStartParams.json": {
      properties: {
        threadId: typed("string"),
        input: list("UserInput"),
        cwd: optional("string"),
        model: optional("string"),
        effort: nullableRef("ReasoningEffort"),
        sandboxPolicy: nullableRef("SandboxPolicy"),
        approvalPolicy: nullableRef("AskForApproval"),
      },
    },
    "v2/TurnStartResponse.json": {
      properties: { turn: ref("Turn") },
      definitions: { Turn: { properties: { id: typed("string") } } },
    },
    "v2/ThreadReadParams.json": {
      properties: { threadId: typed("string"), includeTurns: typed("boolean") },
    },
    "v2/ThreadReadResponse.json": {
      properties: { thread: ref("Thread") },
      definitions: {
        Thread: thread(),
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
    "v2/ThreadTurnsListParams.json": {
      properties: {
        threadId: typed("string"),
        cursor: optional("string"),
        limit: optional("integer"),
        itemsView: nullableRef("TurnItemsView"),
      },
    },
    "v2/ThreadTurnsListResponse.json": {
      properties: { data: list("Turn"), nextCursor: optional("string") },
      definitions: {
        Turn: {
          properties: { id: typed("string"), status: ref("TurnStatus") },
        },
      },
    },
    ...overrides,
  };
  await Promise.all(
    Object.entries(files).map(([relativePath, value]) =>
      fs.writeFile(
        path.join(root, relativePath),
        `${JSON.stringify(value)}\n`,
        {
          mode: 0o600,
        },
      ),
    ),
  );
  return root;
}

describe("installed Codex saved-project handoff schema", () => {
  it("recognizes the exact project-bound create and metadata-only status methods", async () => {
    const root = await schemaRoot();
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).resolves.toMatchObject({
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      projectBoundCreateStatus: true,
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("binds the ClientRequest capability check to its hashed bytes", async () => {
    const root = await schemaRoot();
    const before = await inspectCodexHandoffHostContract(
      root,
      "codex-cli 0.153.4",
    );
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.description = "same methods, different source bytes";
    });
    const after = await inspectCodexHandoffHostContract(
      root,
      "codex-cli 0.153.4",
    );
    expect(after.schemaSha256).not.toBe(before.schemaSha256);
  });

  it("refuses a host without project-bound thread creation", async () => {
    const root = await schemaRoot({
      "v2/ThreadStartParams.json": {
        properties: {
          dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
          ...fields(
            "cwd",
            "ephemeral",
            "model",
            "allowProviderModelFallback",
            "sandbox",
            "approvalPolicy",
          ),
        },
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host without project discovery", async () => {
    const root = await schemaRoot({
      "ClientRequest.json": {
        oneOf: [
          "thread/compact/start",
          "thread/start",
          "thread/read",
          "thread/turns/list",
          "turn/start",
        ].map((method) => ({ properties: { method: { enum: [method] } } })),
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host without exact turn status metadata", async () => {
    const root = await schemaRoot({
      "v2/ThreadTurnsListResponse.json": {
        properties: fields("data", "nextCursor"),
        definitions: { Turn: { properties: fields("id") } },
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host that cannot request metadata-only thread reads", async () => {
    const root = await schemaRoot({
      "v2/ThreadReadParams.json": { properties: fields("threadId") },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses symlinked schema evidence", async () => {
    const root = await schemaRoot();
    const file = path.join(root, "v2/ProjectListResponse.json");
    const source = path.join(root, "source.json");
    await fs.writeFile(source, "{}\n", { mode: 0o600 });
    await fs.rm(file);
    await fs.symlink(source, file);
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_SCHEMA_UNSAFE");
  });

  it("refuses a wrong project binding type", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadStartParams.json", (schema) => {
      schema.properties.projectId = false;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a method with mismatched parameter schema", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      const method = schema.oneOf.find((entry: any) =>
        entry.properties.method.enum.includes("thread/start"),
      );
      method.properties.params = ref("TurnStartParams");
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a method whose parameters are optional in the host schema", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      const method = schema.oneOf.find((entry: any) =>
        entry.properties.method.enum.includes("thread/start"),
      );
      method.required = ["id", "method"];
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a read response with a missing thread payload or model", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.properties.thread = false;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.properties.thread = ref("Thread");
      schema.definitions.Thread.properties.model = false;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a symlinked schema directory", async () => {
    const root = await schemaRoot();
    await fs.rename(path.join(root, "v2"), path.join(root, "real-v2"));
    await fs.symlink(path.join(root, "real-v2"), path.join(root, "v2"));
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_SCHEMA_UNSAFE");
  });
});
