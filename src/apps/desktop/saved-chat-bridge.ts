import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { PersistentChatGptHandoff } from "../../modules/chat/app/service/persistent-chatgpt-handoff";
import {
  SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES,
  SAVED_CHAT_BRIDGE_PROTOCOL,
  SavedChatBridgeRequestSchema,
  SavedChatBridgeResponseSchema,
  type SavedChatBridgeEndpoint,
  type SavedChatBridgeResponse,
} from "../../pkg/saved-chat-bridge/protocol";

const SOCKET_BASENAME = "chat.sock";

function sameToken(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One app-owned local endpoint. A disconnected caller cannot cancel a Send. */
export async function startSavedChatBridge(
  service: Pick<PersistentChatGptHandoff, "create" | "status">,
  acquireAdmission: () => Promise<
    | Readonly<{ admitted: true; release(): Promise<void> }>
    | Readonly<{ admitted: false }>
  >,
): Promise<
  Readonly<{
    endpoint: SavedChatBridgeEndpoint;
    close(): Promise<void>;
  }>
> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-chat-"));
  await fs.chmod(root, 0o700);
  const socketPath = path.join(root, SOCKET_BASENAME);
  if (Buffer.byteLength(socketPath) > 100) {
    await fs.rmdir(root);
    throw new Error("SAVED_CHAT_SOCKET_PATH_TOO_LONG");
  }
  const token = randomBytes(32).toString("hex");
  const endpoint: SavedChatBridgeEndpoint = {
    protocol: SAVED_CHAT_BRIDGE_PROTOCOL,
    socketPath,
    token,
  };
  const sockets = new Set<Socket>();
  const active = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const server = createServer((socket) => {
    sockets.add(socket);
    let input = Buffer.alloc(0);
    let handled = false;
    const respond = (result: SavedChatBridgeResponse) => {
      if (socket.destroyed) return;
      socket.end(
        `${JSON.stringify(SavedChatBridgeResponseSchema.parse(result))}\n`,
      );
    };
    const unknown = () => respond({ status: "unknown" });
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES) {
        handled = true;
        unknown();
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      if (
        closing ||
        input.subarray(newline + 1).some((byte) => byte !== 0x20)
      ) {
        unknown();
        return;
      }
      let parsed: ReturnType<typeof SavedChatBridgeRequestSchema.safeParse>;
      try {
        parsed = SavedChatBridgeRequestSchema.safeParse(
          JSON.parse(input.subarray(0, newline).toString("utf8")),
        );
      } catch {
        unknown();
        return;
      }
      if (!parsed.success || !sameToken(token, parsed.data.token)) {
        unknown();
        return;
      }
      const request = parsed.data;
      const operation = (async () => {
        let lease:
          | Readonly<{ admitted: true; release(): Promise<void> }>
          | Readonly<{ admitted: false }>
          | undefined;
        try {
          lease = await acquireAdmission();
          if (!lease.admitted) {
            respond(
              request.operation === "create"
                ? {
                    status: "refused",
                    code: "SAVED_CHAT_ADMISSION_DENIED",
                    dispatchId: request.request.key,
                  }
                : { status: "outcome_unknown", dispatchId: request.dispatchId },
            );
            return;
          }
          const result =
            request.operation === "create"
              ? await service.create(request.request, () => !socket.destroyed)
              : await service.status(request.dispatchId, request.recheck);
          await lease.release();
          respond(SavedChatBridgeResponseSchema.parse(result));
        } catch {
          if (lease?.admitted) await lease.release().catch(() => undefined);
          respond(
            request.operation === "create"
              ? { status: "outcome_unknown", dispatchId: request.request.key }
              : { status: "outcome_unknown", dispatchId: request.dispatchId },
          );
        }
      })();
      active.add(operation);
      void operation.finally(() => active.delete(operation));
    });
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => sockets.delete(socket));
  });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await fs.unlink(socketPath).catch(() => undefined);
    await fs.rmdir(root).catch(() => undefined);
    throw error;
  }

  return {
    endpoint,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled([...active]);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Node may remove its Unix socket as part of server.close().
        await fs.unlink(socketPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        await fs.rmdir(root);
      })();
      return closePromise;
    },
  };
}
