import { describe, expect, it, vi } from "vitest";
import {
  readRetiredRepliesView,
  type RetiredReplyHost,
} from "../../apps/desktop/retired-replies-view";
import {
  storedPage,
  storedReply,
  storedSummary,
} from "../fixtures/recovery-archive";

const context = { profileId: "profile", backendGeneration: "current" };
function fixture() {
  const retiredReplies = {
    list: vi.fn(async (_after: string) => storedPage()),
    read: vi.fn(async (_key: string, _digest: string) => storedReply()),
  };
  const host: RetiredReplyHost = { historyContext: context, retiredReplies };
  return { host, retiredReplies };
}

describe("normal session stored-copy projection", () => {
  it("keeps unconfirmed list/read provenance without an effect or handoff", async () => {
    const f = fixture();
    expect(
      await readRetiredRepliesView(() => f.host, {
        context,
        query: { kind: "archive-list", after: "" },
      }),
    ).toEqual({
      context,
      result: {
        status: "ok",
        data: { kind: "archive-list", after: "", ...storedPage() },
      },
    });
    const entry = storedSummary();
    expect(
      await readRetiredRepliesView(() => f.host, {
        context,
        query: { kind: "archive-read", key: entry.key, digest: entry.digest },
      }),
    ).toEqual({
      context,
      result: {
        status: "ok",
        data: { kind: "archive-read", ...storedReply() },
      },
    });
    expect(f.retiredReplies.list).toHaveBeenCalledExactlyOnceWith("");
    expect(f.retiredReplies.read).toHaveBeenCalledExactlyOnceWith(
      entry.key,
      entry.digest,
    );
  });
  it.each([
    {
      kind: "list",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      relativePath: ".",
    },
    { kind: "archive-list", after: "", path: "/other/profile" },
    { kind: "archive-list", after: "../chat" },
    {
      kind: "archive-read",
      key: "a".repeat(64),
      digest: "b".repeat(64),
      ack: true,
    },
  ])(
    "rejects non-archive authority and arbitrary paths before IO",
    async (query) => {
      const f = fixture();
      expect(
        await readRetiredRepliesView(() => f.host, { context, query }),
      ).toHaveProperty("error");
      expect(f.retiredReplies.list).not.toHaveBeenCalled();
      expect(f.retiredReplies.read).not.toHaveBeenCalled();
    },
  );
  it.each(["host", "profile", "generation"])(
    "withholds a late response after %s replacement",
    async (kind) => {
      const f = fixture();
      let current: RetiredReplyHost = f.host;
      f.retiredReplies.list.mockImplementationOnce(async () => {
        current =
          kind === "host"
            ? { ...f.host }
            : {
                ...f.host,
                historyContext: {
                  ...context,
                  [kind === "profile" ? "profileId" : "backendGeneration"]:
                    "replaced",
                },
              };
        return storedPage();
      });
      expect(
        await readRetiredRepliesView(() => current, {
          context,
          query: { kind: "archive-list", after: "" },
        }),
      ).toEqual({ error: "RETIRED_REPLY_STALE" });
    },
  );
  it("does not fall back or retry an unavailable original archive read", async () => {
    const f = fixture();
    f.retiredReplies.list.mockRejectedValueOnce(new Error("unavailable"));
    expect(
      await readRetiredRepliesView(() => f.host, {
        context,
        query: { kind: "archive-list", after: "" },
      }),
    ).toEqual({ error: "RETIRED_REPLY_UNAVAILABLE" });
    expect(f.retiredReplies.list).toHaveBeenCalledTimes(1);
  });
});
