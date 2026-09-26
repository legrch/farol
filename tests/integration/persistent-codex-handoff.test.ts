import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  PersistentCodexHandoff,
  type HandoffAuthority,
  type HandoffHost,
  type HandoffJournal,
  type HandoffRequest,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";

const key = randomUUID();
const workspace: HandoffWorkspace = {
  root: "/approved/project",
  device: "4",
  inode: "57",
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

class FixtureHost implements HandoffHost {
  readonly calls: string[] = [];
  projects: unknown[] = [
    { id: "saved-project", roots: [{ path: workspace.root }] },
  ];
  failThread = false;
  failTurn = false;
  failProject = false;
  failStatus = false;
  turnStatus = "inProgress";
  onProjectList?: (() => void) | undefined;
  threadResponse?: unknown;
  turnResponse?: unknown;
  readResponse?: unknown;
  turnsResponse?: unknown;
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
    );
  return {
    host,
    service,
    journalRoot,
    setWorkspace(value: HandoffWorkspace | null) {
      current = value;
    },
  };
}

describe("persistent Codex handoff core", () => {
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
    host.projects = [];
    expect(await service().create(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
    });
    host.projects = [
      { id: "saved-project", roots: [{ path: workspace.root }] },
      { id: "other-project", roots: [{ path: workspace.root }] },
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
      { digest: () => "bad" },
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
