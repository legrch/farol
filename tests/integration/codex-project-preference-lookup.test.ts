import { expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
const key = "019b0000-0000-4000-8000-000000000017";
const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "20",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "10",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};
const input = { workspaceId: "selected", projectId: "saved" };
function setup() {
  let latest: unknown = {
    key,
    record: { projectId: "saved", project: workspace.project },
  };
  let current: HandoffWorkspace | null = workspace;
  let now = 1;
  let page: unknown = {
    data: [{ id: "saved", roots: [{ path: workspace.project.root }] }],
    nextCursor: null,
  };
  const calls: string[] = [];
  let onRead = () => {};
  let onList = () => {};
  let reads = 0;
  const abort = new AbortController();
  const handoff = new PersistentCodexHandoff(
    {
      async resolve(id) {
        return id === "selected" ? current : null;
      },
    },
    {
      async request(method) {
        calls.push(method);
        onList();
        return page;
      },
    },
    {
      async readLatestProjectPreference(project: unknown) {
        expect(project).toEqual(workspace.project);
        reads++;
        onRead();
        return latest;
      },
    } as never,
    new Sha256HandoffRequestDigester(),
    100,
    {
      async run() {
        throw new Error("Lookup must not mutate");
      },
    },
    () => now,
  );
  return {
    handoff,
    calls,
    abort,
    get reads() {
      return reads;
    },
    setLatest(v: unknown) {
      latest = v;
    },
    setCurrent(v: HandoffWorkspace | null) {
      current = v;
    },
    setNow(v: number) {
      now = v;
    },
    setPage(v: unknown) {
      page = v;
    },
    onRead(fn: () => void) {
      onRead = fn;
    },
    onList(fn: () => void) {
      onList = fn;
    },
  };
}
it("looks up an exact local preference without a UUID input or mutation", async () => {
  const f = setup();
  expect(await f.handoff.lookupProjectPreference(input)).toEqual({
    status: "resolved",
    ...input,
    key,
    persistence: "immutable-local-receipt",
    selection: "latest-local-publication",
    snapshot: "non-atomic",
    controlGranted: false,
  });
  expect(f.calls).toEqual(["project/list"]);
  expect(f.reads).toBe(2);
});
it("missing does not choose a unique catalogue project", async () => {
  const f = setup();
  f.setLatest(null);
  expect(await f.handoff.lookupProjectPreference(input)).toMatchObject({
    status: "missing",
  });
  expect(f.calls).toEqual([]);
});
it.each(["project", "identity", "key"])(
  "stale %s does not select another project or expose its key",
  async (fault) => {
    const f = setup();
    f.setLatest({
      key: fault === "key" ? "bad" : key,
      record: {
        projectId: fault === "project" ? "foreign" : "saved",
        project: {
          ...workspace.project,
          inode: fault === "identity" ? "99" : "10",
        },
      },
    });
    const result = await f.handoff.lookupProjectPreference(input);
    expect(result.status).toBe(
      fault === "key" ? "unavailable" : "stale_preference",
    );
    expect(result).not.toHaveProperty("key");
    expect(f.calls).toEqual([]);
  },
);
it.each(["revoked", "expired", "cancelled", "changed"])(
  "%s after catalogue refuses disclosure without a retry",
  async (fault) => {
    const f = setup();
    f.onList(() => {
      if (fault === "revoked") f.setCurrent(null);
      if (fault === "expired") f.setNow(100);
      if (fault === "cancelled") f.abort.abort();
      if (fault === "changed")
        f.setLatest({
          key: "019b0000-0000-4000-8000-000000000018",
          record: { projectId: "saved", project: workspace.project },
        });
    });
    const result = await f.handoff.lookupProjectPreference(input, {
      signal: f.abort.signal,
    });
    expect(["refused", "unavailable"]).toContain(result.status);
    expect(result).not.toHaveProperty("key");
    expect(f.calls).toEqual(["project/list"]);
  },
);
it("partial catalogue is unavailable, removed project is stale", async () => {
  const f = setup();
  f.setPage({ data: [], nextCursor: "repeated" });
  expect(await f.handoff.lookupProjectPreference(input)).toMatchObject({
    status: "unavailable",
  });
  const g = setup();
  g.setPage({ data: [], nextCursor: null });
  expect(await g.handoff.lookupProjectPreference(input)).toMatchObject({
    status: "stale_preference",
  });
});

it("late cancellation during final journal read cannot disclose the historical handle", async () => {
  const f = setup();
  f.onRead(() => {
    if (f.reads === 2) f.abort.abort();
  });
  expect(
    await f.handoff.lookupProjectPreference(input, { signal: f.abort.signal }),
  ).toMatchObject({ status: "refused" });
  expect(f.calls).toEqual(["project/list"]);
});
it("already expired or unapproved workspace has no journal/host effect", async () => {
  const f = setup();
  f.setNow(100);
  expect(await f.handoff.lookupProjectPreference(input)).toMatchObject({
    status: "refused",
  });
  expect(f.reads).toBe(0);
  expect(f.calls).toEqual([]);
  const g = setup();
  g.setCurrent(null);
  expect(await g.handoff.lookupProjectPreference(input)).toMatchObject({
    status: "refused",
  });
  expect(g.reads).toBe(0);
  expect(g.calls).toEqual([]);
});
