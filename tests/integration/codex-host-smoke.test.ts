import { describe, expect, it } from "vitest";

import {
  runCodexHostSmoke,
  type CodexAppServerPeer,
} from "../../src/apps/desktop/codex-host-smoke";

type RequestHandler = (params: unknown) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

class SmokePeer implements CodexAppServerPeer {
  readonly requests: Readonly<{ method: string; params: unknown }>[] = [];
  private requestHandler: RequestHandler | null = null;
  private notificationHandler: NotificationHandler | null = null;
  toolResponse: unknown = null;
  toolError: unknown = null;

  constructor(
    private readonly options: Readonly<{
      models?: readonly string[];
      toolThreadId?: string;
    }> = {},
  ) {}

  handleServerRequest(_method: string, handler: RequestHandler): () => void {
    this.requestHandler = handler;
    return () => {
      this.requestHandler = null;
    };
  }

  handleNotification(
    _method: string,
    handler: NotificationHandler,
  ): () => void {
    this.notificationHandler = handler;
    return () => {
      this.notificationHandler = null;
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "model/list") {
      return {
        data: (this.options.models ?? ["gpt-6-astra"]).map((id) => ({ id })),
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      return {
        model: "gpt-6-astra",
        thread: { id: "thread-parent", parentThreadId: null },
      };
    }
    if (method === "turn/start") {
      const input = params as { input?: readonly { text?: string }[] };
      const nonce = /nonce ([a-z0-9-]+)/u.exec(
        input.input?.[0]?.text ?? "",
      )?.[1];
      queueMicrotask(() => {
        void (async () => {
          try {
            this.toolResponse = await this.requestHandler?.({
              threadId: this.options.toolThreadId ?? "thread-parent",
              turnId: "turn-parent",
              callId: "call-ping",
              tool: "farol_next_ping",
              arguments: { nonce },
            });
          } catch (error) {
            this.toolError = error;
          } finally {
            this.notificationHandler?.({
              threadId: "thread-parent",
              turn: {
                id: "turn-parent",
                status: "completed",
                items: [],
              },
            });
          }
        })();
      });
      return {
        turn: { id: "turn-parent", status: "inProgress", items: [] },
      };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

const input = {
  model: "gpt-6-astra",
  cwd: "/private/tmp/farol-next-host",
  nonce: "nonce-a1",
  timeoutMs: 1_000,
} as const;

describe("Codex host live smoke", () => {
  it("runs one correlated dynamic tool turn without workspace roots, writes, or model fallback", async () => {
    const peer = new SmokePeer();

    await expect(runCodexHostSmoke(peer, input)).resolves.toEqual({
      model: "gpt-6-astra",
      threadState: "completed",
      dynamicToolCalls: 1,
    });

    expect(peer.requests.map((request) => request.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(peer.requests[1]?.params).toMatchObject({
      model: "gpt-6-astra",
      allowProviderModelFallback: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      environments: [],
      dynamicTools: [
        {
          type: "function",
          name: "farol_next_ping",
        },
      ],
    });
    expect(peer.toolResponse).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "FAROL_NEXT_PING_OK" }],
    });
  });

  it("refuses to fall back to an installed chatgpt-web model", async () => {
    const peer = new SmokePeer({ models: ["chatgpt-web/pro"] });

    await expect(runCodexHostSmoke(peer, input)).rejects.toThrow(
      "CODEX_HOST_MODEL_UNAVAILABLE",
    );
    expect(peer.requests.map((request) => request.method)).toEqual([
      "model/list",
    ]);
  });

  it("fails a dynamic tool request from a foreign thread", async () => {
    const peer = new SmokePeer({ toolThreadId: "thread-foreign" });

    await expect(runCodexHostSmoke(peer, input)).rejects.toThrow(
      "CODEX_HOST_SMOKE_CORRELATION",
    );
  });
});
