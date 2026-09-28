import { describe, expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffHost,
  type HandoffJournal,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";

const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "4",
  inode: "57",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "4",
    inode: "12",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};
const project = (id = "saved-project", root = workspace.project.root) => ({
  id,
  name: id,
  roots: [{ path: root }],
});
function service(
  pages: unknown[],
  options: {
    drift?: boolean;
    expire?: boolean;
    authorityFault?:
      "before-throw" | "after-throw" | "after-missing" | "expire-before-scan";
    abortBeforeScan?: AbortController;
    abortDuringRead?: AbortController;
  } = {},
) {
  const calls: string[] = [];
  let reads = 0;
  let now = 1000;
  const host: HandoffHost = {
    async request(method) {
      calls.push(method);
      if (method !== "project/list")
        throw new Error(
          "Read-only project resolution must not start/resume/turn/create work",
        );
      if (options.expire) now = 2000;
      options.abortDuringRead?.abort();
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return page;
    },
  };
  // Resolving saved projects must not read or mutate a task dispatch journal.
  const journal = new Proxy({} as HandoffJournal, {
    get() {
      throw new Error("Unexpected journal access");
    },
  });
  const handoff = new PersistentCodexHandoff(
    {
      async resolve(id) {
        if (id !== "selected") return null;
        reads++;
        if (
          options.authorityFault === "before-throw" ||
          (reads > 1 && options.authorityFault === "after-throw")
        )
          throw new Error("Authority unavailable");
        if (reads > 1 && options.authorityFault === "after-missing")
          return null;
        if (reads === 1 && options.authorityFault === "expire-before-scan")
          now = 2000;
        if (reads === 1) options.abortBeforeScan?.abort();
        return options.drift && reads > 1
          ? { ...workspace, inode: "58" }
          : workspace;
      },
    },
    host,
    journal,
    new Sha256HandoffRequestDigester(),
    2000,
    {
      async run() {
        throw new Error("Unexpected task mutation gate");
      },
    },
    () => now,
  );
  return { handoff, calls };
}

describe("target-bound saved project resolution", () => {
  it("resolves canonical saved project separately from writer cwd without task effects", async () => {
    const { handoff, calls } = service([
      { data: [project("foreign", "/unrelated"), project()], nextCursor: null },
    ]);
    expect(
      await handoff.resolveProject({ workspaceId: "selected" }),
    ).toMatchObject({
      status: "resolved",
      workspaceId: "selected",
      writerRoot: workspace.root,
      projectRoot: workspace.project.root,
      selectedProjectId: "saved-project",
      complete: true,
      matches: [{ projectId: "saved-project", name: "saved-project" }],
    });
    expect(calls).toEqual(["project/list"]);
  });
  it("only reports missing after a complete zero-match catalogue scan", async () => {
    const { handoff } = service([
      { data: [], nextCursor: "next" },
      { data: [project("foreign", "/unrelated")], nextCursor: null },
    ]);
    expect(
      await handoff.resolveProject({ workspaceId: "selected" }),
    ).toMatchObject({
      status: "missing",
      selectedProjectId: null,
      complete: true,
      pages: 2,
      matches: [],
    });
  });
  it("does not select arbitrarily when multiple saved projects have the same physical root", async () => {
    const { handoff } = service([
      { data: [project("second"), project("first")], nextCursor: null },
    ]);
    expect(
      await handoff.resolveProject({ workspaceId: "selected" }),
    ).toMatchObject({
      status: "ambiguous",
      selectedProjectId: null,
      complete: true,
      matches: [{ projectId: "first" }, { projectId: "second" }],
    });
  });
  it("honors only an explicit matching ID and never falls back from a stale request preference", async () => {
    const selected = service([
      { data: [project("first"), project("second")], nextCursor: null },
    ]);
    expect(
      await selected.handoff.resolveProject({
        workspaceId: "selected",
        preferredProjectId: "second",
      }),
    ).toMatchObject({
      status: "resolved",
      selectedProjectId: "second",
      selection: "requested-id",
    });
    const stale = service([{ data: [project()], nextCursor: null }]);
    expect(
      await stale.handoff.resolveProject({
        workspaceId: "selected",
        preferredProjectId: "stale",
      }),
    ).toMatchObject({
      status: "stale_preference",
      selectedProjectId: null,
      complete: true,
    });
  });
  it.each([
    [
      { data: [], nextCursor: "same" },
      { data: [], nextCursor: "same" },
    ],
    [{ data: [project()], nextCursor: "next" }, new Error("lost read reply")],
    [{ data: [project(), project()], nextCursor: null }],
    [{ data: [{ id: "bad", roots: [{}] }], nextCursor: null }],
    [{ data: "not-a-page", nextCursor: null }],
  ])(
    "does not turn partial or malformed catalogue evidence into missing/resolved",
    async (...pages) => {
      const { handoff } = service(pages);
      expect(
        await handoff.resolveProject({ workspaceId: "selected" }),
      ).toMatchObject({ status: "unavailable", complete: false });
    },
  );
  it.each([{ drift: true }, { expire: true }])(
    "refuses changed physical binding or expiry after catalogue read",
    async (options) => {
      const { handoff } = service(
        [{ data: [project()], nextCursor: null }],
        options,
      );
      expect(
        await handoff.resolveProject({ workspaceId: "selected" }),
      ).toMatchObject({ status: "refused" });
    },
  );
  it("rejects an unapproved workspace before any host call", async () => {
    const { handoff, calls } = service([]);
    expect(
      await handoff.resolveProject({ workspaceId: "other" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
    expect(calls).toEqual([]);
  });
  it.each([
    "before-throw",
    "after-throw",
    "after-missing",
    "expire-before-scan",
  ] as const)(
    "does not disclose catalogue after %s authority change",
    async (authorityFault) => {
      const { handoff, calls } = service(
        [{ data: [project()], nextCursor: null }],
        { authorityFault },
      );
      const result = await handoff.resolveProject({ workspaceId: "selected" });
      expect(result).toMatchObject({ status: "refused" });
      expect(JSON.stringify(result)).not.toContain("saved-project");
      if (
        authorityFault === "before-throw" ||
        authorityFault === "expire-before-scan"
      )
        expect(calls).toEqual([]);
    },
  );
  it.each(["already-aborted", "during-authority", "during-read"])(
    "refuses %s cancellation without returning selection",
    async (mode) => {
      const controller = new AbortController();
      if (mode === "already-aborted") controller.abort();
      const { handoff, calls } = service(
        [{ data: [project()], nextCursor: null }],
        {
          ...(mode === "during-authority"
            ? { abortBeforeScan: controller }
            : {}),
          ...(mode === "during-read" ? { abortDuringRead: controller } : {}),
        },
      );
      expect(
        await handoff.resolveProject(
          { workspaceId: "selected" },
          { signal: controller.signal },
        ),
      ).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_READ_CANCELLED",
      });
      if (mode !== "during-read") expect(calls).toEqual([]);
    },
  );
  it("rejects invalid input before host and authority work", async () => {
    const { handoff, calls } = service([]);
    expect(
      await handoff.resolveProject({ workspaceId: "../selected" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_RESOLVE_INPUT_INVALID",
    });
    expect(
      await handoff.resolveProject({
        workspaceId: "selected",
        preferredProjectId: "bad\0id",
      }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_RESOLVE_INPUT_INVALID",
    });
    expect(calls).toEqual([]);
  });
  it.each(["abort", "deadline"])(
    "stops pagination after first-page %s without another host read",
    async (mode) => {
      const controller = new AbortController();
      const { handoff, calls } = service(
        [
          { data: [], nextCursor: "next" },
          { data: [project()], nextCursor: null },
        ],
        mode === "abort" ? { abortDuringRead: controller } : { expire: true },
      );
      expect(
        await handoff.resolveProject(
          { workspaceId: "selected" },
          { signal: controller.signal },
        ),
      ).toMatchObject({ status: "refused" });
      expect(calls).toEqual(["project/list"]);
    },
  );

  it("bounds pages, matches and malformed roots/cursors instead of returning partial selections", async () => {
    const pages = Array.from({ length: 32 }, (_, index) => ({
      data: [],
      nextCursor: `cursor-${index}`,
    }));
    const { handoff, calls } = service(pages);
    expect(
      await handoff.resolveProject({ workspaceId: "selected" }),
    ).toMatchObject({
      status: "unavailable",
      complete: false,
      code: "HANDOFF_PROJECT_CATALOGUE_PAGE_LIMIT",
    });
    expect(calls).toHaveLength(32);
    for (const page of [
      {
        data: Array.from({ length: 33 }, (_, index) =>
          project(`match-${index}`),
        ),
        nextCursor: null,
      },
      {
        data: Array.from({ length: 101 }, (_, index) =>
          project(`row-${index}`),
        ),
        nextCursor: null,
      },
      { data: [project("relative", "relative/root")], nextCursor: null },
      {
        data: [project("escape", "/fixture/project/../project")],
        nextCursor: null,
      },
      { data: [{ ...project(), name: { unsafe: true } }], nextCursor: null },
      { data: [], nextCursor: "" },
      { data: [], nextCursor: 3 },
    ])
      expect(
        await service([page]).handoff.resolveProject({
          workspaceId: "selected",
        }),
      ).toMatchObject({ status: "unavailable", complete: false });
  });
  it("treats an omitted optional nextCursor as terminal and labels unavailable name explicitly", async () => {
    const { handoff } = service([
      {
        data: [
          { id: "saved-project", roots: [{ path: workspace.project.root }] },
        ],
      },
    ]);
    expect(
      await handoff.resolveProject({ workspaceId: "selected" }),
    ).toMatchObject({
      status: "resolved",
      matches: [{ projectId: "saved-project", name: null }],
    });
  });
});
