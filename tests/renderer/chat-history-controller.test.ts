import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { ChatHistoryReplySchema } from "../../src/pkg/ipc/chat-history";
import { bootstrap, fixture, deferred } from "./fixture";
const context = { profileId: "profile", backendGeneration: "current" };
const entry = {
  key: { backendGeneration: "original", operationId: "operation" },
  turnId: "turn",
  turnGeneration: "1",
  resultId: "result",
  conversationId: "conversation",
};
const page = {
  context,
  value: { kind: "page", offset: 0, total: 1, entries: [entry] },
};
const controllers: WindowController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.restoreAllMocks();
});
async function setup() {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    chatHistoryContext: context,
  });
  const read = vi.fn(async (): Promise<unknown> => structuredClone(page));
  const c = new WindowController({ ...f.api, chatHistory: read });
  controllers.push(c);
  await c.start();
  return { f, c, read };
}
describe("renderer current-authorized history reads", () => {
  it("does no read on mount, uses its bootstrap context, and creates no command intent", async () => {
    const { c, read, f } = await setup();
    expect(read).not.toHaveBeenCalled();
    expect(await c.readChatHistory({ kind: "list", offset: 0 })).toEqual(page);
    expect(read).toHaveBeenCalledExactlyOnceWith({
      context,
      query: { kind: "list", offset: 0 },
    });
    expect(c.getSnapshot().intents).toEqual({});
    expect(c.getSnapshot().activity).toEqual([]);
    expect(f.api.configure).not.toHaveBeenCalled();
  });
  it.each(["incarnation", "revive", "runtime-gap", "dispose"])(
    "rejects late history after %s",
    async (fault) => {
      const { f, c, read } = await setup();
      const pending = deferred<unknown>();
      read.mockReturnValueOnce(pending.promise);
      const result = c.readChatHistory({ kind: "list", offset: 0 });
      const check = expect(result).rejects.toThrow("CHAT_HISTORY_STALE");
      if (fault === "dispose") c.dispose();
      else if (fault === "runtime-gap") {
        f.emit("runtime", {
          state: "offline",
          error: null,
          identity: null,
          embeddedNode: null,
          embeddedElectron: null,
        });
        await c.refresh();
      } else {
        vi.mocked(f.api.bootstrap).mockResolvedValueOnce({
          ...bootstrap(),
          chatHistoryContext:
            fault === "revive"
              ? null
              : { ...context, backendGeneration: "next" },
        });
        await c.refresh();
        if (fault === "revive") await c.refresh();
      }
      pending.resolve(page);
      await check;
    },
  );
  it.each([
    "configuration-error",
    "runtime-not-ready",
    "invalid-bootstrap",
    "changed-build",
  ])(
    "rejects pending history after bootstrap %s and recovery",
    async (fault) => {
      const { f, c, read } = await setup();
      const pending = deferred<unknown>();
      read.mockReturnValueOnce(pending.promise);
      const result = c.readChatHistory({ kind: "list", offset: 0 });
      const check = expect(result).rejects.toThrow("CHAT_HISTORY_STALE");
      const before = c.getSnapshot().chatHistoryEpoch;
      const failed = { ...bootstrap(), chatHistoryContext: context };
      vi.mocked(f.api.bootstrap).mockResolvedValueOnce(
        fault === "configuration-error"
          ? {
              ...failed,
              configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
            }
          : fault === "runtime-not-ready"
            ? { ...failed, runtimeState: "offline" }
            : fault === "invalid-bootstrap"
              ? { ...failed, schema: -1 }
              : {
                  ...failed,
                  build: { ...failed.build, buildId: "4".repeat(64) },
                },
      );
      await c.refresh();
      expect(c.getSnapshot().status).not.toBe("current");
      await c.refresh();
      expect(c.getSnapshot().status).toBe("current");
      pending.resolve(page);
      await check;
      expect(c.getSnapshot().chatHistoryEpoch).toBeGreaterThan(before);
    },
  );
  it.each([
    "context",
    "offset",
    "same-backend",
    "key",
    "duplicate",
    "live-handle",
  ])("rejects crossed %s", async (fault) => {
    const { c, read } = await setup();
    let value: unknown = structuredClone(page);
    if (fault === "context")
      value = { ...page, context: { ...context, backendGeneration: "other" } };
    if (fault === "offset")
      value = { ...page, value: { ...page.value, offset: 1, entries: [] } };
    if (fault === "same-backend")
      value = {
        ...page,
        value: {
          ...page.value,
          entries: [
            { ...entry, key: { ...entry.key, backendGeneration: "current" } },
          ],
        },
      };
    if (fault === "duplicate")
      value = {
        ...page,
        value: { ...page.value, total: 2, entries: [entry, entry] },
      };
    if (fault === "live-handle")
      value = { ...page, value: { ...page.value, handleId: "forged" } };
    if (fault === "key")
      value = {
        context,
        value: {
          kind: "result",
          entry: { ...entry, key: { ...entry.key, operationId: "crossed" } },
          text: "private",
        },
      };
    read.mockResolvedValueOnce(value);
    await expect(
      c.readChatHistory(
        fault === "key"
          ? { kind: "result", offset: 0, key: entry.key }
          : { kind: "list", offset: 0 },
      ),
    ).rejects.toThrow();
    expect(c.getSnapshot().activity).toEqual([]);
  });
  it("bounds Unicode and refuses malformed counters without throwing during safeParse", () => {
    for (const text of ["☀".repeat(2731), "\ud800"])
      expect(
        ChatHistoryReplySchema.safeParse({
          context,
          value: { kind: "result", entry, text },
        }).success,
      ).toBe(false);
    expect(
      ChatHistoryReplySchema.safeParse({
        context,
        value: {
          kind: "result",
          entry: { ...entry, turnGeneration: "bad" },
          text: "answer",
        },
      }).success,
    ).toBe(false);
    expect(
      ChatHistoryReplySchema.safeParse({
        context,
        value: { kind: "result", entry, text: "😀".repeat(2048) },
      }).success,
    ).toBe(true);
  });
});
