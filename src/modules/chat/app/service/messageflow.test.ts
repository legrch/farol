import { describe, expect, it } from "vitest";
import type {
  HandoffJournal,
  HandoffMessage,
  HandoffMutationGate,
  HandoffRecord,
  HandoffStatusResult,
  HandoffWorkspace,
} from "../port/handoff";
import type { HandoffFlowDeps } from "./handoffdeps";
import { runMessage } from "./messageflow";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST = "c".repeat(64);

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

const request: HandoffMessage = {
  key: REQUEST_ID,
  dispatchId: DISPATCH_ID,
  workspaceId: "w1",
  projectId: "p1",
  message: "hello",
  model: "m1",
};

const gate: HandoffMutationGate = {
  run: async (preflight, effect) => {
    await preflight();
    return effect();
  },
};

const active: HandoffStatusResult = {
  status: "known",
  dispatchId: DISPATCH_ID,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  turnStatus: "inProgress",
  threadRuntime: {} as never,
};

function setup(
  options: {
    record?: HandoffRecord | null;
    journal?: Record<string, unknown>;
    now?: number;
    status?: HandoffStatusResult;
    steerTurnId?: string;
    steers?: unknown[];
  } = {},
) {
  const recorded: string[] = [];
  const journal = {
    read: async () =>
      options.record === undefined ? baseRecord : options.record,
    readMessage: async () => null,
    claimMessage: async () => "claimed",
    recordMessage: async (_d: string, _k: string, turnId: string) => {
      recorded.push(turnId);
    },
    hasUnconfirmedTitle: async () => false,
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
            },
          };
        if (method === "turn/steer") {
          options.steers?.push(params);
          return { turnId: options.steerTurnId ?? TURN_ID };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    journal,
    digester: { digestMessage: () => DIGEST } as never,
    mutationExpiresAt: 100,
    mutationGate: gate,
    now: () => options.now ?? 10,
    selectedOwnerThreadId: THREAD_ID,
  };
  const status = async () => options.status ?? active;
  return { deps, status, recorded };
}

describe("runMessage", () => {
  it("steers the active turn and records the receipt", async () => {
    const steers: unknown[] = [];
    const { deps, status, recorded } = setup({ steers });
    expect(await runMessage(deps, status, request)).toEqual({
      status: "steered",
      dispatchId: DISPATCH_ID,
      turnId: TURN_ID,
    });
    expect(steers).toHaveLength(1);
    expect(recorded).toEqual([TURN_ID]);
  });

  it("refuses invalid input and an expired window", async () => {
    const { deps, status } = setup();
    expect(await runMessage(deps, status, { ...request, message: "" })).toEqual(
      { status: "refused", code: "HANDOFF_INPUT_INVALID" },
    );
    const expired = setup({ now: 100 });
    expect(await runMessage(expired.deps, expired.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
  });

  it("refuses an unknown, adopted or rebound dispatch", async () => {
    const unknown = setup({ record: null });
    expect(await runMessage(unknown.deps, unknown.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_DISPATCH_UNKNOWN",
    });
    const adopted = setup({ record: { ...baseRecord, adopted: true } });
    expect(await runMessage(adopted.deps, adopted.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_ADOPTED_READ_ONLY",
    });
    const rebound = setup();
    expect(
      await runMessage(rebound.deps, rebound.status, {
        ...request,
        model: "m2",
      }),
    ).toEqual({ status: "refused", code: "HANDOFF_DISPATCH_BINDING_CHANGED" });
  });

  it("replays a recorded claim and refuses a different digest", async () => {
    const replay = setup({
      journal: {
        readMessage: async () => ({ digest: DIGEST, turnId: TURN_ID }),
      },
    });
    expect(await runMessage(replay.deps, replay.status, request)).toEqual({
      status: "steered",
      dispatchId: DISPATCH_ID,
      turnId: TURN_ID,
    });
    const conflict = setup({
      journal: {
        readMessage: async () => ({ digest: "d".repeat(64), turnId: TURN_ID }),
      },
    });
    expect(await runMessage(conflict.deps, conflict.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_KEY_CONFLICT",
    });
  });

  it("refuses when the turn is not active and stays unknown otherwise", async () => {
    const done = setup({
      status: { ...active, turnStatus: "completed" } as never,
    });
    expect(await runMessage(done.deps, done.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_TURN_NOT_ACTIVE",
    });
    const unknown = setup({
      status: { status: "outcome_unknown", dispatchId: DISPATCH_ID },
    });
    expect(await runMessage(unknown.deps, unknown.status, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
  });

  it("holds an unconfirmed title and a lost claim as outcome_unknown", async () => {
    const title = setup({
      journal: { hasUnconfirmedTitle: async () => true },
    });
    expect(await runMessage(title.deps, title.status, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
    const existing = setup({
      journal: { claimMessage: async () => "existing" },
    });
    expect(await runMessage(existing.deps, existing.status, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
    const conflict = setup({
      journal: { claimMessage: async () => "conflict" },
    });
    expect(await runMessage(conflict.deps, conflict.status, request)).toEqual({
      status: "refused",
      code: "HANDOFF_KEY_CONFLICT",
    });
  });

  it("does not record a receipt when the provider answers for another turn", async () => {
    const wrong = setup({ steerTurnId: DISPATCH_ID });
    expect(await runMessage(wrong.deps, wrong.status, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: DISPATCH_ID,
    });
    expect(wrong.recorded).toEqual([]);
  });
});
