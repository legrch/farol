import { createConnection } from "node:net";

import {
  CALLER_RELAY_MAX_FRAME_BYTES,
  CodexCallerRelayEndpointSchema,
  CodexCallerRelayOperationSchema,
  CodexCallerRelayResponseSchema,
  type CodexCallerRelayEndpoint,
  type CodexCallerRelayOperation,
  type CodexCallerRelayResponse,
} from "../../pkg/caller-relay/protocol";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

export class CodexCallerRelayClient {
  private readonly endpoint: CodexCallerRelayEndpoint;
  private readonly timeoutMs: number;

  constructor(
    endpoint: CodexCallerRelayEndpoint,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.endpoint = CodexCallerRelayEndpointSchema.parse(endpoint);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > DEFAULT_TIMEOUT_MS
    ) {
      throw new Error("CALLER_RELAY_CLIENT_OPTIONS_INVALID");
    }
    this.timeoutMs = timeoutMs;
  }

  request(
    operation: CodexCallerRelayOperation,
  ): Promise<CodexCallerRelayResponse> {
    const parsed = CodexCallerRelayOperationSchema.parse(operation);
    const encoded = `${JSON.stringify({ ...parsed, token: this.endpoint.token })}\n`;
    if (Buffer.byteLength(encoded) > CALLER_RELAY_MAX_FRAME_BYTES) {
      return Promise.reject(new Error("CALLER_RELAY_REQUEST_TOO_LARGE"));
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.endpoint.socketPath });
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (
        result:
          | Readonly<{ ok: true; value: CodexCallerRelayResponse }>
          | Readonly<{ ok: false; error: Error }>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (result.ok) resolve(result.value);
        else reject(result.error);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: new Error("CALLER_RELAY_TIMEOUT") }),
        this.timeoutMs,
      );
      timer.unref?.();
      socket.once("connect", () => socket.write(encoded));
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > CALLER_RELAY_MAX_FRAME_BYTES) {
          finish({
            ok: false,
            error: new Error("CALLER_RELAY_RESPONSE_TOO_LARGE"),
          });
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (
          buffer
            .subarray(newline + 1)
            .toString("utf8")
            .trim().length > 0
        ) {
          finish({
            ok: false,
            error: new Error("CALLER_RELAY_RESPONSE_INVALID"),
          });
          return;
        }
        try {
          const response = CodexCallerRelayResponseSchema.parse(
            JSON.parse(buffer.subarray(0, newline).toString("utf8")),
          );
          finish({ ok: true, value: response });
        } catch {
          finish({
            ok: false,
            error: new Error("CALLER_RELAY_RESPONSE_INVALID"),
          });
        }
      });
      socket.once("error", () =>
        finish({ ok: false, error: new Error("CALLER_RELAY_UNAVAILABLE") }),
      );
      socket.once("end", () => {
        if (!settled) {
          finish({
            ok: false,
            error: new Error("CALLER_RELAY_RESPONSE_INVALID"),
          });
        }
      });
    });
  }
}
