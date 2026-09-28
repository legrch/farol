import { describe, expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffJournal,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";

const threadId = "019b0000-0000-4000-8000-000000000001";
const turnId = "019b0000-0000-4000-8000-000000000002";
const request = {
  threadId,
  turnId,
  workspaceId: "writer",
  projectId: "project",
};
const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/repo/.git",
  project: {
    root: "/fixture/repo",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/fixture/repo/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};
const entries = [
  {
    turnId,
    item: {
      id: "user",
      type: "userMessage",
      content: [
        { type: "text", text: "Question" },
        { type: "image", url: "private-omitted-image" },
      ],
    },
  },
  {
    turnId,
    item: {
      id: "agent",
      type: "agentMessage",
      phase: "final_answer",
      text: "Exact answer",
    },
  },
  {
    turnId,
    item: {
      id: "reasoning",
      type: "reasoning",
      content: ["private-omitted-reasoning"],
    },
  },
];
function fixture(
  options: {
    items?: unknown;
    turnPages?: unknown[];
    threadDrift?: boolean;
    physicalDrift?: boolean;
    selected?: string;
    afterRead?: () => void;
    expireAfter?: string;
    throwAt?: string;
    authorityFault?: boolean;
    authorityMissing?: boolean;
    driftBeforeRead?: boolean;
    expireAtAuthority?: number;
    projectMissing?: boolean;
    threadMissing?: boolean;
    projectUnavailable?: boolean;
    beforeSendExpireAt?: string;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let now = 1000;
  let authorityReads = 0;
  let threadReads = 0;
  let turnReads = 0;
  const sent: string[] = [];
  const journal = new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("Unexpected journal effect");
        };
      },
    },
  ) as HandoffJournal;
  const handoff = new PersistentCodexHandoff(
    {
      async resolve() {
        authorityReads++;
        if (options.authorityFault) throw new Error("Unavailable");
        if (authorityReads === options.expireAtAuthority) now = 3000;
        if (options.authorityMissing) return null;
        if (options.driftBeforeRead && authorityReads >= 2)
          return { ...workspace, inode: "changed-before-read" };
        return options.physicalDrift && authorityReads >= 3
          ? { ...workspace, inode: "changed" }
          : workspace;
      },
    },
    {
      async request(method, params, deadlineAt) {
        calls.push({ method, params });
        // The existing transport rechecks the forwarded deadline after connect.
        if (options.beforeSendExpireAt === method) now = 3000;
        if (deadlineAt !== undefined && now >= deadlineAt)
          throw new Error("Deadline before frame");
        sent.push(method);
        if (options.throwAt === method) throw new Error("Lost read");
        if (options.expireAfter === method) now = 3000;
        if (method === "project/list")
          if (options.projectUnavailable) throw new Error("Partial catalogue");
        if (method === "project/list")
          return {
            data: options.projectMissing
              ? []
              : [{ id: "project", roots: [{ path: workspace.project.root }] }],
            nextCursor: null,
          };
        if (method === "thread/read") {
          threadReads++;
          return {
            thread: {
              id: options.threadMissing ? "foreign" : threadId,
              projectId: "project",
              cwd:
                options.threadDrift && threadReads > 1
                  ? "/foreign"
                  : workspace.root,
            },
          };
        }
        if (method === "thread/turns/list")
          return (
            options.turnPages?.[turnReads++] ?? {
              data: [{ id: turnId, status: "completed" }],
              nextCursor: null,
            }
          );
        if (method === "thread/items/list") {
          options.afterRead?.();
          return options.items ?? { data: entries, nextCursor: null };
        }
        throw new Error("Forbidden method: " + method);
      },
    },
    journal,
    new Sha256HandoffRequestDigester(),
    2000,
    {
      async run() {
        throw new Error("Unexpected mutation fence");
      },
    },
    () => now,
    options.selected ?? threadId,
  );
  const history = (
    input: object = request,
    context: { signal?: AbortSignal } = {},
  ) =>
    (
      handoff as unknown as {
        history(input: object, context: object): Promise<unknown>;
      }
    ).history(input, context);
  return { calls, history, sent };
}
describe("exact selected task stored history", () => {
  it.each(["thread/read", "thread/turns/list", "thread/items/list"])(
    "does not send a late frame after connect consumes admission at %s",
    async (beforeSendExpireAt) => {
      const f = fixture({ beforeSendExpireAt });
      expect(await f.history()).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
      expect(f.sent).not.toContain(beforeSendExpireAt);
    },
  );
  it("does not classify an unavailable project catalogue as absent", async () => {
    const f = fixture({ projectUnavailable: true });
    expect(await f.history()).toMatchObject({
      status: "unavailable",
      code: "HANDOFF_PROJECT_CATALOGUE_UNAVAILABLE",
    });
    expect(f.sent).toEqual(["project/list"]);
  });
  it.each([1, 2, 3])(
    "does not read/disclose after an authority await exhausts admission at read %i",
    async (expireAtAuthority) => {
      const f = fixture({ expireAtAuthority });
      expect(await f.history()).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
      if (expireAtAuthority === 1) expect(f.calls).toEqual([]);
      if (expireAtAuthority === 2)
        expect(f.calls.map((c) => c.method)).toEqual(["project/list"]);
    },
  );
  it.each([
    { authorityMissing: true },
    { driftBeforeRead: true },
    { projectMissing: true },
    { threadMissing: true },
  ])("does not publish history on a failed binding: %j", async (options) => {
    expect(await fixture(options).history()).not.toMatchObject({
      status: "history",
    });
  });
  it("stops before host reads when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    expect(
      await f.history(request, { signal: controller.signal }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_HISTORY_CANCELLED" });
    expect(f.calls).toEqual([]);
  });
  it("finds a later exact turn without resuming work and preserves absent phase/empty user parts", async () => {
    const f = fixture({
      turnPages: [
        { data: [{ id: "older", status: "completed" }], nextCursor: "next" },
        { data: [{ id: turnId, status: "inProgress" }] },
      ],
      items: {
        data: [
          {
            turnId,
            item: {
              id: "agent",
              type: "agentMessage",
              text: "Recorded commentary",
            },
          },
          { turnId, item: { id: "user", type: "userMessage", content: [] } },
        ],
      },
    });
    expect(await f.history()).toMatchObject({
      status: "history",
      turnStatus: "inProgress",
      items: [{ phase: null }, { parts: [], omittedContent: 0 }],
    });
    expect(
      f.calls.filter((c) => c.method === "thread/turns/list"),
    ).toHaveLength(2);
  });
  it.each([
    { data: "bad" },
    { data: new Array(101).fill({ id: "turn", status: "completed" }) },
    { data: [{ id: turnId, status: "invented" }] },
    {
      data: [
        { id: turnId, status: "completed" },
        { id: turnId, status: "completed" },
      ],
    },
    { data: [], nextCursor: 5 },
    { data: [], nextCursor: "\0" },
  ])("refuses invalid turn pages before item reads: %j", async (page) => {
    const f = fixture({ turnPages: [page] });
    expect(await f.history()).toMatchObject({ status: "unavailable" });
    expect(f.calls.some((c) => c.method === "thread/items/list")).toBe(false);
  });
  it("rejects cyclic turn pagination before retrieving messages", async () => {
    const f = fixture({
      turnPages: [
        { data: [], nextCursor: "same" },
        { data: [], nextCursor: "same" },
      ],
    });
    expect(await f.history()).toMatchObject({ status: "unavailable" });
    expect(
      f.calls.filter((c) => c.method === "thread/turns/list"),
    ).toHaveLength(2);
  });
  it.each([
    {
      data: [
        {
          turnId,
          item: { id: "user", type: "userMessage", content: "invalid" },
        },
      ],
    },
    {
      data: [
        { turnId, item: { id: "user", type: "userMessage", content: [null] } },
      ],
    },
    {
      data: [
        {
          turnId,
          item: { id: "user", type: "userMessage", content: [{ type: "" }] },
        },
      ],
    },
    {
      data: [
        {
          turnId,
          item: {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text: "\0" }],
          },
        },
      ],
    },
    {
      data: [
        {
          turnId,
          item: {
            id: "user",
            type: "userMessage",
            content: [
              { type: "text", text: "a".repeat(20000) },
              { type: "text", text: "b".repeat(12769) },
            ],
          },
        },
      ],
    },
  ])(
    "rejects invalid or over-budget user message content: %j",
    async (items) => {
      expect(await fixture({ items }).history()).toMatchObject({
        status: "unavailable",
      });
    },
  );
  it("allows the exact aggregate UTF-8 budget and does not call a terminal continuation complete", async () => {
    const f = fixture({
      items: {
        data: [
          {
            turnId,
            item: {
              id: "agent",
              type: "agentMessage",
              text: "🔥".repeat(8192),
            },
          },
        ],
        nextCursor: null,
      },
    });
    expect(await f.history({ ...request, cursor: "page" })).toMatchObject({
      status: "history",
      complete: false,
      nextCursor: null,
    });
  });
  it("reads one verified turn with explicit text-only coverage and no task effects", async () => {
    const f = fixture();
    expect(await f.history()).toMatchObject({
      status: "history",
      source: "stored",
      snapshot: "non-atomic",
      threadId,
      turnId,
      sortDirection: "asc",
      complete: true,
      nextCursor: null,
      items: [
        {
          id: "user",
          kind: "user_message",
          parts: ["Question"],
          omittedContent: 1,
        },
        {
          id: "agent",
          kind: "agent_message",
          phase: "final_answer",
          text: "Exact answer",
        },
        { id: "reasoning", kind: "omitted", type: "reasoning" },
      ],
    });
    expect(f.calls.map((c) => c.method)).toEqual([
      "project/list",
      "thread/read",
      "thread/turns/list",
      "thread/items/list",
      "thread/read",
    ]);
    expect(JSON.stringify(await f.history())).not.toContain("private-omitted");
  });
  it("returns a bounded tail cursor without pretending to cover the whole turn", async () => {
    const f = fixture({ items: { data: entries, nextCursor: "more" } });
    expect(
      await f.history({ ...request, tail: true, cursor: "previous" }),
    ).toMatchObject({
      status: "history",
      sortDirection: "desc",
      complete: false,
      nextCursor: "more",
    });
    expect(
      f.calls.find((c) => c.method === "thread/items/list")?.params,
    ).toEqual({
      threadId,
      turnId,
      cursor: "previous",
      limit: 50,
      sortDirection: "desc",
    });
  });
  it.each([
    { threadId: "019b0000-0000-4000-8000-000000000099" },
    { turnId: "bad" },
    { workspaceId: ".." },
    { projectId: "." },
    { cursor: "" },
    { cursor: "x".repeat(4097) },
    { tail: "yes" },
  ])(
    "refuses malformed/foreign selection before reading: %j",
    async (change) => {
      const f = fixture();
      expect(await f.history({ ...request, ...change })).toMatchObject({
        status: "refused",
      });
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    {
      data: [
        {
          turnId: "foreign",
          item: { id: "x", type: "agentMessage", text: "wrong" },
        },
      ],
    },
    { data: [entries[0], entries[0]] },
    {
      data: [
        {
          turnId,
          item: {
            id: "x",
            type: "userMessage",
            content: [{ type: "text", text: 4 }],
          },
        },
      ],
    },
    {
      data: [
        {
          turnId,
          item: { id: "x", type: "agentMessage", text: "x", phase: "invented" },
        },
      ],
    },
    {
      data: [
        {
          turnId,
          item: { id: "x", type: "agentMessage", text: "🔥".repeat(8193) },
        },
      ],
    },
    { data: new Array(51).fill(entries[0]) },
    { data: entries, nextCursor: 4 },
  ])(
    "does not publish malformed/oversized/foreign history: %j",
    async (items) => {
      const f = fixture({ items });
      expect(await f.history()).toMatchObject({ status: "unavailable" });
    },
  );
  it("supports an omitted optional terminal cursor", async () => {
    const f = fixture({ items: { data: entries } });
    expect(await f.history()).toMatchObject({
      status: "history",
      complete: true,
      nextCursor: null,
    });
  });
  it("refuses a cursor loop without publishing text", async () => {
    expect(
      await fixture({ items: { data: entries, nextCursor: "same" } }).history({
        ...request,
        cursor: "same",
      }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("labels a complete missing turn separately from a partial scan", async () => {
    expect(
      await fixture({ turnPages: [{ data: [], nextCursor: null }] }).history(),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_HISTORY_TURN_MISSING",
    });
    expect(
      await fixture({
        turnPages: new Array(32)
          .fill(null)
          .map((_, i) => ({ data: [], nextCursor: "page-" + i })),
      }).history(),
    ).toMatchObject({ status: "unavailable" });
  });
  it.each(["thread/read", "thread/turns/list", "thread/items/list"])(
    "stops further host reads after deadline at %s",
    async (expireAfter) => {
      const f = fixture({ expireAfter });
      expect(await f.history()).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
      expect(f.calls.at(-1)?.method).toBe(expireAfter);
    },
  );
  it("does not disclose read text after cancellation", async () => {
    const controller = new AbortController();
    const f = fixture({ afterRead: () => controller.abort() });
    expect(
      await f.history(request, { signal: controller.signal }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_HISTORY_CANCELLED" });
    expect(f.calls.at(-1)?.method).toBe("thread/items/list");
  });
  it.each([
    { threadDrift: true },
    { physicalDrift: true },
    { authorityFault: true },
    { throwAt: "thread/items/list" },
  ])("fails closed on authority/provider drift: %j", async (options) => {
    expect(await fixture(options).history()).not.toMatchObject({
      status: "history",
    });
  });
});
