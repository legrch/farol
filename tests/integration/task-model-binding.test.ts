import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config";
import {
  PersistentCodexHandoff,
  type HandoffHost,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskPolicy } from "../fixtures/task-policy";

const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "4",
  inode: "11",
  gitCommonDirectory: "/fixture/repo/.git",
  project: {
    root: "/fixture/repo",
    device: "4",
    inode: "12",
    gitCommonDirectory: "/fixture/repo/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};

/** Real settings store/journal and MCP transport; the provider is in memory. */
describe("settings edit through MCP to the resolved task model", () => {
  it.each(["luna", "simple", "luna.v2"])(
    "reloads model data without changing the exact issued %s binding",
    async (initialAlias) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-model-dispatch-"),
      );
      const connections: Array<{ client: Client; close: () => Promise<void> }> =
        [];
      try {
        const store = new ProductSettingsStore({
          root: path.join(root, "settings"),
        });
        const configuration = new ProductConfigurationService(store);
        await configuration.initialize();
        const snapshot = configuration.snapshot();
        if (snapshot.status !== "ready")
          throw new Error("fixture setup failed");
        const tasks = taskPolicy();
        tasks.harnesses.codex!.models["luna.v2"] = {
          model: "fixture-dotted-alias",
          defaultEffort: "high",
        };
        tasks.harnesses.codex!.defaultModel = initialAlias;
        const originalModel =
          tasks.harnesses.codex!.models[initialAlias]!.model;
        const originalEffort =
          tasks.harnesses.codex!.models[initialAlias]!.defaultEffort;
        await store.save({ ...snapshot.settings, tasks });
        const journal = new PrivateCodexHandoffJournal(
          path.join(root, "handoffs"),
        );
        const authority = {
          async resolve() {
            return workspace;
          },
        };
        const calls: Array<{
          method: string;
          params: Record<string, unknown>;
        }> = [];
        const threads = new Map<
          string,
          { model: string; turns: Array<{ id: string; status: string }> }
        >();
        let sequence = 0;
        const host: HandoffHost = {
          async request(method, raw) {
            const params = raw as Record<string, unknown>;
            calls.push({ method, params });
            if (method === "project/list")
              return {
                data: [
                  { id: "project", roots: [{ path: workspace.project.root }] },
                ],
                nextCursor: null,
              };
            if (method === "thread/start") {
              expect(params.allowProviderModelFallback).toBe(false);
              const id = "thread-" + ++sequence;
              threads.set(id, { model: params.model as string, turns: [] });
              return {
                cwd: workspace.root,
                model: params.model,
                approvalPolicy: "on-request",
                sandbox: { type: "readOnly" },
                thread: { id, projectId: "project" },
              };
            }
            const threadId = params.threadId as string;
            const thread = threads.get(threadId);
            if (!thread) throw new Error("unknown fixture thread");
            if (method === "thread/read")
              return {
                thread: {
                  id: threadId,
                  model: thread.model,
                  projectId: "project",
                  cwd: workspace.root,
                },
              };
            if (method === "turn/start") {
              const turn = { id: "turn-" + ++sequence, status: "completed" };
              thread.turns.unshift(turn);
              return { turn };
            }
            if (method === "thread/turns/list")
              return {
                data: thread.turns.slice(0, params.limit as number),
                nextCursor: null,
              };
            throw new Error("unexpected fixture method: " + method);
          },
        };
        const service = new PersistentCodexHandoff(
          authority,
          host,
          journal,
          new Sha256HandoffRequestDigester(),
          Date.now() + 60_000,
          {
            run: async (preflight, effect) => {
              await preflight();
              return effect();
            },
          },
        );
        async function connect(continueQualified = false) {
          const loaded = (await store.load())!;
          const resolved = resolveOwnerTaskModel(loaded, { harness: "codex" });
          if (resolved.status !== "ready")
            throw new Error("model selection unavailable");
          const route = new AdmittedCodexTaskRoute(
            service,
            {
              workspaceId: "workspace",
              projectId: "project",
              harness: "codex",
              tasks: resolved.tasks,
              configSha256: resolved.configSha256,
              expiresAt: 2000,
            },
            () => 1000,
            { message: false, continue: continueQualified },
          );
          const server = createReadonlyComputerMcpServer(
            {
              async execute() {
                throw new Error("unexpected Computer call");
              },
            },
            {
              ownerId: "owner",
              sessionId: "session",
              taskId: "task",
              taskEpoch: 1,
              participantId: "main",
              turnId: "turn",
              generation: 1,
            },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            route,
          );
          const client = new Client({
            name: "config-dispatch-fixture",
            version: "1",
          });
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          await Promise.all([
            client.connect(clientTransport),
            server.connect(serverTransport),
          ]);
          connections.push({
            client,
            close: async () => {
              await client.close();
              await server.close();
            },
          });
          return client;
        }
        const firstClient = await connect();
        const firstKey = randomUUID();
        const created = await firstClient.callTool({
          name: "codex_task_create",
          arguments: {
            key: firstKey,
            workspaceId: "workspace",
            projectId: "project",
            message: "First fixture task",
          },
        });
        expect(created.structuredContent).toEqual({
          status: "dispatched",
          dispatchId: firstKey,
        });
        const first = await journal.read(firstKey);
        expect(first?.modelBinding?.selection).toMatchObject({
          harness: "codex",
          modelAlias: initialAlias,
          model: originalModel,
        });

        // Same executable code, new persisted config. No rebuild or provider call here.
        tasks.harnesses.codex!.models[initialAlias] = {
          model: "replacement-from-json",
          defaultEffort: "xhigh",
        };
        await store.save({ ...snapshot.settings, tasks });
        const secondClient = await connect(true);
        const secondKey = randomUUID();
        const createdNext = await secondClient.callTool({
          name: "codex_task_create",
          arguments: {
            key: secondKey,
            workspaceId: "workspace",
            projectId: "project",
            message: "Next fixture task",
          },
        });
        expect(createdNext.structuredContent).toEqual({
          status: "dispatched",
          dispatchId: secondKey,
        });
        const second = await journal.read(secondKey);
        expect(second).toMatchObject({
          model: "replacement-from-json",
          reasoningEffort: "xhigh",
        });
        expect(second?.modelBinding?.configSha256).not.toBe(
          first?.modelBinding?.configSha256,
        );

        const oldStatus = await secondClient.callTool({
          name: "codex_task_status",
          arguments: { dispatchId: firstKey },
        });
        expect(oldStatus.structuredContent).toEqual({
          status: "known",
          dispatchId: firstKey,
          turnStatus: "completed",
        });
        expect((await journal.read(firstKey))?.modelBinding).toEqual(
          first?.modelBinding,
        );
        expect(
          (await firstClient.listTools()).tools.map((tool) => tool.name),
        ).not.toContain("codex_task_continue");
        expect(
          (await secondClient.listTools()).tools.map((tool) => tool.name),
        ).toContain("codex_task_continue");
        const continuationKey = randomUUID();
        const continued = await secondClient.callTool({
          name: "codex_task_continue",
          arguments: {
            key: continuationKey,
            dispatchId: firstKey,
            message: "Continue original fixture task",
          },
        });
        expect(continued.structuredContent).toEqual({
          status: "dispatched",
          dispatchId: continuationKey,
        });
        expect(
          (
            await secondClient.callTool({
              name: "codex_task_continue",
              arguments: {
                key: continuationKey,
                dispatchId: firstKey,
                message: "Continue original fixture task",
              },
            })
          ).structuredContent,
        ).toEqual(continued.structuredContent);
        const continuation = await journal.read(continuationKey);
        expect(continuation?.continuedFrom).toBe(firstKey);
        expect(continuation?.continuationVerified).toBe(true);
        expect(continuation?.threadId).toBe(first?.threadId);
        expect(continuation?.modelBinding).toEqual(first?.modelBinding);
        expect(
          (
            await secondClient.callTool({
              name: "codex_task_status",
              arguments: { dispatchId: continuationKey },
            })
          ).structuredContent,
        ).toMatchObject({
          status: "known",
          dispatchId: continuationKey,
          turnStatus: "completed",
        });
        expect(
          (await secondClient.listTools()).tools.map((tool) => tool.name),
        ).not.toContain("codex_task_message");
        const turns = calls.filter((call) => call.method === "turn/start");
        expect(turns).toHaveLength(3);
        expect(turns[0]?.params.model).toBe(originalModel);
        expect(turns[1]?.params.model).toBe("replacement-from-json");
        if (originalEffort === undefined) {
          expect(turns[0]?.params).not.toHaveProperty("effort");
        } else {
          expect(turns[0]?.params.effort).toBe(originalEffort);
        }
        expect(turns[1]?.params.effort).toBe("xhigh");
        expect(turns[2]?.params.threadId).toBe(first?.threadId);
        expect(turns[2]?.params.model).toBe(originalModel);
        if (originalEffort === undefined) {
          expect(turns[2]?.params).not.toHaveProperty("effort");
        } else {
          expect(turns[2]?.params.effort).toBe(originalEffort);
        }
        expect(
          calls.filter((call) => call.method === "thread/start"),
        ).toHaveLength(2);
      } finally {
        for (const connection of connections) await connection.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
