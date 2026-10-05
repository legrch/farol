import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  readChatHistoryView,
  type ChatHistoryHost,
} from "../../apps/desktop/chat-history-view";
import type { ChatHistoryResult } from "../../apps/desktop/bridge/wire";

const result = JSON.parse(
  readFileSync(
    new URL("../../api/desktop/v1/fixtures/chat-history.json", import.meta.url),
    "utf8",
  ),
) as ChatHistoryResult;
const summary = {
  key: result.key,
  binding: result.binding,
  resultId: result.resultId,
  conversationId: result.conversationId,
};
const context = { profileId: "profile", backendGeneration: "current" };
function fixture() {
  const history = {
    list: vi.fn(async () => ({
      offset: 0,
      total: 1,
      entries: [structuredClone(summary)],
    })),
    result: vi.fn(async () => structuredClone(result)),
  };
  const host: ChatHistoryHost = { historyContext: context, history };
  return { history, host };
}
describe("named historical desktop projection", () => {
  it("freshly resolves an exact ancestor without exposing authority or handles", async () => {
    const f = fixture();
    const p = await readChatHistoryView(() => f.host, {
      context,
      query: { kind: "list", offset: 0 },
    });
    const e = {
      key: result.key,
      turnId: result.binding.turnId,
      turnGeneration: result.binding.turnGeneration,
      resultId: result.resultId,
      conversationId: result.conversationId,
    };
    expect(p).toEqual({
      context,
      value: { kind: "page", offset: 0, total: 1, entries: [e] },
    });
    expect(
      await readChatHistoryView(() => f.host, {
        context,
        query: { kind: "result", offset: 0, key: result.key },
      }),
    ).toEqual({
      context,
      value: { kind: "result", entry: e, text: result.text },
    });
    expect(f.history.list).toHaveBeenCalledTimes(2);
    expect(f.history.result).toHaveBeenCalledExactlyOnceWith(summary);
  });
  it("rejects forged requests before reading and missing selection before result", async () => {
    const f = fixture();
    for (const request of [
      { context, query: { kind: "list", offset: 0, ownerId: "other" } },
      {
        context: { ...context, backendGeneration: "old" },
        query: { kind: "list", offset: 0 },
      },
    ])
      expect(await readChatHistoryView(() => f.host, request)).toHaveProperty(
        "error",
      );
    expect(f.history.list).not.toHaveBeenCalled();
    expect(
      await readChatHistoryView(() => f.host, {
        context,
        query: {
          kind: "result",
          offset: 0,
          key: { ...result.key, operationId: "missing" },
        },
      }),
    ).toEqual({ error: "CHAT_HISTORY_REFUSED" });
    expect(f.history.result).not.toHaveBeenCalled();
  });
  it.each(["list", "result"])(
    "suppresses late %s from a replaced host",
    async (stage) => {
      const f = fixture();
      let current: ChatHistoryHost | null = f.host;
      if (stage === "list")
        f.history.list.mockImplementationOnce(async () => {
          current = null;
          return { offset: 0, total: 1, entries: [summary] };
        });
      else
        f.history.result.mockImplementationOnce(async () => {
          current = null;
          return result;
        });
      expect(
        await readChatHistoryView(() => current, {
          context,
          query: { kind: "result", offset: 0, key: result.key },
        }),
      ).toEqual({ error: "CHAT_HISTORY_STALE" });
      expect(f.history.list).toHaveBeenCalledTimes(1);
      expect(f.history.result).toHaveBeenCalledTimes(stage === "list" ? 0 : 1);
    },
  );
});
