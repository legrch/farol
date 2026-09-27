import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  PersistentCodexHandoff,
  HandoffNotSubmittedError,
  type HandoffAuthority,
  type HandoffHost,
  type HandoffJournal,
  type HandoffMutationGate,
  type HandoffRecord,
  type HandoffRequest,
  type HandoffRequestDigester,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";

const key = randomUUID();
const workspace: HandoffWorkspace = {
  root: "/approved/writer",
  device: "4",
  inode: "57",
  gitCommonDirectory: "/approved/project/.git",
  project: {
    root: "/approved/project",
    device: "4",
    inode: "12",
    gitCommonDirectory: "/approved/project/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
};
const request: HandoffRequest = {
  key,
  workspaceId: "workspace-a",
  projectId: "saved-project",
  message: "Do one bounded task",
  model: "selected-model",
  reasoningEffort: "medium",
};
const mutationGate: HandoffMutationGate = {
  run: async (preflight, effect) => {
    await preflight();
    return effect();
  },
};

class FixtureHost implements HandoffHost {
  readonly calls: string[] = [];
  projects: unknown[] = [
    { id: "saved-project", roots: [{ path: workspace.project.root }] },
  ];
  failThread = false;
  failTurn = false;
  failSteer = false;
  steerError: Error | undefined;
  steerResponse?: unknown;
  failProject = false;
  failStatus = false;
  failItems = false;
  turnStatus = "inProgress";
  onProjectList?: (() => void) | undefined;
  onTurnStart?: (() => void) | undefined;
  onTurnsList?: (() => unknown) | undefined;
  threadResponse?: unknown;
  turnResponse?: unknown;
  readResponse?: unknown;
  turnsResponse?: unknown;
  itemsResponse?: unknown;
  pagedItems = false;
  pagedProjects = false;
  badProjectCursor = false;
  pagedTurns = false;

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push(method);
    if (method === "project/list") {
      if (this.failProject) throw new Error("PROJECT_LIST_FAILED");
      this.onProjectList?.();
      if (this.badProjectCursor) return { data: [], nextCursor: "" };
      if (this.pagedProjects) {
        return (params as { cursor: string | null }).cursor === null
          ? { data: [], nextCursor: "next" }
          : { data: this.projects, nextCursor: null };
      }
      return { data: this.projects, nextCursor: null };
    }
    if (method === "thread/start") {
      if (this.failThread) throw new Error("ACK_LOST");
      if (this.threadResponse !== undefined) return this.threadResponse;
      expect(params).toMatchObject({
        projectId: request.projectId,
        cwd: workspace.root,
        ephemeral: false,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        allowProviderModelFallback: false,
      });
      return {
        cwd: workspace.root,
        model: request.model,
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        thread: { id: "issued-thread", projectId: request.projectId },
      };
    }
    if (method === "turn/start") {
      this.onTurnStart?.();
      if (this.failTurn) throw new Error("ACK_LOST");
      if (this.turnResponse !== undefined) return this.turnResponse;
      expect(params).toMatchObject({
        threadId: "issued-thread",
        input: [{ type: "text", text: request.message }],
        effort: "medium",
        model: request.model,
        cwd: workspace.root,
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace.root],
          networkAccess: false,
        },
      });
      return { turn: { id: "issued-turn", status: "inProgress" } };
    }
    if (method === "turn/steer") {
      if (this.failSteer) throw new Error("ACK_LOST");
      if (this.steerError) throw this.steerError;
      if (this.steerResponse !== undefined) return this.steerResponse;
      expect(params).toMatchObject({
        threadId: "issued-thread",
        expectedTurnId: "issued-turn",
        input: [{ type: "text", text: "One steer" }],
      });
      return { turnId: "issued-turn" };
    }
    if (method === "thread/read") {
      if (this.failStatus) throw new Error("STATUS_UNAVAILABLE");
      if (this.readResponse !== undefined) return this.readResponse;
      return {
        thread: {
          id: "issued-thread",
          projectId: request.projectId,
          cwd: workspace.root,
          model: request.model,
        },
      };
    }
    if (method === "thread/turns/list") {
      if (this.onTurnsList) return this.onTurnsList();
      if (this.turnsResponse !== undefined) return this.turnsResponse;
      if (this.pagedTurns) {
        return (params as { cursor: string | null }).cursor === null
          ? {
              data: [{ id: "other-turn", status: "completed" }],
              nextCursor: "next",
            }
          : {
              data: [{ id: "issued-turn", status: this.turnStatus }],
              nextCursor: null,
            };
      }
      return {
        data: [{ id: "issued-turn", status: this.turnStatus }],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      if (this.failItems) throw new Error("ITEMS_UNAVAILABLE");
      if (this.itemsResponse !== undefined) return this.itemsResponse;
      expect(params).toMatchObject({
        threadId: "issued-thread",
        turnId: "issued-turn",
      });
      if (this.pagedItems) {
        return (params as { cursor: string | null }).cursor === null
          ? {
              data: [
                {
                  turnId: "issued-turn",
                  item: {
                    id: "progress",
                    type: "agentMessage",
                    phase: "commentary",
                    text: "Working",
                  },
                },
              ],
              nextCursor: "next",
            }
          : {
              data: [
                {
                  turnId: "issued-turn",
                  item: {
                    id: "answer",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "Exact result",
                  },
                },
              ],
              nextCursor: null,
            };
      }
      return {
        data: [
          {
            turnId: "issued-turn",
            item: {
              id: "answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "Exact result",
            },
          },
        ],
        nextCursor: null,
      };
    }
    throw new Error("UNEXPECTED_METHOD");
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture(host = new FixtureHost()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-handoff-"));
  roots.push(root);
  let current: HandoffWorkspace | null = workspace;
  const authority: HandoffAuthority = { resolve: async () => current };
  const journalRoot = path.join(root, "journal");
  const service = () =>
    new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
  return {
    host,
    service,
    authority,
    journalRoot,
    setWorkspace(value: HandoffWorkspace | null) {
      current = value;
    },
  };
}

function byteBudgetFixture() {
  let authorityCalls = 0;
  let journalCalls = 0;
  let record: HandoffRecord | null = null;
  const hostCalls: string[] = [];
  let forwardedMessage: string | null = null;
  const journal: HandoffJournal = {
    async claimMessage() {
      return "claimed";
    },
    async readMessage() {
      return null;
    },
    async recordMessage() {},
    async read() {
      journalCalls += 1;
      return record;
    },
    async reserve(_key, value) {
      journalCalls += 1;
      record ??= value;
      return record;
    },
    async claimThread() {
      journalCalls += 1;
      if (!record || record.threadIntent) return false;
      record = { ...record, threadIntent: true };
      return true;
    },
    async recordThread(_key, threadId) {
      journalCalls += 1;
      if (!record) throw new Error("MISSING_RECORD");
      record = { ...record, threadId };
    },
    async claimTurn() {
      journalCalls += 1;
      if (!record || record.turnIntent) return false;
      record = { ...record, turnIntent: true };
      return true;
    },
    async recordTurn(_key, turnId) {
      journalCalls += 1;
      if (!record) throw new Error("MISSING_RECORD");
      record = { ...record, turnId };
    },
  };
  const host: HandoffHost = {
    async request(method, params) {
      hostCalls.push(method);
      if (method === "project/list")
        return {
          data: [
            {
              id: request.projectId,
              roots: [{ path: workspace.project.root }],
            },
          ],
          nextCursor: null,
        };
      if (method === "thread/start")
        return {
          cwd: workspace.root,
          model: request.model,
          approvalPolicy: workspace.execution.approvalPolicy,
          sandbox: { type: "workspaceWrite" },
          thread: { id: "issued-thread", projectId: request.projectId },
        };
      if (method === "turn/start") {
        forwardedMessage = (params as { input: [{ text: string }] }).input[0]
          .text;
        return { turn: { id: "issued-turn", status: "inProgress" } };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    },
  };
  const service = new PersistentCodexHandoff(
    {
      async resolve() {
        authorityCalls += 1;
        return workspace;
      },
    },
    host,
    journal,
    new Sha256HandoffRequestDigester(),
    Date.now() + 60_000,
    mutationGate,
  );
  return {
    service,
    counts: () => ({ authorityCalls, journalCalls, hostCalls }),
    forwarded: () => forwardedMessage,
  };
}

describe("persistent Codex handoff core", () => {
  it("observes only the exact selected native thread without starting work", async () => {
    const { service, host, setWorkspace } = await fixture();
    const threadId = randomUUID();
    const selection = {
      threadId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    };
    host.readResponse = {
      thread: {
        id: threadId,
        projectId: request.projectId,
        cwd: workspace.root,
        title: "Owner-selected task",
        model: "gpt-6-luna",
      },
    };
    host.turnsResponse = {
      data: [{ id: randomUUID(), status: "inProgress" }],
      nextCursor: "more",
    };
    expect(await service().observe(selection)).toMatchObject({
      status: "observed",
      threadId,
      title: "Owner-selected task",
      model: "gpt-6-luna",
      hasMoreTurns: true,
      turns: [{ status: "inProgress" }],
    });
    expect(host.calls).toEqual([
      "project/list",
      "thread/read",
      "thread/turns/list",
    ]);
    host.calls.length = 0;
    host.readResponse = {
      thread: {
        id: threadId,
        projectId: request.projectId,
        cwd: "/different/worktree",
      },
    };
    expect(await service().observe(selection)).toEqual({
      status: "refused",
      code: "HANDOFF_OBSERVE_THREAD_BINDING_CHANGED",
    });
    expect(host.calls).toEqual(["project/list", "thread/read"]);
    host.calls.length = 0;
    host.readResponse = {
      thread: {
        id: threadId,
        projectId: request.projectId,
        cwd: workspace.root,
      },
    };
    host.turnsResponse = {
      data: [{ id: "turn", status: "invented" }],
      nextCursor: null,
    };
    expect(await service().observe(selection)).toEqual({
      status: "outcome_unknown",
      threadId,
    });
    expect(host.calls).toEqual([
      "project/list",
      "thread/read",
      "thread/turns/list",
    ]);
    host.calls.length = 0;
    setWorkspace(null);
    expect(await service().observe(selection)).toEqual({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
    expect(host.calls).toEqual([]);
    expect(
      await service().observe({ ...selection, threadId: "../other" }),
    ).toEqual({
      status: "refused",
      code: "HANDOFF_OBSERVE_INPUT_INVALID",
    });
    expect(host.calls).toEqual([]);
  });

  it("fails closed on unavailable digest, unknown parent, malformed digest, and unavailable host read", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    const sha = new Sha256HandoffRequestDigester();
    const withoutDigest = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      {
        digest: (value) => sha.digest(value),
        digestMessage: (value) => sha.digestMessage(value),
      },
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await withoutDigest.continue(child)).toEqual({
      status: "refused",
      code: "HANDOFF_CONTINUE_UNAVAILABLE",
    });
    const invalidDigest = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      {
        digest: (value) => sha.digest(value),
        digestMessage: (value) => sha.digestMessage(value),
        digestContinue: () => "invalid",
      },
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await invalidDigest.continue(child)).toEqual({
      status: "refused",
      code: "HANDOFF_DIGEST_INVALID",
    });
    const absent = { ...child, dispatchId: randomUUID() };
    expect(await service().continue(absent)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    const originalCheck = journal.hasUnconfirmedMessage.bind(journal);
    journal.hasUnconfirmedMessage = async () => {
      throw new Error("JOURNAL_UNREADABLE");
    };
    const journalFault = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      sha,
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await journalFault.continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    journal.hasUnconfirmedMessage = originalCheck;
    host.failStatus = true;
    expect(await service().continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("refuses continuation when an old task lacks an exact model and effort binding", async () => {
    const host = new FixtureHost();
    host.turnResponse = { turn: { id: "issued-turn" } };
    const { service } = await fixture(host);
    const original = {
      ...request,
      key: randomUUID(),
      reasoningEffort: undefined,
    };
    expect((await service().create(original)).status).toBe("dispatched");
    expect(
      await service().continue({
        key: randomUUID(),
        dispatchId: original.key,
        message: "No guessed effort",
      }),
    ).toEqual({
      status: "refused",
      code: "HANDOFF_CONTINUE_MODEL_BINDING_MISSING",
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("recovers known pre-effect journal refusals with the same key and no duplicate send", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    let started = false;
    host.turnResponse = { turn: { id: "continued-turn" } };
    host.onTurnStart = () => {
      started = true;
    };
    host.onTurnsList = () => ({
      data: started
        ? [
            { id: "continued-turn", status: "completed" },
            { id: "issued-turn", status: "completed" },
          ]
        : [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    const originalReserve = journal.reserve.bind(journal);
    const originalClaimThread = journal.claimThread.bind(journal);
    const originalClaimContinuation = journal.claimContinuation.bind(journal);
    const current = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    journal.reserve = async () => {
      throw new Error("RESERVATION_IO_FAILED");
    };
    expect((await current.continue(child)).status).toBe("outcome_unknown");
    journal.reserve = originalReserve;
    journal.claimThread = async () => false;
    expect((await current.continue(child)).status).toBe("outcome_unknown");
    journal.claimThread = originalClaimThread;
    journal.claimContinuation = async () => {
      throw new Error("PARENT_RESERVATION_IO_FAILED");
    };
    expect((await current.continue(child)).status).toBe("outcome_unknown");
    journal.claimContinuation = originalClaimContinuation;
    expect((await current.continue(child)).status).toBe("dispatched");
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      2,
    );
  });

  it("rechecks latest parent and deadline inside the mutation gate before any turn/start", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    let reads = 0;
    host.onTurnsList = () => ({
      data: [
        {
          id: ++reads === 1 ? "issued-turn" : "native-turn",
          status: "completed",
        },
      ],
      nextCursor: null,
    });
    expect((await service().continue(child)).status).toBe("outcome_unknown");
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    expect((await journal.read(child.key))?.turnIntent).toBe(false);
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    let now = 0;
    const expiresDuringGate: HandoffMutationGate = {
      async run(preflight, effect) {
        await preflight();
        now = 3;
        return effect();
      },
    };
    const timeBound = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      2,
      expiresDuringGate,
      () => now,
    );
    expect((await timeBound.continue(child)).status).toBe("outcome_unknown");
    expect((await journal.read(child.key))?.turnIntent).toBe(false);
    journal.claimTurn = async () => false;
    const claimedElsewhere = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    expect((await claimedElsewhere.continue(child)).status).toBe(
      "outcome_unknown",
    );
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("rechecks the physical writer after durable claim and before turn/start", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot, setWorkspace } =
      await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    const originalClaim = journal.claimTurn.bind(journal);
    journal.claimTurn = async (key) => {
      const claimed = await originalClaim(key);
      setWorkspace({ ...workspace, inode: "replaced-after-intent" });
      return claimed;
    };
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Do not send",
    };
    const contested = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await contested.continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    expect(await journal.read(child.key)).toMatchObject({
      turnIntent: true,
      continuationVerified: false,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("rejects a changed key and a second child of the same parent even with stale host history", async () => {
    const host = new FixtureHost();
    const { service } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const first = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "First child",
    };
    let started = false;
    host.turnResponse = { turn: { id: "continued-turn" } };
    host.onTurnStart = () => {
      started = true;
    };
    host.onTurnsList = () => ({
      data: started
        ? [
            { id: "continued-turn", status: "completed" },
            { id: "issued-turn", status: "completed" },
          ]
        : [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    expect((await service().continue(first)).status).toBe("dispatched");
    expect(
      await service().continue({ ...first, message: "Changed child" }),
    ).toEqual({
      status: "refused",
      code: "HANDOFF_CONTINUE_KEY_CONFLICT",
    });
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    expect(
      await service().continue({
        key: randomUUID(),
        dispatchId: request.key,
        message: "Second child",
      }),
    ).toEqual({ status: "refused", code: "HANDOFF_CONTINUE_PARENT_RESERVED" });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      2,
    );
  });

  it("keeps an unreadable latest-turn check and malformed start response outcome-unknown", async () => {
    const host = new FixtureHost();
    const { service } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const first = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    host.onTurnsList = () => {
      throw new Error("HISTORY_UNAVAILABLE");
    };
    expect(await service().continue(first)).toEqual({
      status: "outcome_unknown",
      dispatchId: first.key,
    });
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    host.turnResponse = { turn: { id: "" } };
    expect(await service().continue(first)).toEqual({
      status: "outcome_unknown",
      dispatchId: first.key,
    });
    const sends = host.calls.filter((method) => method === "turn/start").length;
    expect(await service().continue(first)).toEqual({
      status: "outcome_unknown",
      dispatchId: first.key,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      sends,
    );
  });

  it("refuses invalid, expired, unbound and stale continuation inputs before host effects", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    expect(await service().continue({ ...child, message: "\0" })).toEqual({
      status: "refused",
      code: "HANDOFF_CONTINUE_INPUT_INVALID",
    });
    const expired = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() - 1,
      mutationGate,
    );
    expect(await expired.continue(child)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    host.projects = [];
    expect(await service().continue(child)).toEqual({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    host.projects = [
      { id: request.projectId, roots: [{ path: workspace.project.root }] },
    ];
    host.readResponse = { thread: { id: "other-thread" } };
    expect(await service().continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    host.readResponse = undefined;
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "inProgress" }],
      nextCursor: null,
    });
    expect(await service().continue(child)).toEqual({
      status: "refused",
      code: "HANDOFF_CONTINUE_PARENT_NOT_LATEST",
    });
    expect(
      await new PrivateCodexHandoffJournal(journalRoot).read(child.key),
    ).toBeNull();
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("retains an unknown send-intent after turn/start failure and never sends on replay", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    host.onTurnsList = () => ({
      data: [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    host.failTurn = true;
    const child = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue",
    };
    let safeToRelease: boolean | null = null;
    const gate: HandoffMutationGate = {
      async run(preflight, effect, classify) {
        await preflight();
        try {
          return await effect();
        } catch (error) {
          safeToRelease = classify(error);
          throw error;
        }
      },
    };
    const failing = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      gate,
    );
    expect(await failing.continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    expect(safeToRelease).toBe(false);
    host.failTurn = false;
    const sends = host.calls.filter((method) => method === "turn/start").length;
    expect(await service().continue(child)).toEqual({
      status: "outcome_unknown",
      dispatchId: child.key,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      sends,
    );
  });

  it("will not continue a parent with an unconfirmed active-steer intent", async () => {
    const host = new FixtureHost();
    const { service, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    expect(
      await journal.claimMessage(request.key, randomUUID(), "a".repeat(64)),
    ).toBe("claimed");
    const continuation = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Do not continue",
    };
    expect(await service().continue(continuation)).toEqual({
      status: "outcome_unknown",
      dispatchId: continuation.key,
    });
    expect(await journal.read(continuation.key)).toBeNull();
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });
  it("does not strand a known pre-effect continuation when the mutation gate refuses", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const continuation = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue once",
    };
    let started = false;
    host.turnResponse = { turn: { id: "continued-turn" } };
    host.onTurnStart = () => {
      started = true;
    };
    host.onTurnsList = () => ({
      data: started
        ? [
            { id: "continued-turn", status: "completed" },
            { id: "issued-turn", status: "completed" },
          ]
        : [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    const fenced = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      {
        run: async () => {
          throw new Error("SUMMARY_FENCE_ACTIVE");
        },
      },
    );
    expect(await fenced.continue(continuation)).toEqual({
      status: "outcome_unknown",
      dispatchId: continuation.key,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(
      (await new PrivateCodexHandoffJournal(journalRoot).read(continuation.key))
        ?.turnIntent,
    ).toBe(false);
    expect(await service().continue(continuation)).toMatchObject({
      status: "dispatched",
      threadId: "issued-thread",
      turnId: "continued-turn",
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      2,
    );
  });

  it("refuses continuation after physical workspace revocation before reserving a child", async () => {
    const host = new FixtureHost();
    const { service, setWorkspace, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const continuation = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue once",
    };
    setWorkspace({ ...workspace, inode: "changed" });
    expect(await service().continue(continuation)).toEqual({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
    expect(
      await new PrivateCodexHandoffJournal(journalRoot).read(continuation.key),
    ).toBeNull();
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("continues the same thread once and replays only a turn-bound confirmed receipt", async () => {
    const host = new FixtureHost();
    const { service, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const continuation = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue once",
    };
    let started = false;
    host.turnResponse = { turn: { id: "continued-turn" } };
    host.onTurnStart = () => {
      started = true;
    };
    host.onTurnsList = () => ({
      data: started
        ? [
            { id: "continued-turn", status: "inProgress" },
            { id: "issued-turn", status: "completed" },
          ]
        : [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    expect(await service().continue(continuation)).toEqual({
      status: "dispatched",
      dispatchId: continuation.key,
      threadId: "issued-thread",
      turnId: "continued-turn",
    });
    const confirmation = await fs.readFile(
      path.join(journalRoot, continuation.key, "continuation-verified.json"),
      "utf8",
    );
    expect(JSON.parse(confirmation)).toBe("continued-turn");
    const sends = host.calls.filter((method) => method === "turn/start").length;
    expect(await service().continue(continuation)).toMatchObject({
      status: "dispatched",
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      sends,
    );
    expect(await service().status(continuation.key)).toMatchObject({
      status: "known",
      threadId: "issued-thread",
      turnId: "continued-turn",
    });
  });

  it.each(["interleaved-native-turn", "post-start-read-failed"])(
    "keeps an unverified continuation unknown after %s even when later history looks healthy",
    async (failure) => {
      const host = new FixtureHost();
      const { service } = await fixture(host);
      expect((await service().create(request)).status).toBe("dispatched");
      const continuation = {
        key: randomUUID(),
        dispatchId: request.key,
        message: "Continue once",
      };
      let started = false;
      let recovered = false;
      host.turnResponse = { turn: { id: "continued-turn" } };
      host.onTurnStart = () => {
        started = true;
      };
      host.onTurnsList = () => {
        if (started && !recovered && failure === "post-start-read-failed")
          throw new Error("POST_START_READ_LOST");
        return {
          data:
            started && !recovered && failure === "interleaved-native-turn"
              ? [
                  { id: "native-turn", status: "inProgress" },
                  { id: "continued-turn", status: "inProgress" },
                ]
              : started
                ? [
                    { id: "continued-turn", status: "inProgress" },
                    { id: "issued-turn", status: "completed" },
                  ]
                : [{ id: "issued-turn", status: "completed" }],
          nextCursor: null,
        };
      };
      expect(await service().continue(continuation)).toEqual({
        status: "outcome_unknown",
        dispatchId: continuation.key,
      });
      recovered = true;
      const sends = host.calls.filter(
        (method) => method === "turn/start",
      ).length;
      expect(await service().continue(continuation)).toEqual({
        status: "outcome_unknown",
        dispatchId: continuation.key,
      });
      expect(await service().status(continuation.key)).toEqual({
        status: "outcome_unknown",
        dispatchId: continuation.key,
      });
      expect(await service().result(continuation.key)).toEqual({
        status: "outcome_unknown",
        dispatchId: continuation.key,
      });
      expect(
        await service().continue({
          key: randomUUID(),
          dispatchId: continuation.key,
          message: "Do not chain",
        }),
      ).toEqual({ status: "outcome_unknown", dispatchId: expect.any(String) });
      expect(
        host.calls.filter((method) => method === "turn/start"),
      ).toHaveLength(sends);
    },
  );

  it("keeps a failed verification publication unknown without a second send", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    expect((await service().create(request)).status).toBe("dispatched");
    const continuation = {
      key: randomUUID(),
      dispatchId: request.key,
      message: "Continue once",
    };
    let started = false;
    host.turnResponse = { turn: { id: "continued-turn" } };
    host.onTurnStart = () => {
      started = true;
    };
    host.onTurnsList = () => ({
      data: started
        ? [
            { id: "continued-turn", status: "inProgress" },
            { id: "issued-turn", status: "completed" },
          ]
        : [{ id: "issued-turn", status: "completed" }],
      nextCursor: null,
    });
    const durable = new PrivateCodexHandoffJournal(journalRoot);
    const failingJournal: HandoffJournal = {
      reserve: (key, record) => durable.reserve(key, record),
      claimThread: (key) => durable.claimThread(key),
      recordThread: (key, id) => durable.recordThread(key, id),
      claimTurn: (key) => durable.claimTurn(key),
      recordTurn: (key, id) => durable.recordTurn(key, id),
      claimContinuation: (parent, turn, key) =>
        durable.claimContinuation(parent, turn, key),
      confirmContinuation: async () => {
        throw new Error("RECEIPT_PUBLICATION_FAILED");
      },
      hasUnconfirmedMessage: (dispatch) =>
        durable.hasUnconfirmedMessage(dispatch),
      read: (key) => durable.read(key),
      claimMessage: (dispatch, key, digest) =>
        durable.claimMessage(dispatch, key, digest),
      readMessage: (dispatch, key) => durable.readMessage(dispatch, key),
      recordMessage: (dispatch, key, turn) =>
        durable.recordMessage(dispatch, key, turn),
    };
    const failing = new PersistentCodexHandoff(
      authority,
      host,
      failingJournal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await failing.continue(continuation)).toEqual({
      status: "outcome_unknown",
      dispatchId: continuation.key,
    });
    const sends = host.calls.filter((method) => method === "turn/start").length;
    expect(await service().continue(continuation)).toEqual({
      status: "outcome_unknown",
      dispatchId: continuation.key,
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      sends,
    );
  });

  it("fails closed at each message preflight boundary without sending a steer", async () => {
    const { service, host, authority, journalRoot, setWorkspace } =
      await fixture();
    expect((await service().create(request)).status).toBe("dispatched");
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    const makeService = (
      digester: HandoffRequestDigester = new Sha256HandoffRequestDigester(),
      expiresAt = Date.now() + 60_000,
    ) =>
      new PersistentCodexHandoff(
        authority,
        host,
        journal,
        digester,
        expiresAt,
        mutationGate,
      );

    expect(
      await makeService(undefined, Date.now() - 1).message(message),
    ).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    const validDigester = new Sha256HandoffRequestDigester();
    expect(
      await makeService({
        digest: (value) => validDigester.digest(value),
        digestMessage: () => "invalid",
      }).message(message),
    ).toEqual({ status: "refused", code: "HANDOFF_DIGEST_INVALID" });
    expect(
      await service().message({ ...message, dispatchId: randomUUID() }),
    ).toEqual({ status: "refused", code: "HANDOFF_DISPATCH_UNKNOWN" });

    host.projects = [];
    expect(await service().message(message)).toEqual({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    host.projects = [
      { id: request.projectId, roots: [{ path: workspace.project.root }] },
    ];
    host.readResponse = {
      thread: {
        id: "issued-thread",
        projectId: request.projectId,
        cwd: workspace.root,
        model: "another-model",
      },
    };
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    host.readResponse = undefined;
    host.failStatus = true;
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    host.failStatus = false;
    host.turnsResponse = { data: [], nextCursor: null };
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    host.turnsResponse = undefined;
    host.onProjectList = () => setWorkspace({ ...workspace, inode: "changed" });
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    host.onProjectList = undefined;
    setWorkspace(workspace);
    let authorityReads = 0;
    const lateRevocation = new PersistentCodexHandoff(
      {
        resolve: async () =>
          ++authorityReads < 3 ? workspace : { ...workspace, inode: "changed" },
      },
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await lateRevocation.message(message)).toEqual({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
    expect(host.calls).not.toContain("turn/steer");
  });

  it("steers the exact active turn once and reads back its durable receipt after restart", async () => {
    const { service, host, journalRoot } = await fixture();
    expect((await service().create(request)).status).toBe("dispatched");
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await service().message(message)).toEqual({
      status: "steered",
      dispatchId: request.key,
      turnId: "issued-turn",
    });
    expect(await service().message(message)).toMatchObject({
      status: "steered",
    });
    const intent = await fs.readFile(
      path.join(journalRoot, request.key, "message-intent.json"),
      "utf8",
    );
    expect(intent).not.toContain(message.message);
    expect(intent).not.toContain(request.message);
    expect(host.calls.filter((method) => method === "turn/steer")).toHaveLength(
      1,
    );
    expect(
      await service().message({ ...message, key: randomUUID() }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
    expect(
      await service().message({ ...message, message: "changed" }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
    expect(
      await service().message({ ...message, projectId: "different" }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
  });

  it("keeps a lost steer acknowledgement unknown and never sends another key", async () => {
    const host = new FixtureHost();
    const { service } = await fixture(host);
    await service().create(request);
    host.failSteer = true;
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    host.failSteer = false;
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(
      await service().message({ ...message, key: randomUUID() }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
    expect(host.calls.filter((method) => method === "turn/steer")).toHaveLength(
      1,
    );
  });

  it("refuses invalid, stale, terminal, and changed-workspace steer before host mutation", async () => {
    const { service, host, setWorkspace } = await fixture();
    await service().create(request);
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    for (const text of ["", "bad\0input", "я".repeat(4_097)])
      expect(
        await service().message({ ...message, message: text }),
      ).toMatchObject({ status: "refused", code: "HANDOFF_INPUT_INVALID" });
    expect(
      await service().message({ ...message, projectId: "other" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_DISPATCH_BINDING_CHANGED",
    });
    host.turnStatus = "completed";
    expect(await service().message(message)).toMatchObject({
      status: "refused",
      code: "HANDOFF_TURN_NOT_ACTIVE",
    });
    host.turnStatus = "inProgress";
    setWorkspace({ ...workspace, inode: "different" });
    expect(await service().message(message)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
    expect(host.calls).not.toContain("turn/steer");
  });

  it("burns intent without host mutation when authority changes after the durable claim", async () => {
    const { service, host, authority, journalRoot, setWorkspace } =
      await fixture();
    await service().create(request);
    const base = new PrivateCodexHandoffJournal(journalRoot);
    const journal: HandoffJournal = {
      read: (key) => base.read(key),
      reserve: (key, value) => base.reserve(key, value),
      claimThread: (key) => base.claimThread(key),
      recordThread: (key, threadId) => base.recordThread(key, threadId),
      claimTurn: (key) => base.claimTurn(key),
      recordTurn: (key, turnId) => base.recordTurn(key, turnId),
      readMessage: (dispatchId, key) => base.readMessage(dispatchId, key),
      async claimMessage(dispatchId, key, digest) {
        const claim = await base.claimMessage(dispatchId, key, digest);
        setWorkspace(null);
        return claim;
      },
      recordMessage: (dispatchId, key, turnId) =>
        base.recordMessage(dispatchId, key, turnId),
    };
    const route = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    setWorkspace(workspace);
    expect(await service().message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("turn/steer");
  });

  it("does not steer when admission expires at the gated effect boundary", async () => {
    const { service, host, journalRoot } = await fixture();
    await service().create(request);
    let now = 0;
    let inPreflight = false;
    const authority: HandoffAuthority = {
      async resolve() {
        if (inPreflight) now = 100;
        return workspace;
      },
    };
    const gate: HandoffMutationGate = {
      async run(preflight, effect) {
        inPreflight = true;
        await preflight();
        return effect();
      },
    };
    const route = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      100,
      gate,
      () => now,
    );
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("turn/steer");
    now = 0;
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("turn/steer");
  });

  it("retains the real fence lock when a submitted steer returns a foreign turn", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    await service().create(request);
    host.steerResponse = { turnId: "foreign-turn" };
    const gateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-message-gate-")),
    );
    roots.push(gateRoot);
    const route = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      new PrivateExecutionFence({ root: gateRoot }),
    );
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(
      (
        await fs.stat(path.join(gateRoot, "execution-fence-mutation.lock"))
      ).isDirectory(),
    ).toBe(true);
    expect(host.calls.filter((method) => method === "turn/steer")).toHaveLength(
      1,
    );
  });

  it("releases the real fence lock only for a certified pre-send proxy failure", async () => {
    const host = new FixtureHost();
    const { service, authority, journalRoot } = await fixture(host);
    await service().create(request);
    host.steerError = new HandoffNotSubmittedError("HOST_FAILED_BEFORE_SEND");
    const gateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-message-gate-")),
    );
    roots.push(gateRoot);
    const route = new PersistentCodexHandoff(
      authority,
      host,
      new PrivateCodexHandoffJournal(journalRoot),
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      new PrivateExecutionFence({ root: gateRoot }),
    );
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    };
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    await expect(
      fs.access(path.join(gateRoot, "execution-fence-mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(host.calls.filter((method) => method === "turn/steer")).toHaveLength(
      1,
    );
    host.steerError = undefined;
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls.filter((method) => method === "turn/steer")).toHaveLength(
      1,
    );
  });
  it("refuses invalid UTF-8 byte budgets before authority, journal or host access", async () => {
    for (const message of [
      "",
      "with\0nul",
      "a".repeat(8_193),
      "я".repeat(4_097),
      "😀".repeat(2_049),
    ]) {
      const fixture = byteBudgetFixture();
      expect(await fixture.service.create({ ...request, message })).toEqual({
        status: "refused",
        code: "HANDOFF_INPUT_INVALID",
      });
      expect(fixture.counts()).toEqual({
        authorityCalls: 0,
        journalCalls: 0,
        hostCalls: [],
      });
      expect(fixture.forwarded()).toBeNull();
    }
  });

  it("refuses a forged model binding before consulting workspace or host", async () => {
    const fixture = byteBudgetFixture();
    expect(
      await fixture.service.create({
        ...request,
        modelBinding: {
          selection: {
            harness: "codex",
            modelAlias: "luna",
            model: "different-model",
            effort: request.reasoningEffort,
          },
          configSha256: "0".repeat(64),
        },
      }),
    ).toEqual({ status: "refused", code: "HANDOFF_INPUT_INVALID" });
    expect(fixture.counts()).toEqual({
      authorityCalls: 0,
      journalCalls: 0,
      hostCalls: [],
    });
  });

  it("forwards exact at-budget ASCII, Cyrillic, emoji and formatted messages", async () => {
    for (const message of [
      "a".repeat(8_192),
      "я".repeat(4_096),
      "😀".repeat(2_048),
      "  line one\r\nline two  ",
    ]) {
      const fixture = byteBudgetFixture();
      expect(
        await fixture.service.create({ ...request, message }),
      ).toMatchObject({
        status: "dispatched",
        dispatchId: request.key,
      });
      expect(fixture.counts().hostCalls).toEqual([
        "project/list",
        "thread/start",
        "turn/start",
      ]);
      expect(fixture.forwarded()).toBe(message);
    }
  });
  it("reads only the issued turn's exact terminal answer without starting work", async () => {
    const { host, service } = await fixture();
    await service().create(request);
    host.turnStatus = "completed";
    host.pagedItems = true;
    const before = host.calls.length;
    expect(await service().result(key)).toEqual({
      status: "completed",
      dispatchId: key,
      threadId: "issued-thread",
      turnId: "issued-turn",
      finalItemId: "answer",
      text: "Exact result",
    });
    expect(host.calls.slice(before)).toEqual([
      "thread/read",
      "thread/turns/list",
      "thread/items/list",
      "thread/items/list",
    ]);
  });

  it("keeps incomplete, foreign and ambiguous result reads unknown", async () => {
    const { host, service } = await fixture();
    expect(await service().result(key)).toEqual({ status: "unknown" });
    await service().create(request);
    expect(await service().result(key)).toMatchObject({ status: "running" });
    expect(host.calls).not.toContain("thread/items/list");
    host.turnStatus = "completed";
    host.itemsResponse = {
      data: [
        {
          turnId: "other-turn",
          item: {
            id: "foreign",
            type: "agentMessage",
            phase: "final_answer",
            text: "wrong",
          },
        },
      ],
      nextCursor: null,
    };
    expect(await service().result(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.itemsResponse = {
      data: [
        {
          turnId: "issued-turn",
          item: {
            id: "one",
            type: "agentMessage",
            phase: "final_answer",
            text: "one",
          },
        },
        {
          turnId: "issued-turn",
          item: {
            id: "two",
            type: "agentMessage",
            phase: "final_answer",
            text: "two",
          },
        },
      ],
      nextCursor: null,
    };
    expect(await service().result(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.itemsResponse = { data: [], nextCursor: "repeat" };
    expect(await service().result(key)).toMatchObject({
      status: "outcome_unknown",
    });
  });

  it("reports terminal failure without fetching content or starting a new turn", async () => {
    const { host, service } = await fixture();
    await service().create(request);
    for (const terminal of ["failed", "interrupted"] as const) {
      host.turnStatus = terminal;
      expect(await service().result(key)).toEqual({
        status: terminal,
        dispatchId: key,
        threadId: "issued-thread",
        turnId: "issued-turn",
      });
    }
    expect(host.calls).not.toContain("thread/items/list");
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("keeps missing final text and provider read failure explicitly unknown", async () => {
    const { host, service } = await fixture();
    await service().create(request);
    host.turnStatus = "completed";
    host.itemsResponse = { data: [], nextCursor: null };
    expect(await service().result(key)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    host.failItems = true;
    expect(await service().result(key)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    host.failStatus = true;
    expect(await service().result(key)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("refuses an unsupported turn state and an oversized item page", async () => {
    const { host, service } = await fixture();
    await service().create(request);
    host.turnStatus = "queued-new-state";
    expect(await service().result(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.turnStatus = "completed";
    host.itemsResponse = {
      data: Array.from({ length: 101 }, () => ({})),
      nextCursor: null,
    };
    expect(await service().result(key)).toMatchObject({
      status: "outcome_unknown",
    });
  });
  it("starts one project-bound persistent thread and one turn, then reads exact metadata after restart", async () => {
    const { host, service } = await fixture();
    expect(await service().create(request)).toEqual({
      status: "dispatched",
      dispatchId: key,
      threadId: "issued-thread",
      turnId: "issued-turn",
    });
    host.turnStatus = "completed";
    expect(await service().status(key)).toEqual({
      status: "known",
      dispatchId: key,
      threadId: "issued-thread",
      turnId: "issued-turn",
      turnStatus: "completed",
    });
    expect(await service().create(request)).toMatchObject({
      status: "dispatched",
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(
      await service().status("00000000-0000-4000-8000-000000000000"),
    ).toEqual({ status: "unknown" });
  });

  it("refuses missing, ambiguous and stale project roots before a side effect", async () => {
    const { host, service, setWorkspace } = await fixture();
    host.projects = [
      { id: "saved-project", roots: [{ path: workspace.root }] },
    ];
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    host.projects = [];
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    host.projects = [
      { id: "saved-project", roots: [{ path: workspace.project.root }] },
      { id: "other-project", roots: [{ path: workspace.project.root }] },
    ];
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    setWorkspace(null);
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("refuses a writer from another repository before starting a thread", async () => {
    const { host, service, setWorkspace } = await fixture();
    setWorkspace({ ...workspace, gitCommonDirectory: "/other/.git" });
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
    expect(host.calls).toEqual([]);
  });

  it("refuses an incomplete authority response without throwing or starting a thread", async () => {
    const { host, service, setWorkspace } = await fixture();
    setWorkspace({ root: workspace.root } as HandoffWorkspace);
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_UNVERIFIED",
    });
    expect(host.calls).toEqual([]);
  });

  it("fails closed on malformed or unavailable saved-project inventory", async () => {
    const host = new FixtureHost();
    const { service } = await fixture(host);
    host.projects = [{ id: "saved-project", roots: "bad" }];
    expect(await service().create(request)).toMatchObject({
      status: "refused",
    });
    host.failProject = true;
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_UNAVAILABLE",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("uses complete paginated project and issued-turn metadata, without loading history", async () => {
    const host = new FixtureHost();
    host.pagedProjects = true;
    host.pagedTurns = true;
    const { service } = await fixture(host);
    expect(await service().create(request)).toMatchObject({
      status: "dispatched",
    });
    expect(await service().status(key)).toMatchObject({
      status: "known",
      turnStatus: "inProgress",
    });
    expect(
      host.calls.filter((method) => method === "project/list"),
    ).toHaveLength(2);
    expect(
      host.calls.filter((method) => method === "thread/turns/list"),
    ).toHaveLength(2);
  });

  it("refuses malformed project pagination and invalid request digests", async () => {
    const host = new FixtureHost();
    host.badProjectCursor = true;
    const { service } = await fixture(host);
    expect(await service().create(request)).toMatchObject({
      status: "refused",
    });
    const invalid = new PersistentCodexHandoff(
      { resolve: async () => workspace },
      host,
      new PrivateCodexHandoffJournal(path.join(os.tmpdir(), "unused-journal")),
      { digest: () => "bad", digestMessage: () => "bad" },
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await invalid.create(request)).toEqual({
      status: "refused",
      code: "HANDOFF_DIGEST_INVALID",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("refuses a reused key with another payload or changed physical workspace", async () => {
    const { service, setWorkspace, host } = await fixture();
    await service().create(request);
    expect(
      await service().create({ ...request, message: "Different" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_KEY_CONFLICT",
    });
    setWorkspace({ ...workspace, inode: "58" });
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("rechecks physical workspace identity after project/list before dispatch", async () => {
    const host = new FixtureHost();
    const { service, setWorkspace } = await fixture(host);
    host.onProjectList = () => setWorkspace({ ...workspace, inode: "other" });
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_WORKSPACE_CHANGED",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("admits only one concurrent create for the same key", async () => {
    const { host, service } = await fixture();
    const results = await Promise.all([
      service().create(request),
      service().create(request),
    ]);
    expect(results.some((result) => result.status === "dispatched")).toBe(true);
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("refuses a concurrent reservation from a different physical workspace before any host side effect", async () => {
    const host = new FixtureHost();
    const authority: HandoffAuthority = { resolve: async () => workspace };
    const journal: HandoffJournal = {
      claimMessage: async () => {
        throw new Error("MUST_NOT_CLAIM");
      },
      readMessage: async () => {
        throw new Error("MUST_NOT_READ");
      },
      recordMessage: async () => {
        throw new Error("MUST_NOT_RECORD");
      },
      read: async () => null,
      reserve: async (_key, record) => ({
        ...record,
        workspace: { ...record.workspace, inode: "foreign" },
      }),
      claimThread: async () => {
        throw new Error("MUST_NOT_CLAIM");
      },
      recordThread: async () => {
        throw new Error("MUST_NOT_RECORD");
      },
      claimTurn: async () => {
        throw new Error("MUST_NOT_CLAIM");
      },
      recordTurn: async () => {
        throw new Error("MUST_NOT_RECORD");
      },
    };
    const service = new PersistentCodexHandoff(
      authority,
      host,
      journal,
      new Sha256HandoffRequestDigester(),
      Date.now() + 60_000,
      mutationGate,
    );
    expect(await service.create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_RESERVATION_CONFLICT",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("resumes the one confirmed thread after restart before any turn intent", async () => {
    const { host, service, journalRoot } = await fixture();
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    const requestDigest = new Sha256HandoffRequestDigester().digest(request);
    await journal.reserve(key, {
      requestDigest,
      workspaceId: request.workspaceId,
      workspace,
      projectId: request.projectId,
      threadIntent: false,
      turnIntent: false,
    });
    await journal.claimThread(key);
    await journal.recordThread(key, "issued-thread");
    expect(await service().create(request)).toMatchObject({
      status: "dispatched",
      threadId: "issued-thread",
      turnId: "issued-turn",
    });
    expect(host.calls).not.toContain("thread/start");
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("refuses to resume a confirmed thread whose model has changed", async () => {
    const host = new FixtureHost();
    const { service, journalRoot } = await fixture(host);
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    await journal.reserve(key, {
      requestDigest: new Sha256HandoffRequestDigester().digest(request),
      workspaceId: request.workspaceId,
      workspace,
      projectId: request.projectId,
      threadIntent: false,
      turnIntent: false,
    });
    await journal.claimThread(key);
    await journal.recordThread(key, "issued-thread");
    host.readResponse = {
      thread: {
        id: "issued-thread",
        projectId: request.projectId,
        cwd: workspace.root,
        model: "different-model",
      },
    };
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("turn/start");
  });

  it("treats an interrupted reservation publication as unknown and never dispatches", async () => {
    const { service, host, journalRoot } = await fixture();
    await fs.mkdir(path.join(journalRoot, key), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(journalRoot, key, "reservation.json.interrupted.tmp"),
      "",
      { mode: 0o600 },
    );
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("thread/start");
  });

  it("recovers a fully published reservation left with its private temp hardlink", async () => {
    const { service, host, journalRoot } = await fixture();
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    await journal.reserve(key, {
      requestDigest: new Sha256HandoffRequestDigester().digest(request),
      workspaceId: request.workspaceId,
      workspace,
      projectId: request.projectId,
      threadIntent: false,
      turnIntent: false,
    });
    const published = path.join(journalRoot, key, "reservation.json");
    const orphan = `${published}.00000000-0000-4000-8000-000000000001.tmp`;
    await fs.link(published, orphan);
    expect((await fs.stat(published)).nlink).toBe(2);
    expect(await service().create(request)).toMatchObject({
      status: "dispatched",
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("fails closed on a corrupt published journal record without host side effects", async () => {
    const { service, host, journalRoot } = await fixture();
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    await journal.reserve(key, {
      requestDigest: new Sha256HandoffRequestDigester().digest(request),
      workspaceId: request.workspaceId,
      workspace,
      projectId: request.projectId,
      threadIntent: false,
      turnIntent: false,
    });
    await fs.writeFile(path.join(journalRoot, key, "reservation.json"), "{", {
      mode: 0o600,
    });
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).toEqual([]);
  });

  it("never replays a pre-project-identity journal reservation", async () => {
    const { service, host, journalRoot } = await fixture();
    const journal = new PrivateCodexHandoffJournal(journalRoot);
    await journal.reserve(key, {
      requestDigest: new Sha256HandoffRequestDigester().digest(request),
      workspaceId: request.workspaceId,
      workspace,
      projectId: request.projectId,
      threadIntent: false,
      turnIntent: false,
    });
    const {
      gitCommonDirectory: _common,
      project: _project,
      ...legacy
    } = workspace;
    await fs.writeFile(
      path.join(journalRoot, key, "reservation.json"),
      JSON.stringify({
        requestDigest: new Sha256HandoffRequestDigester().digest(request),
        workspaceId: request.workspaceId,
        workspace: legacy,
        projectId: request.projectId,
      }),
      { mode: 0o600 },
    );
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).toEqual([]);
  });

  it("never retries a lost thread/start acknowledgement after service restart", async () => {
    const host = new FixtureHost();
    host.failThread = true;
    const { service } = await fixture(host);
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    host.failThread = false;
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("does not accept a host thread without exact saved-project and cwd readback", async () => {
    const host = new FixtureHost();
    host.threadResponse = {
      cwd: "/other/root",
      thread: { id: "issued-thread", projectId: "saved-project" },
    };
    const { service } = await fixture(host);
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    expect(host.calls).not.toContain("turn/start");
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("does not start a turn when host effective execution policy differs", async () => {
    const host = new FixtureHost();
    host.threadResponse = {
      cwd: workspace.root,
      model: request.model,
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      thread: { id: "issued-thread", projectId: request.projectId },
    };
    const { service } = await fixture(host);
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).not.toContain("turn/start");
  });

  it("never starts a second turn after lost turn/start acknowledgement", async () => {
    const host = new FixtureHost();
    host.failTurn = true;
    const { service } = await fixture(host);
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    host.failTurn = false;
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: key,
    });
    expect(
      host.calls.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("does not accept a malformed turn acknowledgement", async () => {
    const host = new FixtureHost();
    host.turnResponse = { turn: { status: "inProgress" } };
    const { service } = await fixture(host);
    expect(await service().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
  });

  it("returns only exact issued status and refuses drift or unavailable metadata", async () => {
    const host = new FixtureHost();
    const { service, setWorkspace } = await fixture(host);
    await service().create(request);
    host.readResponse = {
      thread: {
        id: "other-thread",
        projectId: request.projectId,
        cwd: workspace.root,
      },
    };
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.readResponse = undefined;
    host.turnsResponse = {
      data: [{ id: "other-turn", status: "completed" }],
      nextCursor: null,
    };
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.turnsResponse = undefined;
    host.failStatus = true;
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    host.failStatus = false;
    setWorkspace({ ...workspace, inode: "replaced" });
    const calls = host.calls.length;
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).toHaveLength(calls);
    setWorkspace(workspace);
    setWorkspace({
      ...workspace,
      project: { ...workspace.project, inode: "replaced-project" },
    });
    expect(await service().status(key)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(host.calls).toHaveLength(calls);
  });

  it("keeps exact read-only status available after execution policy changes", async () => {
    const { host, service, setWorkspace } = await fixture();
    expect(await service().create(request)).toMatchObject({
      status: "dispatched",
    });
    setWorkspace({
      ...workspace,
      execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
    });
    host.turnStatus = "completed";
    expect(await service().status(key)).toMatchObject({
      status: "known",
      threadId: "issued-thread",
      turnId: "issued-turn",
      turnStatus: "completed",
    });
    expect(host.calls.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("refuses malformed input before host calls", async () => {
    const { service, host } = await fixture();
    expect(
      await service().create({ ...request, key: "../other" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_INPUT_INVALID",
    });
    expect(host.calls).toEqual([]);
    expect(await service().status("../not-a-dispatch")).toEqual({
      status: "unknown",
    });
  });
});
