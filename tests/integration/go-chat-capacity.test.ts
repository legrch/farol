import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createGoChatResponses } from "../../apps/desktop/go-chat-responses.ts";
import { startRouteBRuntime } from "../../src/apps/desktop/route-b-runtime.ts";
import { startGoChatResponsesFixture } from "./fixtures/go-chat-responses-process.ts";

// Ordinary HTTP admission + actual Go five-slot owner. Browser and Go journal
// are controlled doubles. Completed responses do not grant result ACK or reuse.
it("keeps a sixth HTTP request queued behind five unacknowledged Go slots", async () => {
  const peer = await startGoChatResponsesFixture("text");
  const root = await mkdtemp(path.join(tmpdir(), "farol-go-capacity-"));
  const create = vi.spyOn(peer.chat, "create");
  const prepare = vi.spyOn(peer.chat, "prepare");
  const send = vi.spyOn(peer.chat, "send");
  const legacy = vi.fn(async () => {
    throw new Error("Unexpected legacy route");
  });
  const transport = createGoChatResponses({
    chat: peer.chat,
    caller: peer.caller,
    resolveCreate: () => ({
      selection: peer.selection,
      resolution: peer.resolution,
      required: peer.required,
    }),
  });
  const runtime = await startRouteBRuntime({
    stateRoot: root,
    surfaces: { surfaceFor: legacy },
    goResponses: transport,
    compaction: {
      compact: async () => {
        throw new Error("Unexpected compaction");
      },
    },
  });
  const post = (ordinal: number, signal?: AbortSignal) =>
    fetch(`${runtime.endpoint.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "chatgpt",
        stream: true,
        input: "Controlled queue question",
        tools: [],
        client_metadata: {
          session_id: "session",
          thread_id: `thread-${ordinal}`,
          turn_id: "turn",
          root_turn_id: "root",
        },
      }),
      ...(signal ? { signal } : {}),
    });
  const waiting = new AbortController();
  try {
    for (let n = 0; n < 5; n++) {
      const response = await post(n);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Useful before tool.");
      expect(body).toContain("response.completed");
    }
    let sixthSettled = false;
    const sixth = post(5, waiting.signal);
    void sixth.then(
      () => {
        sixthSettled = true;
      },
      () => {
        sixthSettled = true;
      },
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(6));
    await expect(prepare.mock.results[5]!.value).rejects.toMatchObject({
      state: "refused",
      code: "CHAT_CAPACITY",
    });
    expect(transport.activeResponses).toBe(1);
    expect(sixthSettled).toBe(false);
    expect(create).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenCalledTimes(5);
    const handle = await create.mock.results[5]!.value;
    expect((await peer.chat.submission(handle)).state).toBe("not-dispatched");
    expect(legacy).not.toHaveBeenCalled();
    // Exact test-owned pending request is cancelled, not replaced or retried.
    waiting.abort();
    await expect(sixth).rejects.toThrow();
    await vi.waitFor(() => expect(transport.activeResponses).toBe(0));
  } finally {
    waiting.abort();
    await runtime.close();
    const receipt = await peer.close();
    expect(receipt.serverEOF).toBe(true);
    expect(receipt.physicalSendAttempts).toBe(5);
    expect(receipt.acceptedSubmissions).toBe(5);
    expect(receipt.methods["chat.conversation.create"]).toEqual({
      attempts: 6,
      known: 6,
    });
    expect(receipt.methods["chat.conversation.prepare"]).toEqual({
      attempts: 6,
      known: 5,
    });
    expect(receipt.methods["chat.conversation.send"]).toEqual({
      attempts: 5,
      known: 5,
    });
    expect(receipt.commits.reserve).toBe(5);
    expect(receipt.commits.dispatch).toBe(5);
    expect(receipt.methods["chat.conversation.result.ack"]).toBeUndefined();
    await rm(root, { recursive: true });
  }
});
