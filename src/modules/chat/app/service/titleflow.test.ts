import { describe, expect, it } from "vitest";
import type {
  HandoffJournal,
  HandoffMutationGate,
  HandoffRecord,
  HandoffTitleRequest,
  HandoffWorkspace,
} from "../port/handoff";
import type { HandoffFlowDeps } from "./handoffdeps";
import { runTitle } from "./titleflow";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST = "b".repeat(64);

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

const baseRecord: HandoffRecord = {
  requestDigest: "d",
  workspaceId: "w1",
  workspace,
  projectId: "p1",
  model: "m1",
  threadId: THREAD_ID,
  turnId: TURN_ID,
  threadIntent: true,
  turnIntent: true,
};

const request: HandoffTitleRequest = {
  key: REQUEST_ID,
  dispatchId: DISPATCH_ID,
  workspaceId: "w1",
  projectId: "p1",
  expectedTitle: "Old",
  title: "New",
};

const gate: HandoffMutationGate = {
  run: async (preflight, effect) => {
    await preflight();
    return effect();
  },
};

function setup(
  options: {
    record?: HandoffRecord | null;
    journal?: Record<string, unknown>;
    now?: number;
    digestTitle?: boolean;
    titleOnRead?: () => string;
    sets?: unknown[];
  } = {},
) {
  let name = "Old";
  const recorded: string[] = [];
  const journal = {
    read: async () =>
      options.record === undefined ? baseRecord : options.record,
    readTitle: async () => null,
    claimTitle: async () => "claimed",
    recordTitle: async (_d: string, _k: string, threadId: string) => {
      recorded.push(threadId);
    },
    hasUnconfirmedMessage: async () => false,
    ...options.journal,
  } as unknown as HandoffJournal;
  const deps: HandoffFlowDeps = {
    authority: { resolve: async () => workspace },
    host: {
      request: async (method, params) => {
        if (method === "project/list")
          return {
            data: [{ id: "p1", roots: [{ path: "/work/root/app" }] }],
            nextCursor: null,
          };
        if (method === "thread/read")
          return {
            thread: {
              id: THREAD_ID,
              projectId: "p1",
              cwd: "/work/root",
              model: "m1",
              name: options.titleOnRead ? options.titleOnRead() : name,
            },
          };
        if (method === "thread/name/set") {
          options.sets?.push(params);
          name = (params as { name: string }).name;
          return {};
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    journal,
    digester:
      options.digestTitle === false
        ? ({} as never)
        : ({ digestTitle: () => DIGEST } as never),
    mutationExpiresAt: 100,
    mutationGate: gate,
    now: () => options.now ?? 10,
    selectedOwnerThreadId: THREAD_ID,
  };
  return { deps, recorded };
}

describe("runTitle", () => {
  it("renames the thread and proves it by readback", async () => {
    const sets: unknown[] = [];
    const { deps, recorded } = setup({ sets });
    expect(await runTitle(deps, request)).toEqual({
      status: "renamed",
      dispatchId: DISPATCH_ID,
      title: "New",
      proof: "readback",
    });
    expect(sets).toEqual([{ threadId: THREAD_ID, name: "New" }]);
    expect(recorded).toEqual([THREAD_ID]);
  });

  it("refuses invalid input, an expired window and a missing journal", async () => {
    const { deps } = setup();
    expect(await runTitle(deps, { ...request, title: "" })).toEqual({
      status: "refused",
      code: "HANDOFF_TITLE_INPUT_INVALID",
    });
    expect(await runTitle(setup({ now: 100 }).deps, request)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(
      await runTitle(
        setup({ journal: { claimTitle: undefined } }).deps,
        request,
      ),
    ).toEqual({ status: "refused", code: "HANDOFF_TITLE_UNAVAILABLE" });
    expect(await runTitle(setup({ digestTitle: false }).deps, request)).toEqual(
      { status: "refused", code: "HANDOFF_TITLE_UNAVAILABLE" },
    );
  });

  it("refuses an unknown, adopted or rebound dispatch", async () => {
    expect(await runTitle(setup({ record: null }).deps, request)).toEqual({
      status: "refused",
      code: "HANDOFF_DISPATCH_UNKNOWN",
    });
    expect(
      await runTitle(
        setup({ record: { ...baseRecord, adopted: true } }).deps,
        request,
      ),
    ).toEqual({ status: "refused", code: "HANDOFF_ADOPTED_READ_ONLY" });
    expect(
      await runTitle(setup().deps, { ...request, projectId: "p2" }),
    ).toEqual({ status: "refused", code: "HANDOFF_DISPATCH_BINDING_CHANGED" });
  });

  it("reports outcome_unknown for an unverified continuation", async () => {
    const result = await runTitle(
      setup({ record: { ...baseRecord, continuedFrom: REQUEST_ID } }).deps,
      request,
    );
    expect(result).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
  });

  it("returns the current name when it differs from the expected one", async () => {
    const result = await runTitle(
      setup({ titleOnRead: () => "Changed" }).deps,
      request,
    );
    expect(result).toEqual({
      status: "title_changed",
      dispatchId: DISPATCH_ID,
      title: "Changed",
    });
  });

  it("refuses a conflicting claim and replays a recorded one", async () => {
    expect(
      await runTitle(
        setup({ journal: { claimTitle: async () => "conflict" } }).deps,
        request,
      ),
    ).toEqual({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
    expect(
      await runTitle(
        setup({
          journal: {
            readTitle: async () => ({ digest: "c".repeat(64), threadId: null }),
          },
        }).deps,
        request,
      ),
    ).toEqual({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
  });

  it("never resends after an unconfirmed message", async () => {
    const result = await runTitle(
      setup({ journal: { hasUnconfirmedMessage: async () => true } }).deps,
      request,
    );
    expect(result).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
  });

  it("degrades a journal failure to outcome_unknown", async () => {
    const result = await runTitle(
      setup({
        journal: {
          read: async () => {
            throw new Error("disk");
          },
        },
      }).deps,
      request,
    );
    expect(result).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
  });
});
