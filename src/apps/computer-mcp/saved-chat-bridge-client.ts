import { createConnection } from "node:net";

import {
  SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES,
  SavedChatBridgeEndpointSchema,
  SavedChatBridgeOperationSchema,
  SavedChatBridgeResponseSchema,
  type SavedChatBridgeEndpoint,
  type SavedChatBridgeOperation,
  type SavedChatBridgeResponse,
} from "../../pkg/saved-chat-bridge/protocol";

const TIMEOUT_MS = 60_000;

/** One request per connection; a lost reply is never retried here. */
export class SavedChatBridgeClient {
  private readonly endpoint: SavedChatBridgeEndpoint;

  constructor(endpoint: SavedChatBridgeEndpoint) {
    this.endpoint = SavedChatBridgeEndpointSchema.parse(endpoint);
  }

  async request(
    operation: SavedChatBridgeOperation,
  ): Promise<SavedChatBridgeResponse> {
    const parsed = SavedChatBridgeOperationSchema.parse(operation);
    const encoded = `${JSON.stringify({ ...parsed, token: this.endpoint.token })}\n`;
    if (Buffer.byteLength(encoded) > SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES)
      throw new Error("SAVED_CHAT_BRIDGE_REQUEST_TOO_LARGE");
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.endpoint.socketPath });
      let input = Buffer.alloc(0);
      let settled = false;
      const finish = (value: SavedChatBridgeResponse | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const timer = setTimeout(
        () => finish(new Error("SAVED_CHAT_BRIDGE_TIMEOUT")),
        TIMEOUT_MS,
      );
      timer.unref?.();
      socket.once("connect", () => {
        if (!settled) socket.write(encoded);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        input = Buffer.concat([input, chunk]);
        if (input.length > SAVED_CHAT_BRIDGE_MAX_FRAME_BYTES) {
          finish(new Error("SAVED_CHAT_BRIDGE_RESPONSE_TOO_LARGE"));
          return;
        }
        const newline = input.indexOf(0x0a);
        if (newline < 0) return;
        if (input.subarray(newline + 1).some((byte) => byte !== 0x20)) {
          finish(new Error("SAVED_CHAT_BRIDGE_RESPONSE_INVALID"));
          return;
        }
        try {
          const response = SavedChatBridgeResponseSchema.parse(
            JSON.parse(input.subarray(0, newline).toString("utf8")),
          );
          const dispatchId =
            parsed.operation === "create"
              ? parsed.request.key
              : parsed.dispatchId;
          if ("dispatchId" in response && response.dispatchId !== dispatchId) {
            finish(new Error("SAVED_CHAT_BRIDGE_RESPONSE_INVALID"));
            return;
          }
          finish(response);
        } catch {
          finish(new Error("SAVED_CHAT_BRIDGE_RESPONSE_INVALID"));
        }
      });
      socket.once("error", () =>
        finish(new Error("SAVED_CHAT_BRIDGE_UNAVAILABLE")),
      );
      socket.once("end", () => {
        if (!settled) finish(new Error("SAVED_CHAT_BRIDGE_RESPONSE_INVALID"));
      });
      socket.once("close", () => {
        if (!settled) finish(new Error("SAVED_CHAT_BRIDGE_UNAVAILABLE"));
      });
    });
  }
}
