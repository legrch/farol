import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectCodexHandoffHostContract,
  inspectCodexTaskTitleHostContract,
  inspectCodexProjectTasksHostContract,
} from "../../src/apps/desktop/codex-host-contract";

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
  required: ["id", "projectId", "cwd"],
  properties: {
    id: typed("string"),
    projectId: optional("string"),
    cwd: { allOf: [ref("AbsolutePathBuf")] },
    model: optional("string"),
    name: optional("string"),
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
        "thread/items/list",
        "turn/start",
        "turn/steer",
        "thread/name/set",
        "thread/list",
      ].map((method) => ({
        type: "object",
        required: ["id", "method", "params"],
        properties: {
          method: { type: "string", enum: [method] },
          params: ref(
            {
              "project/list": "ProjectListParams",
              "thread/start": "ThreadStartParams",
              "thread/read": "ThreadReadParams",
              "thread/turns/list": "ThreadTurnsListParams",
              "thread/items/list": "ThreadItemsListParams",
              "turn/start": "TurnStartParams",
              "turn/steer": "TurnSteerParams",
              "thread/name/set": "ThreadSetNameParams",
              "thread/list": "ThreadListParams",
            }[method] ?? "ThreadCompactStartParams",
          ),
        },
      })),
    },
    "v2/ThreadListParams.json": {
      properties: {
        ...fields("parentThreadId", "ancestorThreadId"),
        projectId: optional("string"),
        cwd: nullableRef("ThreadListCwdFilter"),
        useStateDbOnly: typed("boolean"),
        archived: optional("boolean"),
        cursor: optional("string"),
        limit: optional("integer"),
        sortKey: nullableRef("ThreadSortKey"),
        sortDirection: nullableRef("SortDirection"),
      },
    },
    "v2/ThreadListResponse.json": {
      required: ["data"],
      properties: { data: list("Thread"), nextCursor: optional("string") },
      definitions: {
        Thread: {
          ...thread(),
          required: ["id", "projectId", "cwd", "updatedAt"],
          properties: { ...thread().properties, updatedAt: typed("integer") },
        },
      },
    },
    "v2/ProjectListResponse.json": {
      required: ["data"],
      properties: { data: list("Project"), nextCursor: optional("string") },
      definitions: {
        Project: {
          required: ["id", "roots"],
          properties: { id: typed("string"), roots: list("ProjectRoot") },
        },
        ProjectRoot: {
          required: ["path"],
          properties: { path: ref("AbsolutePathBuf") },
        },
      },
    },
    "v2/ProjectListParams.json": {
      properties: { cursor: optional("string"), limit: optional("integer") },
    },
    "v2/ThreadStartResponse.json": {
      required: ["thread", "cwd", "model", "sandbox", "approvalPolicy"],
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
      required: ["threadId", "input"],
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
      required: ["turn"],
      properties: { turn: ref("Turn") },
      definitions: {
        Turn: { required: ["id"], properties: { id: typed("string") } },
      },
    },
    "v2/ThreadSetNameParams.json": {
      required: ["threadId", "name"],
      properties: { threadId: typed("string"), name: typed("string") },
    },
    "v2/ThreadSetNameResponse.json": {},
    "v2/TurnSteerParams.json": {
      required: ["threadId", "expectedTurnId", "input"],
      properties: {
        threadId: typed("string"),
        expectedTurnId: typed("string"),
        input: list("UserInput"),
        clientUserMessageId: optional("string"),
      },
    },
    "v2/TurnSteerResponse.json": {
      required: ["turnId"],
      properties: { turnId: typed("string") },
    },
    "v2/ThreadReadParams.json": {
      required: ["threadId"],
      properties: { threadId: typed("string"), includeTurns: typed("boolean") },
    },
    "v2/ThreadReadResponse.json": {
      required: ["thread"],
      properties: { thread: ref("Thread") },
      definitions: {
        Thread: thread(),
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
    "v2/ThreadTurnsListParams.json": {
      required: ["threadId"],
      properties: {
        threadId: typed("string"),
        cursor: optional("string"),
        limit: optional("integer"),
        itemsView: nullableRef("TurnItemsView"),
      },
    },
    "v2/ThreadTurnsListResponse.json": {
      required: ["data"],
      properties: { data: list("Turn"), nextCursor: optional("string") },
      definitions: {
        TurnStatus: {
          type: "string",
          enum: ["completed", "interrupted", "failed", "inProgress"],
        },
        Turn: {
          required: ["id", "status"],
          properties: { id: typed("string"), status: ref("TurnStatus") },
        },
      },
    },
    "v2/ThreadItemsListParams.json": {
      required: ["threadId"],
      properties: {
        threadId: typed("string"),
        turnId: optional("string"),
        cursor: optional("string"),
        limit: optional("integer"),
      },
    },
    "v2/ThreadItemsListResponse.json": {
      required: ["data"],
      properties: {
        data: list("ThreadItemEntry"),
        nextCursor: optional("string"),
      },
      definitions: {
        ThreadItemEntry: {
          required: ["item", "turnId"],
          properties: { item: ref("ThreadItem"), turnId: typed("string") },
        },
        ThreadItem: {
          oneOf: [
            {
              required: ["id", "text", "type"],
              properties: {
                id: typed("string"),
                text: typed("string"),
                type: { type: "string", enum: ["agentMessage"] },
                phase: nullableRef("MessagePhase"),
              },
            },
          ],
        },
        MessagePhase: {
          oneOf: [{ type: "string", enum: ["commentary", "final_answer"] }],
        },
      },
    },
    ...overrides,
  };
  for (const [name, value] of Object.entries(files)) {
    if (!name.startsWith("v2/")) continue;
    const schema = value as Record<string, any>;
    schema.type ??= "object";
    for (const definition of [
      "Project",
      "ProjectRoot",
      "Thread",
      "Turn",
      "ThreadItemEntry",
    ]) {
      if (schema.definitions?.[definition]) {
        schema.definitions[definition].type ??= "object";
      }
    }
  }
  const sharedDefinitions = {
    ThreadListCwdFilter: {
      anyOf: [typed("string"), { type: "array", items: typed("string") }],
    },
    ThreadSortKey: { type: "string", enum: ["updated_at", "created_at"] },
    SortDirection: { type: "string", enum: ["asc", "desc"] },
    SandboxMode: { type: "string", enum: ["read-only", "workspace-write"] },
    AskForApproval: {
      oneOf: [{ type: "string", enum: ["untrusted", "on-request"] }],
    },
    DynamicToolSpec: { type: "object" },
    UserInput: {
      oneOf: [
        {
          type: "object",
          required: ["type", "text"],
          properties: {
            type: { type: "string", enum: ["text"] },
            text: typed("string"),
          },
        },
      ],
    },
    ReasoningEffort: typed("string"),
    SandboxPolicy: {
      oneOf: [
        {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["readOnly"] },
            networkAccess: typed("boolean"),
          },
        },
        {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["workspaceWrite"] },
            networkAccess: typed("boolean"),
            writableRoots: list("AbsolutePathBuf"),
          },
        },
      ],
    },
    AbsolutePathBuf: typed("string"),
    TurnItemsView: { oneOf: [{ type: "string", enum: ["notLoaded"] }] },
  };
  const threadStart = files["v2/ThreadStartParams.json"] as Record<string, any>;
  threadStart.definitions = {
    SandboxMode: sharedDefinitions.SandboxMode,
    AskForApproval: sharedDefinitions.AskForApproval,
    DynamicToolSpec: sharedDefinitions.DynamicToolSpec,
  };
  const turnStart = files["v2/TurnStartParams.json"] as Record<string, any>;
  turnStart.definitions = {
    UserInput: sharedDefinitions.UserInput,
    ReasoningEffort: sharedDefinitions.ReasoningEffort,
    SandboxPolicy: sharedDefinitions.SandboxPolicy,
    AbsolutePathBuf: sharedDefinitions.AbsolutePathBuf,
    AskForApproval: sharedDefinitions.AskForApproval,
  };
  const turnSteer = files["v2/TurnSteerParams.json"] as Record<string, any>;
  turnSteer.definitions = { UserInput: sharedDefinitions.UserInput };
  const turnsList = files["v2/ThreadTurnsListParams.json"] as Record<
    string,
    any
  >;
  turnsList.definitions = { TurnItemsView: sharedDefinitions.TurnItemsView };
  const threadList = files["v2/ThreadListParams.json"] as Record<string, any>;
  threadList.definitions = {
    ThreadListCwdFilter: sharedDefinitions.ThreadListCwdFilter,
    ThreadSortKey: sharedDefinitions.ThreadSortKey,
    SortDirection: sharedDefinitions.SortDirection,
  };
  const client = files["ClientRequest.json"] as Record<string, any>;
  client.definitions = Object.fromEntries(
    [
      "ProjectListParams",
      "ThreadStartParams",
      "ThreadReadParams",
      "ThreadTurnsListParams",
      "ThreadItemsListParams",
      "TurnStartParams",
      "TurnSteerParams",
      "ThreadSetNameParams",
      "ThreadListParams",
    ].map((name) => {
      const { definitions: _definitions, ...shape } = files[
        `v2/${name}.json`
      ] as Record<string, unknown>;
      return [name, shape];
    }),
  );
  Object.assign(client.definitions, sharedDefinitions);
  for (const name of [
    "ProjectListResponse",
    "ThreadStartResponse",
    "ThreadReadResponse",
    "ThreadListResponse",
  ]) {
    const response = files[`v2/${name}.json`] as Record<string, any>;
    response.definitions.AbsolutePathBuf = sharedDefinitions.AbsolutePathBuf;
    if (name === "ThreadStartResponse") {
      response.definitions.SandboxPolicy = sharedDefinitions.SandboxPolicy;
    }
  }
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
  it("checks optional database-only project task metadata without qualifying the serving host", async () => {
    const root = await schemaRoot();
    expect(
      await inspectCodexProjectTasksHostContract(root, "codex-cli 0.153.4"),
    ).toMatchObject({ projectTaskMetadata: true });
  });
  it.each(["state-db-only", "cwd", "updated-at", "method"])(
    "refuses unqualified project task metadata shape: %s",
    async (mode) => {
      const root = await schemaRoot();
      if (mode === "state-db-only")
        await changeSchema(root, "v2/ThreadListParams.json", (schema) => {
          delete schema.properties.useStateDbOnly;
        });
      if (mode === "cwd")
        await changeSchema(root, "v2/ThreadListParams.json", (schema) => {
          schema.definitions.ThreadListCwdFilter = {
            type: "array",
            items: typed("string"),
          };
        });
      if (mode === "updated-at")
        await changeSchema(root, "v2/ThreadListResponse.json", (schema) => {
          schema.definitions.Thread.properties.updatedAt = typed("string");
        });
      if (mode === "method")
        await changeSchema(root, "ClientRequest.json", (schema) => {
          schema.oneOf = schema.oneOf.filter(
            (entry: any) => entry.properties.method.enum[0] !== "thread/list",
          );
        });
      await expect(
        inspectCodexProjectTasksHostContract(root, "codex-cli 0.153.4"),
      ).rejects.toThrow("CODEX_HOST_PROJECT_TASKS_UNAVAILABLE");
    },
  );
  it("checks the optional title setter without making it mandatory for ordinary tasks", async () => {
    const root = await schemaRoot();
    expect(
      await inspectCodexTaskTitleHostContract(root, "codex-cli 0.153.4"),
    ).toMatchObject({
      titleUpdate: true,
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await changeSchema(root, "v2/ThreadSetNameParams.json", (schema) => {
      schema.properties.name = typed("integer");
    });
    await expect(
      inspectCodexTaskTitleHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_TITLE_UNAVAILABLE");
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).resolves.toMatchObject({ projectBoundCreateStatus: true });
  });
  it.each(["method", "required", "response", "definition"])(
    "refuses unverified optional title contract: %s",
    async (mode) => {
      const root = await schemaRoot();
      if (mode === "method")
        await changeSchema(root, "ClientRequest.json", (schema) => {
          schema.oneOf = schema.oneOf.filter(
            (entry: any) =>
              entry.properties.method.enum[0] !== "thread/name/set",
          );
        });
      if (mode === "required") {
        await changeSchema(root, "v2/ThreadSetNameParams.json", (schema) => {
          schema.required = ["threadId"];
        });
        await changeSchema(root, "ClientRequest.json", (schema) => {
          schema.definitions.ThreadSetNameParams.required = ["threadId"];
        });
      }
      if (mode === "response")
        await changeSchema(root, "v2/ThreadSetNameResponse.json", (schema) => {
          schema.type = "string";
        });
      if (mode === "definition")
        await changeSchema(root, "ClientRequest.json", (schema) => {
          schema.definitions.ThreadSetNameParams.properties.name =
            typed("integer");
        });
      await expect(
        inspectCodexTaskTitleHostContract(root, "codex-cli 0.153.4"),
      ).rejects.toThrow("CODEX_HOST_TITLE_UNAVAILABLE");
    },
  );
  it.each(["missing", "wrong-type"])(
    "requires the supported nullable Thread.name readback field: %s",
    async (mode) => {
      const root = await schemaRoot();
      await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
        if (mode === "missing")
          delete schema.definitions.Thread.properties.name;
        else schema.definitions.Thread.properties.name = typed("integer");
        schema.definitions.Thread.properties.title = optional("string");
      });
      await expect(
        inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
      ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    },
  );
  it.skipIf(
    !process.env.FAROL_CODEX_SCHEMA_ROOT ||
      !process.env.FAROL_CODEX_SCHEMA_VERSION,
  )(
    "accepts a selected real generated schema without starting the host",
    async () => {
      const root = process.env.FAROL_CODEX_SCHEMA_ROOT;
      const version = process.env.FAROL_CODEX_SCHEMA_VERSION;
      if (!root || !version) throw new Error("SCHEMA_ROOT_REQUIRED");
      await expect(
        inspectCodexHandoffHostContract(root, version),
      ).resolves.toMatchObject({ projectBoundCreateStatus: true });
      await expect(
        inspectCodexTaskTitleHostContract(root, version),
      ).resolves.toMatchObject({ titleUpdate: true });
      await expect(
        inspectCodexProjectTasksHostContract(root, version),
      ).resolves.toMatchObject({ projectTaskMetadata: true });
    },
  );
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

  it("refuses active messaging when the selected host lacks exact turn/steer", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.oneOf = schema.oneOf.filter(
        (entry: { properties?: { method?: { enum?: string[] } } }) =>
          !entry.properties?.method?.enum?.includes("turn/steer"),
      );
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses result APIs without a typed final answer phase", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadItemsListResponse.json", (schema) => {
      schema.definitions.MessagePhase.oneOf[0].enum = ["commentary"];
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
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

  it("refuses a missing or mismatched embedded parameter definition", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      delete schema.definitions.ThreadStartParams;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.definitions.ThreadStartParams = {
        type: "object",
        properties: { projectId: false },
      };
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses missing or incompatible nested parameter definitions", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      delete schema.definitions.SandboxMode;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.definitions.SandboxMode = false;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.definitions.SandboxMode = {
        type: "string",
        enum: ["read-only", "workspace-write"],
      };
      delete schema.definitions.UserInput;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses an unusable turn status definition", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadTurnsListResponse.json", (schema) => {
      schema.definitions.TurnStatus = false;
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses matching but unusable sandbox policy definitions", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "ClientRequest.json", (schema) => {
      schema.definitions.SandboxPolicy = typed("string");
    });
    await changeSchema(root, "v2/TurnStartParams.json", (schema) => {
      schema.definitions.SandboxPolicy = typed("string");
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses sandbox variants with string type despite object properties", async () => {
    const root = await schemaRoot();
    for (const file of ["ClientRequest.json", "v2/TurnStartParams.json"]) {
      await changeSchema(root, file, (schema) => {
        for (const variant of schema.definitions.SandboxPolicy.oneOf) {
          variant.type = "string";
        }
      });
    }
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a status response whose outer type is not an object", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.type = "string";
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses optional status and turn payloads", async () => {
    const root = await schemaRoot();
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.required = [];
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.required = ["thread"];
      schema.definitions.Thread.required = ["id", "cwd"];
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
    await changeSchema(root, "v2/ThreadReadResponse.json", (schema) => {
      schema.definitions.Thread.required = ["id", "projectId", "cwd"];
    });
    await changeSchema(root, "v2/ThreadTurnsListResponse.json", (schema) => {
      schema.definitions.Turn.required = ["id"];
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
