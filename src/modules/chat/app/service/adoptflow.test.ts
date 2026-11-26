import { describe, expect, it } from "vitest";
import type {
  HandoffJournal,
  HandoffRecord,
  HandoffWorkspace,
} from "../port/handoff";
import { runAdopt } from "./adoptflow";
import type { HandoffFlowDeps } from "./handoffdeps";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);

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

const request = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  workspaceId: "w1",
  projectId: "p1",
};

type Observed = Awaited<
  Parameters<typeof runAdopt>[1] extends (...a: never[]) => infer R ? R : never
>;

function setup(
  options: {
    observed?: Observed;
    resolved?: HandoffWorkspace | null;
    now?: number;
    digest?: string;
    selected?: string;
  } = {},
) {
  const store = new Map<string, HandoffRecord>();
  const journal = {
    read: async (key: string) => store.get(key) ?? null,
    reserve: async (key: string, record: HandoffRecord) => {
      store.set(key, record);
      return record;
    },
    claimThread: async (key: string) => {
      store.set(key, { ...store.get(key)!, threadIntent: true });
      return true;
    },
    recordThread: async (key: string, threadId: string) => {
      store.set(key, { ...store.get(key)!, threadId });
    },
    claimTurn: async (key: string) => {
      store.set(key, { ...store.get(key)!, turnIntent: true });
      return true;
    },
    recordTurn: async (key: string, turnId: string) => {
      store.set(key, { ...store.get(key)!, turnId });
    },
  } as unknown as HandoffJournal;
  const deps: HandoffFlowDeps = {
    authority: {
      resolve: async () =>
        options.resolved === undefined ? workspace : options.resolved,
    },
    host: { request: async () => ({}) },
    journal,
    digester: {
      digestAdopt: () => options.digest ?? DIGEST,
    } as never,
    mutationExpiresAt: 100,
    mutationGate: {} as never,
    now: () => options.now ?? 10,
    selectedOwnerThreadId: options.selected ?? THREAD_ID,
  };
  const observe = async () =>
    options.observed ??
    ({
      status: "observed",
      threadId: THREAD_ID,
      title: null,
      model: "m1",
      turns: [{ id: TURN_ID, status: "completed" }],
      hasMoreTurns: false,
      threadRuntime: {} as never,
    } as unknown as Observed);
  return { deps, observe, store };
}

describe("runAdopt", () => {
  it("records the observed thread and turn", async () => {
    const { deps, observe, store } = setup();
    expect(await runAdopt(deps, observe, request)).toEqual({
      status: "adopted",
      dispatchId: TURN_ID,
    });
    expect(store.get(TURN_ID)).toMatchObject({
      adopted: true,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
  });

  it("refuses a thread that is not the selected owner thread", async () => {
    const { deps, observe } = setup({ selected: TURN_ID });
    expect(await runAdopt(deps, observe, request)).toEqual({
      status: "refused",
      code: "HANDOFF_ADOPT_DENIED",
    });
  });

  it("refuses once the mutation window has closed", async () => {
    const { deps, observe } = setup({ now: 100 });
    expect(await runAdopt(deps, observe, request)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
  });

  it("refuses an unverified workspace and an invalid digest", async () => {
    const unverified = setup({ resolved: null });
    expect(
      await runAdopt(unverified.deps, unverified.observe, request),
    ).toEqual({ status: "refused", code: "HANDOFF_WORKSPACE_UNVERIFIED" });
    const badDigest = setup({ digest: "nope" });
    expect(await runAdopt(badDigest.deps, badDigest.observe, request)).toEqual({
      status: "refused",
      code: "HANDOFF_DIGEST_INVALID",
    });
  });

  it("passes an observation refusal through unchanged", async () => {
    const { deps, observe } = setup({
      observed: { status: "refused", code: "X" } as Observed,
    });
    expect(await runAdopt(deps, observe, request)).toEqual({
      status: "refused",
      code: "X",
    });
  });

  it("treats an unobserved or ambiguous turn as outcome_unknown", async () => {
    const unknown = { status: "outcome_unknown", dispatchId: TURN_ID };
    const unobserved = setup({
      observed: { status: "outcome_unknown", threadId: THREAD_ID } as Observed,
    });
    expect(
      await runAdopt(unobserved.deps, unobserved.observe, request),
    ).toEqual(unknown);
    const twice = setup({
      observed: {
        status: "observed",
        turns: [
          { id: TURN_ID, status: "completed" },
          { id: TURN_ID, status: "completed" },
        ],
        hasMoreTurns: false,
      } as unknown as Observed,
    });
    expect(await runAdopt(twice.deps, twice.observe, request)).toEqual(unknown);
  });

  it("distinguishes a missing turn from an unseen page", async () => {
    const missing = setup({
      observed: {
        status: "observed",
        turns: [],
        hasMoreTurns: false,
      } as unknown as Observed,
    });
    expect(await runAdopt(missing.deps, missing.observe, request)).toEqual({
      status: "refused",
      code: "HANDOFF_ADOPT_TURN_MISSING",
    });
    const more = setup({
      observed: {
        status: "observed",
        turns: [],
        hasMoreTurns: true,
      } as unknown as Observed,
    });
    expect(await runAdopt(more.deps, more.observe, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: TURN_ID,
    });
  });

  it("reports outcome_unknown when the journal throws", async () => {
    const { deps, observe } = setup();
    const broken = {
      ...deps,
      journal: {
        read: async () => {
          throw new Error("disk");
        },
      } as unknown as HandoffJournal,
    };
    expect(await runAdopt(broken, observe, request)).toEqual({
      status: "outcome_unknown",
      dispatchId: TURN_ID,
    });
  });
});
