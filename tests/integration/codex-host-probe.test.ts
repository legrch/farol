import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeCodexHost,
  type CodexProbeRunner,
} from "../../src/apps/desktop/codex-host-probe";

import {
  inspectCodexHostContract,
  inspectCodexHandoffHostContract,
  inspectCodexFollowupHostContract,
} from "../../src/apps/desktop/codex-host-contract";

import * as hostContracts from "../../src/apps/desktop/codex-host-contract";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  executablePath: string;
  executableSha256: string;
  scratchRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-codex-probe-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const lib = path.join(root, "lib");
  await fs.mkdir(bin);
  await fs.mkdir(lib);
  const target = path.join(lib, "codex.js");
  const bytes = "#!/usr/bin/env node\n";
  await fs.writeFile(target, bytes, { mode: 0o755 });
  const executablePath = path.join(bin, "codex");
  await fs.symlink(target, executablePath);
  return {
    root,
    executablePath,
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
    scratchRoot: path.join(root, "scratch"),
  };
}

async function writeCompatibleSchema(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "v2"), { recursive: true });
  const files: Record<string, unknown> = {
    "v2/ThreadStartParams.json": {
      properties: {
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
      oneOf: [{ properties: { method: { enum: ["thread/compact/start"] } } }],
    },
    "v2/ThreadListParams.json": {
      properties: { parentThreadId: {}, ancestorThreadId: {} },
    },
    "v2/ThreadReadResponse.json": {
      definitions: {
        Thread: { properties: { parentThreadId: {} } },
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
  };
  await Promise.all(
    Object.entries(files).map(([relativePath, value]) =>
      fs.writeFile(
        path.join(root, relativePath),
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      ),
    ),
  );
}

// Synthetic schema bytes only. The selected fixture executable is never run.
async function writeTaskSchema(root: string, followup: boolean): Promise<void> {
  await writeCompatibleSchema(root);
  const typed = (type: string) => ({ type });
  const optional = (type: string) => ({ type: [type, "null"] });
  const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
  const nullable = (name: string) => ({ anyOf: [ref(name), typed("null")] });
  const list = (name: string) => ({ type: "array", items: ref(name) });
  const object = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({ type: "object", properties, required });
  const thread = object(
    {
      id: typed("string"),
      projectId: optional("string"),
      cwd: ref("AbsolutePathBuf"),
      model: optional("string"),
      name: optional("string"),
      parentThreadId: optional("string"),
    },
    ["id", "projectId", "cwd"],
  );
  const shared = {
    AbsolutePathBuf: typed("string"),
    DynamicToolSpec: { type: "object" },
    SandboxMode: { type: "string", enum: ["read-only", "workspace-write"] },
    AskForApproval: { type: "string", enum: ["untrusted", "on-request"] },
    ReasoningEffort: typed("string"),
    TurnItemsView: { type: "string", enum: ["notLoaded"] },
    SortDirection: { type: "string", enum: ["asc", "desc"] },
    UserInput: {
      oneOf: [
        object(
          { type: { type: "string", enum: ["text"] }, text: typed("string") },
          ["type", "text"],
        ),
      ],
    },
    SandboxPolicy: {
      oneOf: [
        object(
          {
            type: { type: "string", enum: ["readOnly"] },
            networkAccess: typed("boolean"),
          },
          ["type"],
        ),
        object(
          {
            type: { type: "string", enum: ["workspaceWrite"] },
            networkAccess: typed("boolean"),
            writableRoots: list("AbsolutePathBuf"),
          },
          ["type"],
        ),
      ],
    },
  };
  const files: Record<string, Record<string, unknown>> = {
    ProjectListParams: object({
      cursor: optional("string"),
      limit: optional("integer"),
    }),
    ProjectListResponse: {
      ...object({ data: list("Project"), nextCursor: optional("string") }, [
        "data",
      ]),
      definitions: {
        Project: object({ id: typed("string"), roots: list("ProjectRoot") }, [
          "id",
          "roots",
        ]),
        ProjectRoot: object({ path: ref("AbsolutePathBuf") }, ["path"]),
      },
    },
    ThreadStartParams: object({
      projectId: optional("string"),
      cwd: optional("string"),
      ephemeral: optional("boolean"),
      model: optional("string"),
      allowProviderModelFallback: typed("boolean"),
      sandbox: nullable("SandboxMode"),
      approvalPolicy: nullable("AskForApproval"),
      dynamicTools: { items: ref("DynamicToolSpec") },
    }),
    ThreadStartResponse: {
      ...object(
        {
          thread: ref("Thread"),
          cwd: ref("AbsolutePathBuf"),
          model: typed("string"),
          sandbox: ref("SandboxPolicy"),
          approvalPolicy: ref("AskForApproval"),
        },
        ["thread", "cwd", "model", "sandbox", "approvalPolicy"],
      ),
      definitions: { Thread: thread },
    },
    TurnStartParams: object(
      {
        threadId: typed("string"),
        input: list("UserInput"),
        cwd: optional("string"),
        model: optional("string"),
        effort: nullable("ReasoningEffort"),
        sandboxPolicy: nullable("SandboxPolicy"),
        approvalPolicy: nullable("AskForApproval"),
      },
      ["threadId", "input"],
    ),
    TurnStartResponse: {
      ...object({ turn: ref("Turn") }, ["turn"]),
      definitions: { Turn: object({ id: typed("string") }, ["id"]) },
    },
    TurnSteerParams: object(
      {
        threadId: typed("string"),
        expectedTurnId: typed("string"),
        input: list("UserInput"),
        clientUserMessageId: optional("string"),
      },
      ["threadId", "expectedTurnId", "input"],
    ),
    TurnSteerResponse: object({ turnId: typed("string") }, ["turnId"]),
    ThreadReadParams: object(
      { threadId: typed("string"), includeTurns: typed("boolean") },
      ["threadId"],
    ),
    ThreadReadResponse: {
      ...object({ thread: ref("Thread") }, ["thread"]),
      definitions: {
        Thread: thread,
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
    ThreadTurnsListParams: object(
      {
        threadId: typed("string"),
        cursor: optional("string"),
        limit: optional("integer"),
        itemsView: nullable("TurnItemsView"),
        ...(followup ? { sortDirection: nullable("SortDirection") } : {}),
      },
      ["threadId"],
    ),
    ThreadTurnsListResponse: {
      ...object({ data: list("Turn"), nextCursor: optional("string") }, [
        "data",
      ]),
      definitions: {
        Turn: object({ id: typed("string"), status: ref("TurnStatus") }, [
          "id",
          "status",
        ]),
        TurnStatus: {
          type: "string",
          enum: ["completed", "interrupted", "failed", "inProgress"],
        },
      },
    },
    ThreadItemsListParams: object(
      {
        threadId: typed("string"),
        turnId: optional("string"),
        cursor: optional("string"),
        limit: optional("integer"),
      },
      ["threadId"],
    ),
    ThreadItemsListResponse: {
      ...object(
        { data: list("ThreadItemEntry"), nextCursor: optional("string") },
        ["data"],
      ),
      definitions: {
        ThreadItemEntry: object(
          { item: ref("ThreadItem"), turnId: typed("string") },
          ["item", "turnId"],
        ),
        ThreadItem: {
          oneOf: [
            object(
              {
                id: typed("string"),
                text: typed("string"),
                type: { type: "string", enum: ["agentMessage"] },
                phase: nullable("MessagePhase"),
              },
              ["id", "text", "type"],
            ),
          ],
        },
        MessagePhase: { type: "string", enum: ["commentary", "final_answer"] },
      },
    },
  };
  for (const schema of Object.values(files)) {
    schema.definitions = {
      ...shared,
      ...(schema.definitions as Record<string, unknown> | undefined),
    };
  }
  const methods = {
    "project/list": "ProjectListParams",
    "thread/start": "ThreadStartParams",
    "thread/read": "ThreadReadParams",
    "thread/turns/list": "ThreadTurnsListParams",
    "thread/items/list": "ThreadItemsListParams",
    "turn/start": "TurnStartParams",
    "turn/steer": "TurnSteerParams",
  };
  const client = {
    oneOf: [
      { properties: { method: { enum: ["thread/compact/start"] } } },
      ...Object.entries(methods).map(([method, params]) =>
        object(
          { method: { type: "string", enum: [method] }, params: ref(params) },
          ["id", "method", "params"],
        ),
      ),
    ],
    definitions: {
      ...shared,
      ...Object.fromEntries(
        Object.entries(methods).map(([, name]) => {
          const shape = { ...files[name] };
          delete shape.definitions;
          return [name, shape];
        }),
      ),
    },
  };
  await fs.writeFile(
    path.join(root, "ClientRequest.json"),
    JSON.stringify(client),
  );
  await Promise.all(
    Object.entries(files).map(([name, schema]) =>
      fs.writeFile(
        path.join(root, "v2", `${name}.json`),
        JSON.stringify(schema),
      ),
    ),
  );
}

describe("Codex host probe", () => {
  it("refuses discovery byte drift before starting the executable", async () => {
    const selected = await fixture();
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
          expectedDiscovery: {
            canonicalPath: await fs.realpath(selected.executablePath),
            sha256: "f".repeat(64),
          },
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("proves one selected executable against a generated bounded schema", async () => {
    const selected = await fixture();
    const canonicalPath = await fs.realpath(selected.executablePath);
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      expect(command.executablePath).toBe(canonicalPath);
      expect(command.environment.PATH?.split(":")[0]).toBe(
        path.dirname(canonicalPath),
      );
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      expect(command.arguments.slice(0, 4)).toEqual([
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
      ]);
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      return { stdout: "", stderr: "" };
    });

    const result = await probeCodexHost(
      {
        executablePath: selected.executablePath,
        scratchRoot: selected.scratchRoot,
      },
      { run: runner },
    );

    expect(result).toMatchObject({
      executablePath: canonicalPath,
      executableSha256: selected.executableSha256,
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      capabilities: {
        dynamicTools: true,
        correlatedToolCalls: true,
        descendantObservation: true,
        collabObservation: true,
        compaction: true,
      },
    });
    expect(runner).toHaveBeenCalledTimes(2);
    await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
  });

  it("refuses a writable selected executable before starting it", async () => {
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.chmod(target, 0o777);
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_EXECUTABLE_UNSAFE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts an executable between the old 128 MiB cap and the new 512 MiB cap", async () => {
    // Real Codex binaries run 210-224 MiB; the old 128 MiB ceiling refused
    // every genuine install. Truncate creates a sparse file instantly —
    // reading it back still exercises the real chunked hash loop.
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.truncate(target, 200 * 1024 * 1024);
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      return { stdout: "", stderr: "" };
    });

    const result = await probeCodexHost(
      {
        executablePath: selected.executablePath,
        scratchRoot: selected.scratchRoot,
      },
      { run: runner },
    );

    expect(result.version).toBe("0.153.4");
    expect(runner).toHaveBeenCalledTimes(2);
  }, 120_000);

  it("refuses an executable over the 512 MiB cap before starting it", async () => {
    const selected = await fixture();
    const target = await fs.realpath(selected.executablePath);
    await fs.truncate(target, 512 * 1024 * 1024 + 1);
    const runner = vi.fn<CodexProbeRunner>();

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_EXECUTABLE_UNSAFE");
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps an incompatible generated contract without retaining schema files", async () => {
    const selected = await fixture();
    const runner = vi.fn<CodexProbeRunner>(async (command) => {
      if (command.arguments[0] === "--version") {
        return { stdout: "codex-cli 0.153.4\n", stderr: "" };
      }
      const schemaRoot = command.arguments[4];
      if (!schemaRoot) throw new Error("missing schema root");
      await writeCompatibleSchema(schemaRoot);
      await fs.writeFile(
        path.join(schemaRoot, "v2/ThreadStartParams.json"),
        '{"properties":{}}\n',
        { mode: 0o600 },
      );
      return { stdout: "", stderr: "" };
    });

    await expect(
      probeCodexHost(
        {
          executablePath: selected.executablePath,
          scratchRoot: selected.scratchRoot,
        },
        { run: runner },
      ),
    ).rejects.toThrow("CODEX_HOST_INCOMPATIBLE");
    await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
  });
});

function fakeSchemaRunner(
  write: (schemaRoot: string) => Promise<void>,
): ReturnType<typeof vi.fn<CodexProbeRunner>> {
  return vi.fn<CodexProbeRunner>(async (command) => {
    if (command.arguments[0] === "--version")
      return { stdout: "codex-cli 0.153.4\n", stderr: "" };
    expect(command.arguments.slice(0, 4)).toEqual([
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
    ]);
    const root = command.arguments[4];
    if (!root) throw new Error("missing fixture schema root");
    await write(root);
    return { stdout: "", stderr: "" };
  });
}

async function taskProbe(write: (root: string) => Promise<void>) {
  const selected = await fixture();
  const runner = fakeSchemaRunner(write);
  const result = await probeCodexHost(selected, { run: runner });
  expect(runner).toHaveBeenCalledTimes(2);
  await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
  return { result, selected, runner };
}

describe("Task source witnesses from the original generated schema run", () => {
  it("retains the exact valid base when Task schema files are missing", async () => {
    let base: Awaited<ReturnType<typeof inspectCodexHostContract>> | undefined;
    const { result, selected } = await taskProbe(async (root) => {
      await writeCompatibleSchema(root);
      base = await inspectCodexHostContract(root, "codex-cli 0.153.4");
    });
    const { taskSource, executablePath, executableSha256, ...contract } =
      result;
    expect(contract).toEqual(base);
    expect(taskSource.handoff).toEqual({
      executablePath,
      executableSha256: selected.executableSha256,
      baseSchemaSha256: result.schemaSha256,
      status: "unavailable",
      code: "CODEX_HOST_SCHEMA_UNSAFE",
    });
    expect(taskSource.followup).toEqual(taskSource.handoff);
    expect(executableSha256).toBe(selected.executableSha256);
  });

  it("returns real independent parser witnesses bound to one binary and base", async () => {
    let expectedHandoff:
      Awaited<ReturnType<typeof inspectCodexHandoffHostContract>> | undefined;
    let expectedFollowup:
      Awaited<ReturnType<typeof inspectCodexFollowupHostContract>> | undefined;
    const { result, selected } = await taskProbe(async (root) => {
      await writeTaskSchema(root, true);
      expectedHandoff = await inspectCodexHandoffHostContract(
        root,
        "codex-cli 0.153.4",
      );
      expectedFollowup = await inspectCodexFollowupHostContract(
        root,
        "codex-cli 0.153.4",
      );
    });
    const binding = {
      executablePath: await fs.realpath(selected.executablePath),
      executableSha256: selected.executableSha256,
      baseSchemaSha256: result.schemaSha256,
    };
    expect(result.taskSource.handoff).toEqual({
      ...binding,
      status: "supported",
      contract: expectedHandoff,
    });
    expect(result.taskSource.followup).toEqual({
      ...binding,
      status: "supported",
      contract: expectedFollowup,
    });
    expect(expectedHandoff?.schemaSha256).not.toBe(result.schemaSha256);
    expect(expectedFollowup?.schemaSha256).not.toBe(
      expectedHandoff?.schemaSha256,
    );
    expect(expectedFollowup?.baseSchemaSha256).toBe(
      expectedHandoff?.schemaSha256,
    );
  });

  it("keeps create/status supported when optional completed-parent follow-up is absent", async () => {
    const { result } = await taskProbe((root) => writeTaskSchema(root, false));
    expect(result.taskSource.handoff.status).toBe("supported");
    expect(result.taskSource.followup).toMatchObject({
      status: "unavailable",
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    });
    expect(result.taskSource.followup).not.toHaveProperty("contract");
  });

  it.each([
    ["invalid-json", "CODEX_HOST_SCHEMA_INVALID"],
    ["unsupported", "CODEX_HOST_HANDOFF_UNAVAILABLE"],
    ["linked", "CODEX_HOST_SCHEMA_UNSAFE"],
  ])(
    "classifies %s Task source without rejecting the unrelated valid base",
    async (mode, code) => {
      const { result } = await taskProbe(async (root) => {
        await writeTaskSchema(root, true);
        const file = path.join(root, "v2/ProjectListParams.json");
        if (mode === "invalid-json") await fs.writeFile(file, "{invalid");
        else if (mode === "unsupported") await fs.writeFile(file, "{}");
        else {
          await fs.rename(file, `${file}.fixture`);
          await fs.symlink(`${file}.fixture`, file);
        }
      });
      expect(result.protocol).toBe("codex-app-server/v2");
      expect(result.taskSource.handoff).toMatchObject({
        status: "unavailable",
        code,
      });
      expect(result.taskSource.followup).toMatchObject({
        status: "unavailable",
        code,
      });
      expect(result.taskSource.handoff).not.toHaveProperty("contract");
    },
  );

  it.each(["bytes", "selected-link"])(
    "refuses Task evidence after executable %s drift with no re-execution",
    async (mode) => {
      const selected = await fixture();
      const runner = fakeSchemaRunner(async (root) => {
        await writeTaskSchema(root, true);
        const target = await fs.realpath(selected.executablePath);
        if (mode === "bytes") await fs.appendFile(target, "// changed\n");
        else {
          const other = path.join(selected.root, "other");
          await fs.copyFile(target, other);
          await fs.chmod(other, 0o755);
          await fs.unlink(selected.executablePath);
          await fs.symlink(other, selected.executablePath);
        }
      });
      const result = await probeCodexHost(selected, { run: runner });
      expect(result.executableSha256).toBe(selected.executableSha256);
      expect(result.taskSource.handoff).toMatchObject({
        status: "unavailable",
        code: "CODEX_HOST_TASK_SOURCE_CHANGED",
      });
      expect(result.taskSource.followup).toEqual(result.taskSource.handoff);
      expect(runner).toHaveBeenCalledTimes(2);
      await expect(fs.readdir(selected.scratchRoot)).resolves.toEqual([]);
    },
  );

  it("refuses mixed Task snapshots even when each inspected shape is valid", async () => {
    const inspect = hostContracts.inspectCodexFollowupHostContract;
    vi.spyOn(
      hostContracts,
      "inspectCodexFollowupHostContract",
    ).mockImplementationOnce(async (root, version) => {
      const witness = await inspect(root, version);
      await fs.appendFile(path.join(root, "v2/ProjectListParams.json"), "\n");
      return witness;
    });
    const { result } = await taskProbe((root) => writeTaskSchema(root, true));
    expect(result.taskSource.handoff).toMatchObject({
      status: "unavailable",
      code: "CODEX_HOST_TASK_SOURCE_CHANGED",
    });
    expect(result.taskSource.followup).toEqual(result.taskSource.handoff);
  });

  it("contains unexpected parser diagnostics in an unavailable source result", async () => {
    vi.spyOn(
      hostContracts,
      "inspectCodexFollowupHostContract",
    ).mockRejectedValueOnce(new Error("private fixture diagnostic"));
    const { result } = await taskProbe((root) => writeTaskSchema(root, true));
    expect(result.taskSource.handoff.status).toBe("supported");
    expect(result.taskSource.followup).toMatchObject({
      status: "unavailable",
      code: "CODEX_HOST_TASK_SOURCE_UNCONFIRMED",
    });
    expect(JSON.stringify(result)).not.toContain("private fixture diagnostic");
  });
});
