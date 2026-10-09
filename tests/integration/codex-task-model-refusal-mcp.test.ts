import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PersistentCodexHandoff,
  type HandoffHost,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import type { CodexTaskRoute } from "../../src/modules/chat/contract/codex-task-route";
import { taskGrantPolicy } from "../fixtures/task-policy";
import { catalogueModel } from "../fixtures/codex-model-catalogue";

const binding = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: 1,
  participantId: "participant",
  turnId: "turn",
  generation: 1,
};
const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};
const available = {
  id: "picker-gpt-6-sol",
  model: "gpt-6-sol",
  displayName: "gpt-6-sol",
  hidden: false,
  supportedEfforts: ["high"],
  defaultEffort: "high",
};
const refused = {
  status: "refused",
  code: "TASK_MODEL_UNAVAILABLE",
  modelAvailability: {
    status: "refused",
    code: "TASK_MODEL_UNAVAILABLE",
    configuredModel: "gpt-6-luna",
    configuredEffort: "medium",
    available: "no",
    availableModels: [available],
  },
};

async function connected(route: CodexTaskRoute) {
  const server = createReadonlyComputerMcpServer(
    {
      execute: async () => {
        throw new Error("unexpected Computer call");
      },
    },
    binding,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    route,
  );
  const client = new Client({
    name: "task-model-refusal-fixture",
    version: "1",
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  return { client, server };
}

describe("actual Codex model refusal through the admitted MCP route", () => {
  for (const method of ["create", "continue"] as const)
    it(`preserves the known ${method} refusal and bounded catalogue before any effect`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-codex-refusal-"),
      );
      const calls: string[] = [];
      const parentId = randomUUID();
      const key = randomUUID();
      const host: HandoffHost = {
        async request(name) {
          calls.push(name);
          if (name === "model/list")
            return {
              data: [catalogueModel("gpt-6-sol", ["high"])],
              nextCursor: null,
            };
          if (name === "project/list")
            return {
              data: [
                {
                  id: "saved-project",
                  roots: [{ path: workspace.project.root }],
                },
              ],
              nextCursor: null,
            };
          if (name === "thread/read")
            return {
              thread: {
                id: "parent-thread",
                projectId: "saved-project",
                cwd: workspace.root,
                model: "gpt-6-luna",
              },
            };
          throw new Error(`unexpected native effect: ${name}`);
        },
      };
      const journal = new PrivateCodexHandoffJournal(
        path.join(root, "journal"),
      );
      try {
        if (method === "continue") {
          await journal.reserve(parentId, {
            requestDigest: "a".repeat(64),
            workspaceId: "writer",
            workspace,
            projectId: "saved-project",
            model: "gpt-6-luna",
            reasoningEffort: "medium",
            threadIntent: false,
            turnIntent: false,
          });
          expect(await journal.claimThread(parentId)).toBe(true);
          await journal.recordThread(parentId, "parent-thread");
          expect(await journal.claimTurn(parentId)).toBe(true);
          await journal.recordTurn(parentId, "parent-turn");
        }
        const handoff = new PersistentCodexHandoff(
          { resolve: async () => workspace },
          host,
          journal,
          new Sha256HandoffRequestDigester(),
          2000,
          {
            run: async () => {
              throw new Error("no mutation gate may run");
            },
          },
          () => 1000,
        );
        const route = new AdmittedCodexTaskRoute(
          handoff,
          {
            workspaceId: "writer",
            projectId: "saved-project",
            ...taskGrantPolicy(),
            expiresAt: 2000,
          },
          () => 1000,
          { message: false, continue: true },
        );
        const { client, server } = await connected(route);
        try {
          const response = await client.callTool({
            name: `codex_task_${method}`,
            arguments:
              method === "create"
                ? {
                    key,
                    workspaceId: "writer",
                    projectId: "saved-project",
                    message: "one create",
                  }
                : { key, dispatchId: parentId, message: "one follow-up" },
          });
          expect(response.structuredContent).toEqual(refused);
          expect(response.isError).toBe(true);
          expect(calls).toEqual(
            method === "create"
              ? ["model/list"]
              : ["project/list", "thread/read", "model/list"],
          );
          expect(await journal.read(key)).toBeNull();
        } finally {
          await client.close();
          await server.close();
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
});

describe("Codex model refusal evidence is closed and bounded", () => {
  const key = "41949674-C1E4-4A73-9098-4D31DA6E7AAA";
  for (const method of ["create", "continue"] as const) {
    async function invoke(value: unknown) {
      let calls = 0;
      const take = async () => {
        calls++;
        return value as Awaited<ReturnType<CodexTaskRoute["create"]>>;
      };
      const { client, server } = await connected({
        controlCapabilities: { message: false, continue: true },
        create: take,
        continue: take,
        message: async () => {
          throw new Error("unexpected steer");
        },
        status: async () => {
          throw new Error("unexpected status recovery");
        },
        result: async () => {
          throw new Error("unexpected result recovery");
        },
      });
      try {
        const response = await client.callTool({
          name: `codex_task_${method}`,
          arguments:
            method === "create"
              ? {
                  key,
                  workspaceId: "writer",
                  projectId: "saved-project",
                  message: "one create",
                }
              : { key, dispatchId: randomUUID(), message: "one follow-up" },
        });
        expect(calls).toBe(1);
        return response;
      } finally {
        await client.close();
        await server.close();
      }
    }
    for (const [name, value] of [
      [
        "unknown catalogue",
        {
          ...refused.modelAvailability,
          code: "TASK_MODEL_CATALOG_UNAVAILABLE",
          available: "unknown",
          availableModels: [],
        },
      ],
      [
        "unavailable effort",
        {
          ...refused.modelAvailability,
          code: "TASK_EFFORT_UNAVAILABLE",
          configuredModel: available.model,
          available: "yes",
        },
      ],
      [
        "omitted effort",
        { ...refused.modelAvailability, configuredEffort: undefined },
      ],
    ] as const)
      it(`keeps valid ${name} evidence on ${method}`, async () => {
        const expected = {
          status: "refused",
          code: value.code,
          modelAvailability: value,
        };
        const response = await invoke(expected);
        expect(response.structuredContent).toEqual(
          JSON.parse(JSON.stringify(expected)),
        );
        expect(response.isError).toBe(true);
      });
    for (const [name, value] of [
      [
        "unknown field",
        {
          ...refused.modelAvailability,
          privateTranscript: "PRIVATE TRANSCRIPT",
        },
      ],
      [
        "unsupported state",
        { ...refused.modelAvailability, status: "available" },
      ],
      [
        "crossed code",
        { ...refused.modelAvailability, code: "TASK_EFFORT_UNAVAILABLE" },
      ],
      [
        "oversized configured model",
        { ...refused.modelAvailability, configuredModel: "m".repeat(121) },
      ],
      [
        "oversized configured effort",
        { ...refused.modelAvailability, configuredEffort: "e".repeat(41) },
      ],
      [
        "impossible available state",
        { ...refused.modelAvailability, available: "yes" },
      ],
      [
        "partial unknown catalogue",
        { ...refused.modelAvailability, available: "unknown" },
      ],
      [
        "oversized catalogue",
        {
          ...refused.modelAvailability,
          availableModels: Array.from({ length: 2001 }, () => available),
        },
      ],
      [
        "duplicate model",
        {
          ...refused.modelAvailability,
          availableModels: [available, available],
        },
      ],
      [
        "private model field",
        {
          ...refused.modelAvailability,
          availableModels: [{ ...available, token: "PRIVATE TOKEN" }],
        },
      ],
      [
        "NUL model title",
        {
          ...refused.modelAvailability,
          availableModels: [{ ...available, displayName: "bad\0title" }],
        },
      ],
      [
        "oversized model title",
        {
          ...refused.modelAvailability,
          availableModels: [{ ...available, displayName: "n".repeat(241) }],
        },
      ],
      [
        "oversized effort set",
        {
          ...refused.modelAvailability,
          availableModels: [
            {
              ...available,
              supportedEfforts: Array.from({ length: 33 }, () => "high"),
            },
          ],
        },
      ],
      [
        "duplicate effort",
        {
          ...refused.modelAvailability,
          availableModels: [
            { ...available, supportedEfforts: ["high", "high"] },
          ],
        },
      ],
      [
        "unavailable default effort",
        {
          ...refused.modelAvailability,
          availableModels: [{ ...available, defaultEffort: "xhigh" }],
        },
      ],
    ] as const)
      it(`keeps ${name} on ${method} unknown instead of claiming no effect`, async () => {
        const response = await invoke({ ...refused, modelAvailability: value });
        expect(response.structuredContent).toEqual({
          status: "outcome_unknown",
          dispatchId: key,
        });
        expect(response.isError).toBe(true);
      });
  }
});

it("keeps Codex request UUID casing on real create, replay and read instead of importing Claude normalization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-codex-casing-"));
  const key = "41949674-C1E4-4A73-9098-4D31DA6E7AAA";
  const calls: string[] = [];
  const journal = new PrivateCodexHandoffJournal(path.join(root, "journal"));
  const host: HandoffHost = {
    async request(name) {
      calls.push(name);
      switch (name) {
        case "model/list":
          return {
            data: [catalogueModel("gpt-6-luna", ["medium"])],
            nextCursor: null,
          };
        case "project/list":
          return {
            data: [
              {
                id: "saved-project",
                roots: [{ path: workspace.project.root }],
              },
            ],
            nextCursor: null,
          };
        case "thread/start":
          return {
            cwd: workspace.root,
            model: "gpt-6-luna",
            approvalPolicy: "on-request",
            sandbox: { type: "readOnly" },
            thread: { id: "issued-thread", projectId: "saved-project" },
          };
        case "thread/read":
          return {
            thread: {
              id: "issued-thread",
              projectId: "saved-project",
              cwd: workspace.root,
              model: "gpt-6-luna",
              status: { type: "idle" },
            },
          };
        case "turn/start":
          return { turn: { id: "issued-turn" } };
        case "thread/turns/list":
          return {
            data: [{ id: "issued-turn", status: "completed" }],
            nextCursor: null,
          };
        case "thread/items/list":
          return {
            data: [
              {
                turnId: "issued-turn",
                item: {
                  id: "final-item",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Exact answer",
                },
              },
            ],
            nextCursor: null,
          };
        default:
          throw new Error(`unexpected fixture method: ${name}`);
      }
    },
  };
  const handoff = new PersistentCodexHandoff(
    { resolve: async () => workspace },
    host,
    journal,
    new Sha256HandoffRequestDigester(),
    2000,
    {
      run: async (preflight, effect) => {
        await preflight();
        return effect();
      },
    },
    () => 1000,
  );
  const route = new AdmittedCodexTaskRoute(
    handoff,
    {
      workspaceId: "writer",
      projectId: "saved-project",
      ...taskGrantPolicy(),
      expiresAt: 2000,
    },
    () => 1000,
  );
  const { client, server } = await connected(route);
  try {
    const request = {
      key,
      workspaceId: "writer",
      projectId: "saved-project",
      message: "one fixture task",
    };
    const first = await client.callTool({
      name: "codex_task_create",
      arguments: request,
    });
    expect(first.structuredContent).toEqual({
      status: "dispatched",
      dispatchId: key,
    });
    const before = [...calls];
    const replay = await client.callTool({
      name: "codex_task_create",
      arguments: request,
    });
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect(calls).toEqual(before);
    for (const name of ["codex_task_status", "codex_task_result"] as const) {
      const response = await client.callTool({
        name,
        arguments: { dispatchId: key },
      });
      expect(response.structuredContent).toMatchObject({
        status: name === "codex_task_status" ? "known" : "completed",
        dispatchId: key,
      });
      expect(response.isError).not.toBe(true);
    }
    // Journal paths are case insensitive, while the complete original request
    // digest remains exact. Altering that request must not reexecute a task.
    const conflicted = await client.callTool({
      name: "codex_task_create",
      arguments: { ...request, key: key.toLowerCase() },
    });
    expect(conflicted.structuredContent).toEqual({
      status: "refused",
      code: "HANDOFF_KEY_CONFLICT",
    });
    expect(calls.filter((name) => name === "thread/start")).toHaveLength(1);
    expect(calls.filter((name) => name === "turn/start")).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
