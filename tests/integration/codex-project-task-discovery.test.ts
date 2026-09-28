import { describe, expect, it } from "vitest";
import { readCodexProjectTasks } from "../../src/modules/chat/app/service/read-codex-project-tasks";
const id = "019b0000-0000-4000-8000-000000000001";
const request = { projectId: "project", writerRoot: "/fixture/writer" };
const row = {
  id,
  projectId: "project",
  cwd: request.writerRoot,
  name: "Farol · Observer",
  model: "fixture-model",
  updatedAt: 123,
  preview: "Private prompt MUST NOT escape",
  turns: [{ private: true }],
};
async function fixture(
  options: {
    page?: unknown;
    throw?: boolean;
    after?: boolean;
    admitted?: boolean;
    input?: object;
  } = {},
) {
  const calls: unknown[] = [];
  let admitted = options.admitted ?? true;
  const result = await readCodexProjectTasks(
    {
      async request(method, params, deadlineAt) {
        calls.push({ method, params, deadlineAt });
        if (options.throw) throw new Error("No reply");
        if (options.after) admitted = false;
        return Object.hasOwn(options, "page")
          ? options.page
          : { data: [row], nextCursor: null };
      },
    },
    { ...request, ...options.input },
    { deadlineAt: 2000, admitted: () => admitted },
  );
  return { result, calls };
}
describe("read-only scoped stored task discovery", () => {
  it("reads one current-writer database metadata page with exact project and deadline, no control", async () => {
    const f = await fixture();
    expect(f.result).toEqual({
      status: "tasks",
      source: "stored",
      snapshot: "non-atomic",
      scope: "selected-writer",
      coverage: "single-page-metadata",
      controlGranted: false,
      tasks: [
        { id, title: row.name, configuredModel: row.model, updatedAt: 123 },
      ],
      nextCursor: null,
      complete: true,
    });
    expect(f.calls).toEqual([
      {
        method: "thread/list",
        params: {
          projectId: "project",
          cwd: "/fixture/writer",
          cursor: null,
          limit: 50,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          useStateDbOnly: true,
        },
        deadlineAt: 2000,
      },
    ]);
    expect(JSON.stringify(f.result)).not.toContain("Private prompt");
  });
  it("reports partial/cursor coverage and never claims all-project or atomic history", async () => {
    expect(
      (await fixture({ page: { data: [row], nextCursor: "page2" } })).result,
    ).toMatchObject({ status: "tasks", complete: false, nextCursor: "page2" });
    expect(
      (await fixture({ input: { cursor: "page2" } })).result,
    ).toMatchObject({ status: "tasks", complete: false, nextCursor: null });
    expect(
      (await fixture({ page: { data: [], nextCursor: null } })).result,
    ).toMatchObject({ status: "tasks", tasks: [], complete: true });
  });
  it("accepts omitted nullable metadata and terminal cursor without fallback", async () => {
    const { name: _name, model: _model, ...minimal } = row;
    expect((await fixture({ page: { data: [minimal] } })).result).toMatchObject(
      { status: "tasks", tasks: [{ id, title: null, configuredModel: null }] },
    );
  });
  it.each([
    { projectId: "foreign" },
    { cwd: "/other/writer" },
    { id: "invalid" },
    { name: 7 },
    { name: "bad\0name" },
    { model: [] },
    { updatedAt: -1 },
    { updatedAt: 1.5 },
  ])(
    "does not disclose malformed or foreign page entries: %j",
    async (change) => {
      expect(
        (
          await fixture({
            page: { data: [{ ...row, ...change }], nextCursor: null },
          })
        ).result,
      ).toEqual({
        status: "unavailable",
        code: "HANDOFF_PROJECT_TASKS_UNVERIFIED",
      });
    },
  );
  it.each([
    { data: [row, row], nextCursor: null },
    { data: Array(51).fill(row), nextCursor: null },
    { data: [row], nextCursor: 7 },
    { data: [row], nextCursor: "bad\0cursor" },
    null,
    [],
  ])("refuses unusable pages instead of silent filtering: %j", async (page) => {
    expect((await fixture({ page })).result).toEqual({
      status: "unavailable",
      code: "HANDOFF_PROJECT_TASKS_UNVERIFIED",
    });
  });
  it("rejects a repeated cursor and aggregate title budget overflow", async () => {
    expect(
      (
        await fixture({
          input: { cursor: "same" },
          page: { data: [row], nextCursor: "same" },
        })
      ).result,
    ).toMatchObject({
      status: "unavailable",
      code: "HANDOFF_PROJECT_TASKS_UNVERIFIED",
    });
    const data = Array.from({ length: 20 }, (_, n) => ({
      ...row,
      id: "019b0000-0000-4000-8000-" + String(n).padStart(12, "0"),
      name: "🧭".repeat(490),
    }));
    expect(
      (await fixture({ page: { data, nextCursor: null } })).result,
    ).toMatchObject({
      status: "unavailable",
      code: "HANDOFF_PROJECT_TASKS_UNVERIFIED",
    });
  });
  it.each([{ admitted: false }, { after: true }])(
    "does not read/disclose after admission loss: %j",
    async (options) => {
      const f = await fixture(options);
      expect(f.result).toEqual({
        status: "unavailable",
        code: "HANDOFF_PROJECT_TASKS_ADMISSION_DENIED",
      });
      expect(f.calls).toHaveLength(options.admitted === false ? 0 : 1);
    },
  );
  it.each([
    { projectId: "" },
    { writerRoot: "relative" },
    { cursor: "bad\0cursor" },
  ])("denies invalid boundary input before reads: %j", async (input) => {
    const f = await fixture({ input });
    expect(f.result).toMatchObject({
      status: "unavailable",
      code: "HANDOFF_PROJECT_TASKS_INPUT_INVALID",
    });
    expect(f.calls).toHaveLength(0);
  });
  it("leaves a failed read unavailable without task effects", async () => {
    const f = await fixture({ throw: true });
    expect(f.result).toMatchObject({ status: "unavailable" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("canonical checkout and selected writer metadata scope", () => {
  const scope = "canonical-and-selected-writer";
  const canonicalRoot = "/fixture/project";
  it("requests only the two exact roots and keeps stored no-control metadata", async () => {
    const second = {
      ...row,
      id: "019b0000-0000-4000-8000-000000000002",
      cwd: canonicalRoot,
    };
    const f = await fixture({
      input: { scope, canonicalRoot },
      page: { data: [row, second], nextCursor: null },
    });
    expect(f.result).toMatchObject({
      status: "tasks",
      scope,
      controlGranted: false,
      complete: true,
      tasks: [{ id }, { id: second.id }],
    });
    expect(f.calls).toMatchObject([
      {
        method: "thread/list",
        params: {
          projectId: "project",
          cwd: [request.writerRoot, canonicalRoot],
          useStateDbOnly: true,
        },
      },
    ]);
  });
  it.each([
    { scope },
    { scope, canonicalRoot: "/fixture/../project" },
    { scope: "all-project", canonicalRoot },
  ])(
    "refuses invalid or missing internal root scope before host I/O: %j",
    async (input) => {
      const f = await fixture({ input });
      expect(f.result.status).toBe("unavailable");
      expect(f.calls).toEqual([]);
    },
  );
  it("refuses an unselected third writer instead of filtering it out", async () => {
    const f = await fixture({
      input: { scope, canonicalRoot },
      page: {
        data: [{ ...row, cwd: "/fixture/another-writer" }],
        nextCursor: null,
      },
    });
    expect(f.result.status).toBe("unavailable");
  });
  it("uses one exact cwd if the canonical checkout is also the selected writer", async () => {
    const f = await fixture({
      input: { scope, canonicalRoot: request.writerRoot },
    });
    expect(f.result).toMatchObject({ status: "tasks", scope });
    expect(f.calls).toMatchObject([{ params: { cwd: request.writerRoot } }]);
  });
});
