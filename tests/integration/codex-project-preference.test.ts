import { expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
const key = "a6c11016-b7b7-4d32-a5ec-8bd1e57ee521";
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
const input = {
  key,
  workspaceId: "selected",
  projectId: "saved",
  operation: "remember" as const,
};
function setup() {
  const records = new Map();
  const calls: string[] = [];
  let writes = 0;
  let now = 1;
  let current = workspace;
  let page: unknown = {
    data: [{ id: "saved", roots: [{ path: workspace.project.root }] }],
    nextCursor: null,
  };
  let beforeStore = () => {};
  let afterRead = () => {};
  let afterList = () => {};
  const classifications: boolean[] = [];
  let beforeFence = () => {};
  let gateHeld = false;
  const publicationAuthorityHolds: boolean[] = [];
  let storeFault = false;
  let readFault = false;
  const abort = new AbortController();
  const journal = {
    async readProjectPreference(id: string) {
      if (readFault) throw new Error("corrupt");
      afterRead();
      return records.get(id) ?? null;
    },
    async rememberProjectPreference(id: string, value: unknown) {
      beforeStore();
      writes++;
      records.set(id, structuredClone(value));
      if (storeFault) throw new Error("lost durable reply");
      return records.get(id);
    },
  };
  const handoff = new PersistentCodexHandoff(
    {
      async resolve(id) {
        if (writes > 0) publicationAuthorityHolds.push(gateHeld);
        return id === "selected" ? current : null;
      },
    },
    {
      async request(method) {
        calls.push(method);
        expect(method).toBe("project/list");
        afterList();
        return page;
      },
    },
    journal as never,
    new Sha256HandoffRequestDigester(),
    100,
    {
      async run(before, effect, isNotSubmitted) {
        beforeFence();
        gateHeld = true;
        try {
          await before();
          return await effect();
        } catch (error) {
          classifications.push(isNotSubmitted(error));
          throw error;
        } finally {
          gateHeld = false;
        }
      },
    },
    () => now,
  );
  return {
    handoff,
    records,
    calls,
    journal,
    classifications,
    publicationAuthorityHolds,
    abort,
    get writes() {
      return writes;
    },
    setNow(v: number) {
      now = v;
    },
    setWorkspace(v: HandoffWorkspace) {
      current = v;
    },
    setPage(v: unknown) {
      page = v;
    },
    failStore() {
      storeFault = true;
    },
    failRead() {
      readFault = true;
    },
    onFence(fn: () => void) {
      beforeFence = fn;
    },
    onRead(fn: () => void) {
      afterRead = fn;
    },
    onList(fn: () => void) {
      afterList = fn;
    },
    onStore(fn: () => void) {
      beforeStore = fn;
    },
  };
}
it("remembers one choice, then reads it against the current saved catalogue", async () => {
  const f = setup();
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "remembered",
    key,
    projectId: "saved",
    controlGranted: false,
    catalogue: "current-non-atomic",
  });
  expect(
    await f.handoff.projectPreference({ ...input, operation: "read" }),
  ).toMatchObject({
    status: "resolved",
    persistence: "immutable-local-receipt",
  });
  expect(f.writes).toBe(1);
  expect(f.calls).toEqual(["project/list", "project/list"]);
});
it("replay does not publish another preference or create a task/project", async () => {
  const f = setup();
  await f.handoff.projectPreference(input);
  await f.handoff.projectPreference(input);
  expect(f.writes).toBe(1);
  expect(f.calls.every((method) => method === "project/list")).toBe(true);
});
it("allows a new approved writer of the same physical canonical repository", async () => {
  const f = setup();
  await f.handoff.projectPreference(input);
  f.setWorkspace({ ...workspace, root: "/fixture/other-writer", inode: "22" });
  expect(
    await f.handoff.projectPreference({ ...input, operation: "read" }),
  ).toMatchObject({ status: "resolved" });
});
it("does not fall back from a stale saved project to a unique alternative", async () => {
  const f = setup();
  await f.handoff.projectPreference(input);
  f.setPage({
    data: [{ id: "other", roots: [{ path: workspace.project.root }] }],
    nextCursor: null,
  });
  expect(
    await f.handoff.projectPreference({ ...input, operation: "read" }),
  ).toMatchObject({ status: "stale_preference" });
  expect(f.writes).toBe(1);
});
it("never overwrites an immutable handle with another choice", async () => {
  const f = setup();
  await f.handoff.projectPreference(input);
  expect(
    await f.handoff.projectPreference({ ...input, projectId: "other" }),
  ).toMatchObject({
    status: "refused",
    code: "HANDOFF_PROJECT_PREFERENCE_KEY_CONFLICT",
  });
  expect(f.writes).toBe(1);
});
it.each(["root", "inode", "gitCommonDirectory"])(
  "rejects canonical %s drift on later use",
  async (field) => {
    const f = setup();
    await f.handoff.projectPreference(input);
    f.setWorkspace({
      ...workspace,
      ...(field === "gitCommonDirectory"
        ? { gitCommonDirectory: "/fixture/changed" }
        : {}),
      project: {
        ...workspace.project,
        [field]: field === "inode" ? "99" : "/fixture/changed",
      },
    });
    expect(
      await f.handoff.projectPreference({ ...input, operation: "read" }),
    ).toMatchObject({ status: "stale_preference" });
  },
);
it("missing handle is explicit and causes no catalogue read or write", async () => {
  const f = setup();
  expect(
    await f.handoff.projectPreference({ ...input, operation: "read" }),
  ).toMatchObject({
    status: "refused",
    code: "HANDOFF_PROJECT_PREFERENCE_UNKNOWN",
  });
  expect(f.calls).toEqual([]);
  expect(f.writes).toBe(0);
});
it.each(["expire", "abort", "drift"])(
  "rechecks %s after receipt read before catalogue",
  async (mode) => {
    const f = setup();
    f.onRead(() => {
      if (mode === "expire") f.setNow(100);
      else if (mode === "abort") f.abort.abort();
      else f.setWorkspace({ ...workspace, inode: "99" });
    });
    expect(
      await f.handoff.projectPreference(input, { signal: f.abort.signal }),
    ).toMatchObject({ status: "refused" });
    expect(f.calls).toEqual([]);
    expect(f.writes).toBe(0);
  },
);
it.each(["expire", "abort", "drift"])(
  "rechecks %s after catalogue before publication",
  async (mode) => {
    const f = setup();
    f.onList(() => {
      if (mode === "expire") f.setNow(100);
      else if (mode === "abort") f.abort.abort();
      else f.setWorkspace({ ...workspace, inode: "99" });
    });
    expect(
      await f.handoff.projectPreference(input, { signal: f.abort.signal }),
    ).toMatchObject({ status: "refused" });
    expect(f.writes).toBe(0);
  },
);
it("uncertain publication is not success; read can reconcile the exact handle", async () => {
  const f = setup();
  f.failStore();
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "outcome_unknown",
  });
  expect(
    await f.handoff.projectPreference({ ...input, operation: "read" }),
  ).toMatchObject({ status: "resolved" });
  expect(f.writes).toBe(1);
});
it("late expiry during publication is unknown, not remembered", async () => {
  const f = setup();
  f.onStore(() => f.setNow(100));
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "outcome_unknown",
  });
});
it("corrupt receipt is unavailable, never treated as absence", async () => {
  const f = setup();
  f.failRead();
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "unavailable",
  });
  expect(f.writes).toBe(0);
  expect(f.calls).toEqual([]);
});
it.each(["missing", "partial", "malformed"])(
  "never remembers from %s catalogue",
  async (mode) => {
    const f = setup();
    f.setPage(
      mode === "missing"
        ? { data: [], nextCursor: null }
        : mode === "partial"
          ? { data: [], nextCursor: "cycle" }
          : { data: [{ id: "saved", roots: [{}] }], nextCursor: null },
    );
    expect((await f.handoff.projectPreference(input)).status).not.toBe(
      "remembered",
    );
    expect(f.writes).toBe(0);
  },
);

it("fence denial before publication is no-submit; post-publication expiry is not", async () => {
  const before = setup();
  before.onFence(() => before.setNow(100));
  expect(await before.handoff.projectPreference(input)).toMatchObject({
    status: "refused",
  });
  expect(before.writes).toBe(0);
  expect(before.classifications).toEqual([true]);
  const after = setup();
  after.onStore(() => after.setNow(100));
  expect(await after.handoff.projectPreference(input)).toMatchObject({
    status: "outcome_unknown",
  });
  expect(after.writes).toBe(1);
  expect(after.classifications).toEqual([false]);
});
it.each([
  { key: "invalid" },
  { workspaceId: "/foreign" },
  { projectId: "/foreign" },
  { operation: "erase" },
])("invalid preference input has zero effects: %o", async (patch) => {
  const f = setup();
  expect(
    await f.handoff.projectPreference({ ...input, ...patch } as never),
  ).toMatchObject({
    status: "refused",
    code: "HANDOFF_PROJECT_PREFERENCE_INPUT_INVALID",
  });
  expect(f.writes).toBe(0);
  expect(f.calls).toEqual([]);
});
it("expired/cancelled admission and missing physical workspace cause no catalogue/publication", async () => {
  for (const mode of ["expire", "abort", "foreign"]) {
    const f = setup();
    if (mode === "expire") f.setNow(100);
    if (mode === "abort") f.abort.abort();
    expect(
      await f.handoff.projectPreference(
        { ...input, ...(mode === "foreign" ? { workspaceId: "other" } : {}) },
        { signal: f.abort.signal },
      ),
    ).toMatchObject({ status: "refused" });
    expect(f.calls).toEqual([]);
    expect(f.writes).toBe(0);
  }
});
it("a journal without the preference port refuses instead of inventing persistence", async () => {
  const f = setup();
  delete (f.journal as Partial<typeof f.journal>).readProjectPreference;
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "refused",
    code: "HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE",
  });
  expect(f.calls).toEqual([]);
});
it("foreign publication acknowledgement is unknown, never a remembered choice", async () => {
  const f = setup();
  f.journal.rememberProjectPreference = async () => ({
    projectId: "foreign",
    project: workspace.project,
  });
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "outcome_unknown",
  });
});
it("missing post-write receipt readback is unknown", async () => {
  const f = setup();
  let reads = 0;
  f.onRead(() => {
    if (++reads === 2) f.records.clear();
  });
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "outcome_unknown",
  });
  expect(f.writes).toBe(1);
});

it("post-publication physical validation completes while the mutation fence is held", async () => {
  const f = setup();
  expect(await f.handoff.projectPreference(input)).toMatchObject({
    status: "remembered",
  });
  expect(f.publicationAuthorityHolds.length).toBeGreaterThan(0);
  expect(f.publicationAuthorityHolds.every(Boolean)).toBe(true);
});
