import { describe, expect, it } from "vitest";
import type { HandoffWorkspace } from "../port/handoff";
import type { HandoffFlowDeps } from "./handoffdeps";
import { runHistory, runObserve } from "./readflow";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";

const workspace: HandoffWorkspace = {
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project: {
    root: "/work/root/app",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/work/root/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
};

type Handler = (method: string, params: unknown) => unknown;

function deps(
  handler: Handler,
  over: { resolved?: HandoffWorkspace | null; now?: number } = {},
): HandoffFlowDeps {
  return {
    authority: {
      resolve: async () =>
        over.resolved === undefined ? workspace : over.resolved,
    },
    host: { request: async (method, params) => handler(method, params) },
    journal: {} as never,
    digester: {} as never,
    mutationExpiresAt: 100,
    mutationGate: {} as never,
    now: () => over.now ?? 10,
    selectedOwnerThreadId: THREAD_ID,
  };
}

const observeRequest = {
  threadId: THREAD_ID,
  workspaceId: "w1",
  projectId: "p1",
};

const projectList = {
  data: [{ id: "p1", roots: [{ path: "/work/root/app" }] }],
  nextCursor: null,
};

const observeHost: Handler = (method) => {
  if (method === "project/list") return projectList;
  if (method === "thread/read")
    return {
      thread: {
        id: THREAD_ID,
        projectId: "p1",
        cwd: "/work/root",
        name: "Title",
        model: "m1",
      },
    };
  if (method === "thread/turns/list")
    return { data: [{ id: TURN_ID, status: "completed" }], nextCursor: null };
  throw new Error(`unexpected ${method}`);
};

describe("runObserve", () => {
  it("observes the bound thread and its turns", async () => {
    const result = await runObserve(deps(observeHost), observeRequest);
    expect(result).toMatchObject({
      status: "observed",
      threadId: THREAD_ID,
      title: "Title",
      model: "m1",
      hasMoreTurns: false,
      turns: [{ id: TURN_ID, status: "completed" }],
    });
  });

  it("refuses malformed input and an unverified workspace", async () => {
    expect(
      await runObserve(deps(observeHost), { ...observeRequest, threadId: "x" }),
    ).toEqual({ status: "refused", code: "HANDOFF_OBSERVE_INPUT_INVALID" });
    expect(
      await runObserve(deps(observeHost, { resolved: null }), observeRequest),
    ).toEqual({ status: "refused", code: "HANDOFF_WORKSPACE_UNVERIFIED" });
  });

  it("refuses once admission has ended", async () => {
    expect(
      await runObserve(deps(observeHost), observeRequest, { deadlineAt: 5 }),
    ).toEqual({ status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" });
  });

  it("refuses an ambiguous project and a rebound thread", async () => {
    const noProject: Handler = (method, params) =>
      method === "project/list"
        ? { data: [], nextCursor: null }
        : observeHost(method, params);
    expect(await runObserve(deps(noProject), observeRequest)).toEqual({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    const rebound: Handler = (method, params) =>
      method === "thread/read"
        ? { thread: { id: THREAD_ID, projectId: "p2", cwd: "/work/root" } }
        : observeHost(method, params);
    expect(await runObserve(deps(rebound), observeRequest)).toEqual({
      status: "refused",
      code: "HANDOFF_OBSERVE_THREAD_BINDING_CHANGED",
    });
  });

  it("reports outcome_unknown when the provider read fails", async () => {
    const failing: Handler = () => {
      throw new Error("down");
    };
    expect(await runObserve(deps(failing), observeRequest)).toEqual({
      status: "outcome_unknown",
      threadId: THREAD_ID,
    });
  });

  it("refuses when the workspace moves during the read", async () => {
    let calls = 0;
    const moving = deps(observeHost);
    const result = await runObserve(
      {
        ...moving,
        authority: {
          resolve: async () =>
            (calls += 1) === 1 ? workspace : { ...workspace, inode: "9" },
        },
      },
      observeRequest,
    );
    expect(result).toEqual({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
  });
});

const historyRequest = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  workspaceId: "w1",
  projectId: "p1",
};

describe("runHistory", () => {
  it("refuses input that is not the selected owner thread", async () => {
    const result = await runHistory(deps(observeHost), {
      ...historyRequest,
      threadId: TURN_ID,
    });
    expect(result).toMatchObject({
      status: "refused",
      code: "HANDOFF_HISTORY_INPUT_INVALID",
    });
  });

  it("refuses an unverified workspace", async () => {
    const result = await runHistory(
      deps(observeHost, { resolved: null }),
      historyRequest,
    );
    expect(result).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
  });

  it("names cancellation separately from admission expiry", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runHistory(deps(observeHost), historyRequest, {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      status: "refused",
      code: "HANDOFF_HISTORY_CANCELLED",
    });
    const expired = await runHistory(
      deps(observeHost, { now: 100 }),
      historyRequest,
    );
    expect(expired).toMatchObject({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
  });

  it("reports an unavailable verdict when the project catalogue fails", async () => {
    const failing: Handler = () => {
      throw new Error("down");
    };
    const result = await runHistory(deps(failing), historyRequest);
    expect(result).toMatchObject({
      status: "unavailable",
      code: "HANDOFF_PROJECT_CATALOGUE_UNAVAILABLE",
    });
  });
});
