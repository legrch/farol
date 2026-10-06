import { createHash } from "node:crypto";
import { createConnection } from "node:net";

import {
  CALLER_RELAY_MAX_FRAME_BYTES,
  CodexCallerRelayEndpointSchema,
  CodexCallerRelayOperationSchema,
  CodexCallerRelayResponseSchema,
  CodexCallerRelayWireResponseSchema,
  type CodexCallerRelayRequest,
  type CodexCallerRelayWireResponse,
  type CodexCallerRelayEndpoint,
  type CodexCallerRelayOperation,
  type CodexCallerRelayResponse,
} from "../../../src/pkg/caller-relay/protocol";

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

  async request(
    operation: CodexCallerRelayOperation,
  ): Promise<CodexCallerRelayResponse> {
    const parsed = CodexCallerRelayOperationSchema.parse(operation);
    // One monotonic budget spans the original response and its single receipt.
    const deadline = performance.now() + this.timeoutMs;
    const response = await this.exchange(
      { ...parsed, token: this.endpoint.token },
      deadline,
    );
    if (!response.ok) return response;
    if (
      response.operation !== parsed.operation ||
      (response.operation === "invoke" &&
        (parsed.operation !== "invoke" ||
          response.operationId !== parsed.operationId))
    ) {
      throw new Error("CALLER_RELAY_RESPONSE_INVALID");
    }
    if (response.operation === "invoke" && "receipt" in response) {
      if (parsed.operation !== "invoke")
        throw new Error("CALLER_RELAY_RESPONSE_INVALID");
      const receipt = response.receipt;
      if (
        receipt.operationId !== parsed.operationId ||
        receipt.binding !== parsed.binding ||
        receipt.outputBytes !== Buffer.byteLength(response.output, "utf8") ||
        receipt.outputSHA256 !==
          createHash("sha256").update(response.output, "utf8").digest("hex") ||
        Buffer.from(response.output, "utf8").toString("utf8") !==
          response.output
      ) {
        throw new Error("CALLER_RELAY_RESPONSE_INVALID");
      }
      // Private trusted-client message, not a MCP operation. One send through
      // the SAME endpoint; no retry, reconnect or second tool dispatch on loss.
      const acknowledgement = await this.exchange(
        {
          ...receipt,
          operation: "received",
          ticket: parsed.ticket,
          token: this.endpoint.token,
        },
        deadline,
      );
      if (
        !acknowledgement.ok ||
        acknowledgement.operation !== "received" ||
        acknowledgement.operationId !== receipt.operationId ||
        acknowledgement.receiptId !== receipt.receiptId
      ) {
        throw new Error("CALLER_RELAY_RECEIPT_UNKNOWN");
      }
      // Strip private receipt fields before model-facing content/structuredContent.
      return CodexCallerRelayResponseSchema.parse({
        ok: true,
        operation: "invoke",
        operationId: response.operationId,
        output: response.output,
      });
    }
    return CodexCallerRelayResponseSchema.parse(response);
  }

  private exchange(
    request: CodexCallerRelayRequest,
    deadline: number,
  ): Promise<CodexCallerRelayWireResponse> {
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded) > CALLER_RELAY_MAX_FRAME_BYTES) {
      return Promise.reject(new Error("CALLER_RELAY_REQUEST_TOO_LARGE"));
    }
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0)
      return Promise.reject(new Error("CALLER_RELAY_TIMEOUT"));
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.endpoint.socketPath });
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (
        result:
          | Readonly<{ ok: true; value: CodexCallerRelayWireResponse }>
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
        remaining,
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
          const response = CodexCallerRelayWireResponseSchema.parse(
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
