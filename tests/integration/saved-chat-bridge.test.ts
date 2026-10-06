import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SavedChatBridgeClient } from "../../apps/desktop/computer-mcp/saved-chat-bridge-client";
import { startSavedChatBridge } from "../../src/apps/desktop/saved-chat-bridge";
import type { PersistentChatGptHandoff } from "../../src/modules/chat/app/service/persistent-chatgpt-handoff";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";

const conversationUrl =
  "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
const admit = async () => ({
  admitted: true as const,
  release: async () => {},
});

describe("app-owned saved-chat bridge", () => {
  // The preserved native owned-socket RED proves Node's public server.close()
  // can unlink a replacement pathname before application cleanup. No private
  // handle internals or pathname juggling is accepted as a workaround.
  it.todo("replacement-inode cleanup remains NOT_QUALIFIED on this Node host");

  it("routes one create and a separate status over the exact endpoint", async () => {
    const key = randomUUID();
    let creates = 0;
    const service: Pick<PersistentChatGptHandoff, "create" | "status"> = {
      async create(request) {
        creates += 1;
        return {
          status: "verified",
          dispatchId: request.key,
          conversationUrl,
          titleVerified: false,
        };
      },
      async status(dispatchId) {
        return {
          status: "verified",
          dispatchId,
          conversationUrl,
          titleVerified: false,
        };
      },
    };
    const bridge = await startSavedChatBridge(service, admit);
    try {
      const client = new SavedChatBridgeClient(bridge.endpoint);
      expect(
        await client.request({
          operation: "create",
          request: { key, title: "Test", firstMessage: "One harmless message" },
        }),
      ).toEqual({
        status: "verified",
        dispatchId: key,
        conversationUrl,
        titleVerified: false,
      });
      expect(
        await client.request({
          operation: "status",
          dispatchId: key,
          recheck: true,
        }),
      ).toMatchObject({ status: "verified", dispatchId: key });
      const escapedKey = randomUUID();
      expect(
        await client.request({
          operation: "create",
          request: {
            key: escapedKey,
            title: "Escaped message",
            firstMessage: '"'.repeat(8192),
          },
        }),
      ).toMatchObject({ status: "verified", dispatchId: escapedKey });
      expect(creates).toBe(2);
    } finally {
      await bridge.close();
    }
  });

  it("refuses an invalid token before any browser effect", async () => {
    let creates = 0;
    const bridge = await startSavedChatBridge(
      {
        async create(request) {
          creates += 1;
          return { status: "outcome_unknown", dispatchId: request.key };
        },
        async status() {
          return { status: "unknown" };
        },
      },
      admit,
    );
    try {
      const client = new SavedChatBridgeClient({
        ...bridge.endpoint,
        token: "0".repeat(64),
      });
      expect(
        await client.request({
          operation: "create",
          request: {
            key: randomUUID(),
            title: "Test",
            firstMessage: "Must not send",
          },
        }),
      ).toEqual({ status: "unknown" });
      expect(creates).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("does not cancel an admitted create when its caller disconnects", async () => {
    const key = randomUUID();
    let resolveCreate: (() => void) | undefined;
    let admitted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    let creates = 0;
    let completed = false;
    let releases = 0;
    const bridge = await startSavedChatBridge(
      {
        async create(request) {
          creates += 1;
          admitted?.();
          await release;
          completed = true;
          return { status: "outcome_unknown", dispatchId: request.key };
        },
        async status(dispatchId) {
          return completed
            ? { status: "outcome_unknown", dispatchId }
            : { status: "unknown" };
        },
      },
      async () => ({
        admitted: true,
        release: async () => {
          releases += 1;
        },
      }),
    );
    try {
      const socket = createConnection({ path: bridge.endpoint.socketPath });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `${JSON.stringify({ operation: "create", token: bridge.endpoint.token, request: { key, title: "Test", firstMessage: "One" } })}\n`,
      );
      await started;
      socket.destroy();
      expect(releases).toBe(0);
      resolveCreate?.();
      const client = new SavedChatBridgeClient(bridge.endpoint);
      await expect(
        client.request({
          operation: "status",
          dispatchId: key,
          recheck: false,
        }),
      ).resolves.toEqual({ status: "outcome_unknown", dispatchId: key });
      expect(creates).toBe(1);
      expect(releases).toBe(2);
    } finally {
      resolveCreate?.();
      await bridge.close();
    }
  });

  it("keeps the desktop execution lease until a disconnected Browser operation ends", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-chat-fence-")),
    );
    await fs.chmod(root, 0o700);
    const fence = new PrivateExecutionFence({ root });
    const key = randomUUID();
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = await startSavedChatBridge(
      {
        async create(request) {
          started?.();
          await pending;
          return { status: "outcome_unknown", dispatchId: request.key };
        },
        async status() {
          return { status: "unknown" };
        },
      },
      () => fence.acquireAdmission(),
    );
    try {
      const socket = createConnection({ path: bridge.endpoint.socketPath });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `${JSON.stringify({ operation: "create", token: bridge.endpoint.token, request: { key, title: "Test", firstMessage: "One" } })}\n`,
      );
      await entered;
      socket.destroy();
      await expect(
        fence.raise({ operationId: randomUUID(), taskId: "summary" }),
      ).rejects.toThrow("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
      finish?.();
      const client = new SavedChatBridgeClient(bridge.endpoint);
      await client.request({
        operation: "status",
        dispatchId: key,
        recheck: false,
      });
      await expect(
        fence.raise({ operationId: randomUUID(), taskId: "summary" }),
      ).resolves.toBeUndefined();
    } finally {
      finish?.();
      await bridge.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not confirm bridge stop until admitted account work finishes", async () => {
    const key = randomUUID();
    let entered: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = await startSavedChatBridge(
      {
        async create(request) {
          entered?.();
          await pending;
          return { status: "outcome_unknown", dispatchId: request.key };
        },
        async status() {
          return { status: "unknown" };
        },
      },
      admit,
    );
    try {
      const client = new SavedChatBridgeClient(bridge.endpoint);
      const create = client.request({
        operation: "create",
        request: { key, title: "One", firstMessage: "One" },
      });
      await started;
      let stopped = false;
      const firstClose = bridge.close();
      const secondClose = bridge.close();
      expect(secondClose).toBe(firstClose);
      const closing = secondClose.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish?.();
      expect(await create).toEqual({
        status: "outcome_unknown",
        dispatchId: key,
      });
      await closing;
      expect(stopped).toBe(true);
      await expect(
        client.request({
          operation: "status",
          dispatchId: key,
          recheck: false,
        }),
      ).rejects.toThrow("SAVED_CHAT_BRIDGE_UNAVAILABLE");
    } finally {
      finish?.();
      await bridge.close();
    }
  });
});
