import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffWorkspace,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const workspace: HandoffWorkspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
};
const dispatchId = "019b0000-0000-4000-8000-000000000001";
const threadId = "019b0000-0000-4000-8000-000000000002";
const turnId = "019b0000-0000-4000-8000-000000000003";
const input = {
  key: "019b0000-0000-4000-8000-000000000004",
  dispatchId,
  workspaceId: "writer",
  projectId: "project",
  expectedTitle: "Original",
  title: "Farol · Canary",
};
async function fixture(
  options: {
    adopted?: boolean;
    lostReply?: boolean;
    lateRename?: boolean;
    publicationFault?: boolean;
    drift?: boolean;
    expireAfterMutation?: boolean;
    pendingAtFence?: "title" | "message";
    turnStatus?: "completed" | "inProgress";
    threadChange?: Record<string, unknown>;
    catalogue?: "missing" | "unavailable" | "ambiguous";
    revokeAt?: number;
    abortAfterMutation?: boolean;
    revokeDuringPreflightRead?: boolean;
    expireAtPublication?: boolean;
    revokeDuringLedgerProbe?: "title" | "message";
    claimFault?: boolean;
    missingMethods?: boolean;
    unknownDispatch?: boolean;
    unverifiedContinuation?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-title-fixture-"));
  roots.push(root);
  const journalRoot = path.join(root, "journal");
  const journal = new PrivateCodexHandoffJournal(journalRoot);
  await journal.reserve(dispatchId, {
    requestDigest: "a".repeat(64),
    workspaceId: "writer",
    workspace,
    projectId: "project",
    model: "fixture-model",
    reasoningEffort: "medium",
    threadIntent: false,
    turnIntent: false,
    ...(options.adopted ? { adopted: true as const } : {}),
  });
  await journal.claimThread(dispatchId);
  await journal.recordThread(dispatchId, threadId);
  await journal.claimTurn(dispatchId);
  await journal.recordTurn(dispatchId, turnId);
  if (options.unknownDispatch)
    await fs.rm(path.join(journalRoot, dispatchId), { recursive: true });
  if (options.unverifiedContinuation) {
    // Use an explicit unconfirmed continuation record, not a forged provider result.
    const reservation = path.join(journalRoot, dispatchId, "reservation.json");
    const prior = JSON.parse(await fs.readFile(reservation, "utf8"));
    await fs.writeFile(
      reservation,
      JSON.stringify({ ...prior, continuedFrom: randomUUID() }),
    );
  }
  const controller = new AbortController();
  let resolutions = 0;
  let reads = 0;
  let revoked = false;
  const calls: string[] = [];
  let name: string | null = "Original";
  let effects = 0;
  let now = Date.now();
  const safeReleases: boolean[] = [];
  const host = {
    async request(method: string, params: unknown) {
      calls.push(method);
      if (method === "project/list") {
        if (options.catalogue === "unavailable")
          throw new Error("Catalogue unavailable");
        return {
          data:
            options.catalogue === "missing"
              ? []
              : options.catalogue === "ambiguous"
                ? [{ id: "foreign", roots: [{ path: workspace.project.root }] }]
                : [
                    {
                      id: "project",
                      roots: [{ path: workspace.project.root }],
                    },
                  ],
          nextCursor: null,
        };
      }
      if (method === "thread/read") {
        reads++;
        if (options.revokeDuringPreflightRead && reads === 2) revoked = true;
        return {
          thread: {
            id: threadId,
            projectId: "project",
            cwd: workspace.root,
            model: "fixture-model",
            name,
            ...options.threadChange,
          },
        };
      }
      if (method === "thread/turns/list")
        return {
          data: [{ id: turnId, status: options.turnStatus ?? "completed" }],
          nextCursor: null,
        };
      if (method === "turn/steer" || method === "turn/start") {
        effects++;
        if (method === "turn/steer") return { turnId };
        throw new Error("Simulated turn acknowledgement lost");
      }
      if (method === "thread/name/set") {
        effects++;
        if (options.abortAfterMutation) controller.abort();
        if (options.expireAfterMutation) now = Infinity;
        const value = params as { threadId: string; name: string };
        expect(value.threadId).toBe(threadId);
        name = value.name;
        if (options.lateRename) name = "Native concurrent edit";
        if (options.lostReply) throw new Error("Acknowledgement lost");
        return {};
      }
      throw new Error("Forbidden task effect: " + method);
    },
  };
  const create = () => {
    const instance = new PrivateCodexHandoffJournal(journalRoot);
    if (options.revokeDuringLedgerProbe) {
      const probe =
        options.revokeDuringLedgerProbe === "message"
          ? "hasUnconfirmedTitle"
          : "hasUnconfirmedMessage";
      const original = instance[probe].bind(instance);
      let probes = 0;
      Object.defineProperty(instance, probe, {
        value: async (dispatch: string) => {
          const result = await original(dispatch);
          if (++probes === 2) revoked = true;
          return result;
        },
      });
    }
    if (options.claimFault)
      Object.defineProperty(instance, "claimTitle", {
        value: async () => {
          throw new Error("Intent publication failed");
        },
      });
    if (options.missingMethods)
      Object.defineProperty(instance, "recordTitle", { value: undefined });
    if (options.expireAtPublication) {
      const recordTitle = instance.recordTitle.bind(instance);
      Object.defineProperty(instance, "recordTitle", {
        value: async (...args: Parameters<typeof recordTitle>) => {
          await recordTitle(...args);
          now = Infinity;
        },
      });
    }
    if (options.publicationFault) {
      Object.defineProperty(instance, "recordTitle", {
        value: async () => {
          throw new Error("Publication failed");
        },
      });
    }
    return new PersistentCodexHandoff(
      {
        async resolve() {
          resolutions++;
          return options.drift || revoked || options.revokeAt === resolutions
            ? { ...workspace, inode: "changed" }
            : workspace;
        },
      },
      host,
      instance,
      new Sha256HandoffRequestDigester(),
      now + 60000,
      {
        async run(preflight, effect, safeToRelease) {
          if (options.pendingAtFence === "title")
            await journal.claimTitle(dispatchId, randomUUID(), "b".repeat(64));
          if (options.pendingAtFence === "message")
            await journal.claimMessage(
              dispatchId,
              randomUUID(),
              "b".repeat(64),
            );
          await preflight();
          try {
            return await effect();
          } catch (error) {
            safeReleases.push(safeToRelease(error));
            throw error;
          }
        },
      },
      () => now,
    );
  };
  const title = (
    service: PersistentCodexHandoff = create(),
    request: object = input,
  ) =>
    (
      service as unknown as {
        title(
          request: object,
          context: { signal: AbortSignal },
        ): Promise<unknown>;
      }
    ).title(request, { signal: controller.signal });
  return {
    title,
    create,
    calls,
    setName(value: string | null) {
      name = value;
    },
    effects: () => effects,
    safeReleases,
    journal,
    journalRoot,
    loseReply() {
      options.lostReply = true;
    },
    expire() {
      now = Infinity;
    },
    abort() {
      controller.abort();
    },
  };
}
describe("exact dispatch title mutation", () => {
  it("does not treat an orphan JSON null receipt as an absent operation", async () => {
    const f = await fixture();
    expect(await f.title()).toMatchObject({ status: "renamed" });
    await fs.unlink(path.join(f.journalRoot, dispatchId, "title-intent.json"));
    await fs.writeFile(
      path.join(f.journalRoot, dispatchId, "title.json"),
      "null",
    );
    f.setName("Original");
    expect(
      await f.title(f.create(), { ...input, key: randomUUID() }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(1);
  });
  it("does not treat a JSON null pending intent as permission for control", async () => {
    const f = await fixture({ lostReply: true });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    await fs.writeFile(
      path.join(f.journalRoot, dispatchId, "title-intent.json"),
      "null",
    );
    const before = f.calls.length;
    expect(
      await f
        .create()
        .message({
          key: randomUUID(),
          dispatchId,
          workspaceId: "writer",
          projectId: "project",
          message: "One steer",
          model: "fixture-model",
          reasoningEffort: "medium",
        }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.calls.length).toBe(before);
    expect(f.effects()).toBe(1);
  });
  it("does not report current success after physical revocation during publication", async () => {
    const f = await fixture({ revokeAt: 5 });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(1);
    expect(f.safeReleases).toEqual([false]);
  });
  it.each(["key", "digest", "threadId", "legacy-string"])(
    "does not use a corrupt %s title confirmation or send further control",
    async (field) => {
      const f = await fixture();
      expect(await f.title()).toMatchObject({ status: "renamed" });
      const target = path.join(f.journalRoot, dispatchId, "title.json");
      const value = JSON.parse(await fs.readFile(target, "utf8"));
      const changed =
        field === "legacy-string"
          ? threadId
          : {
              ...value,
              [field]: field === "digest" ? "f".repeat(64) : randomUUID(),
            };
      await fs.writeFile(target, JSON.stringify(changed));
      expect(await f.title(f.create())).toMatchObject({
        status: "outcome_unknown",
      });
      const before = f.calls.length;
      expect(
        await f.create().continue({
          key: randomUUID(),
          dispatchId,
          message: "One follow-up",
        }),
      ).toMatchObject({ status: "outcome_unknown" });
      expect(f.calls.length).toBe(before);
      expect(f.effects()).toBe(1);
    },
  );
  it.each(["title", "message"] as const)(
    "does not send %s after physical authority changes during ledger preflight",
    async (operation) => {
      const f = await fixture({
        revokeDuringLedgerProbe: operation,
        turnStatus: "inProgress",
      });
      const result =
        operation === "title"
          ? await f.title()
          : await f.create().message({
              key: randomUUID(),
              dispatchId,
              workspaceId: "writer",
              projectId: "project",
              message: "One steer",
              model: "fixture-model",
              reasoningEffort: "medium",
            });
      expect(result).toMatchObject({ status: "outcome_unknown" });
      expect(f.effects()).toBe(0);
    },
  );
  it("refuses orphan confirmation and cannot use it as proof of a different operation", async () => {
    const f = await fixture();
    expect(await f.title()).toMatchObject({ status: "renamed" });
    await fs.unlink(path.join(f.journalRoot, dispatchId, "title-intent.json"));
    f.setName("Original");
    f.loseReply();
    const another = { ...input, key: randomUUID(), title: "Different" };
    expect(await f.title(f.create(), another)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(await f.title(f.create(), another)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.effects()).toBe(1);
  });
  it("does not mutate after physical authority changes during the final name read", async () => {
    const f = await fixture({ revokeDuringPreflightRead: true });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(0);
  });
  it("does not disclose current success after admission expires during receipt publication", async () => {
    const f = await fixture({ expireAtPublication: true });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(1);
    expect(f.safeReleases).toEqual([false]);
  });
  it.each([
    { catalogue: "missing" },
    { catalogue: "ambiguous" },
    { catalogue: "unavailable" },
    { revokeAt: 2 },
    { revokeAt: 3 },
    { claimFault: true },
    { missingMethods: true },
    { unknownDispatch: true },
    { unverifiedContinuation: true },
  ] as const)(
    "fails closed before mutation when authority or durable intent cannot be verified: %j",
    async (options) => {
      const f = await fixture(options);
      expect(await f.title()).not.toMatchObject({ status: "renamed" });
      expect(f.effects()).toBe(0);
    },
  );
  it.each([
    { threadChange: { id: "foreign" } },
    { threadChange: { projectId: "foreign" } },
    { threadChange: { cwd: "/other/writer" } },
    { threadChange: { model: "other-model" } },
    { threadChange: { name: 7 } },
  ] as const)(
    "does not mutate foreign or malformed provider identity: %j",
    async (options) => {
      const f = await fixture(options);
      expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
      expect(f.effects()).toBe(0);
    },
  );
  it.each([{ revokeAt: 4 }, { abortAfterMutation: true }] as const)(
    "does not publish success after post-mutation authority loss: %j",
    async (options) => {
      const f = await fixture(options);
      expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
      expect(f.effects()).toBe(1);
      expect(f.safeReleases).toEqual([false]);
    },
  );
  it("denies cancelled/expired admission before provider reads", async () => {
    const f = await fixture();
    const service = f.create();
    f.abort();
    expect(await f.title(service)).toMatchObject({ status: "refused" });
    expect(f.calls).toEqual([]);
    const expired = await fixture();
    const issued = expired.create();
    expired.expire();
    expect(await expired.title(issued)).toMatchObject({ status: "refused" });
    expect(expired.calls).toEqual([]);
  });
  it("accepts an initially unnamed thread and binds the replay digest", async () => {
    const f = await fixture();
    f.setName(null);
    expect(
      await f.title(f.create(), { ...input, expectedTitle: null }),
    ).toMatchObject({ status: "renamed" });
    expect(
      await f.title(f.create(), {
        ...input,
        expectedTitle: null,
        title: "Different",
      }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
    expect(f.effects()).toBe(1);
  });
  it("rechecks unresolved message intent inside the title mutation fence", async () => {
    const f = await fixture({ pendingAtFence: "message" });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(0);
  });
  it.each(["message", "continue"] as const)(
    "rechecks unresolved title intent inside the %s mutation fence",
    async (operation) => {
      const f = await fixture({
        pendingAtFence: "title",
        turnStatus: operation === "message" ? "inProgress" : "completed",
      });
      const service = f.create();
      const result =
        operation === "message"
          ? await service.message({
              key: randomUUID(),
              dispatchId,
              workspaceId: "writer",
              projectId: "project",
              message: "One steer",
              model: "fixture-model",
              reasoningEffort: "medium",
            })
          : await service.continue({
              key: randomUUID(),
              dispatchId,
              message: "One continue",
            });
      expect(result).toMatchObject({ status: "outcome_unknown" });
      expect(f.effects()).toBe(0);
    },
  );
  it("does not classify a post-mutation expired readback as safe-to-release", async () => {
    const f = await fixture({ expireAfterMutation: true });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    expect(f.effects()).toBe(1);
    expect(f.safeReleases).toEqual([false]);
  });
  it("blocks further control from an unconfirmed title receipt without provider reads", async () => {
    const f = await fixture({ lostReply: true });
    expect(await f.title()).toMatchObject({ status: "outcome_unknown" });
    const before = f.calls.length;
    expect(
      await f
        .create()
        .continue({ key: randomUUID(), dispatchId, message: "One follow-up" }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(
      await f.create().message({
        key: randomUUID(),
        dispatchId,
        workspaceId: "writer",
        projectId: "project",
        message: "One steer",
        model: "fixture-model",
        reasoningEffort: "medium",
      }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.calls).toHaveLength(before);
  });
  it("updates once with current readback and returns historical confirmation on replay", async () => {
    const f = await fixture();
    expect(await f.title()).toMatchObject({
      status: "renamed",
      dispatchId,
      title: input.title,
      proof: "readback",
    });
    f.setName("Later native name");
    expect(await f.title(f.create())).toMatchObject({
      status: "recorded",
      dispatchId,
      title: input.title,
      proof: "historical",
    });
    expect(f.effects()).toBe(1);
    expect(
      f.calls.filter(
        (method) =>
          method === "thread/start" ||
          method === "turn/start" ||
          method === "thread/resume",
      ),
    ).toEqual([]);
  });
  it("reports changed expected title without mutating or reserving a retry", async () => {
    const f = await fixture();
    f.setName("Native edit");
    expect(await f.title()).toMatchObject({
      status: "title_changed",
      dispatchId,
      title: "Native edit",
    });
    expect(f.effects()).toBe(0);
    expect(
      await f.title(f.create(), { ...input, expectedTitle: "Native edit" }),
    ).toMatchObject({ status: "renamed" });
    expect(f.effects()).toBe(1);
  });
  it.each([
    { lostReply: true },
    { lateRename: true },
    { publicationFault: true },
  ])(
    "does not reinterpret unknown as success or repeat it with a new key: %j",
    async (options) => {
      const f = await fixture(options);
      expect(await f.title()).toMatchObject({
        status: "outcome_unknown",
        dispatchId,
      });
      f.setName(input.title);
      expect(await f.title(f.create())).toMatchObject({
        status: "outcome_unknown",
        dispatchId,
      });
      expect(
        await f.title(f.create(), { ...input, key: randomUUID() }),
      ).not.toMatchObject({ status: "renamed" });
      expect(f.effects()).toBe(1);
    },
  );
  it.each([{ adopted: true }, { drift: true }])(
    "does not make adopted/rebound tasks controllable: %j",
    async (options) => {
      const f = await fixture(options);
      expect(await f.title()).toMatchObject({ status: "refused" });
      expect(f.effects()).toBe(0);
    },
  );
  it("claims one title effect across concurrent journal instances", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.title(f.create()),
      f.title(f.create()),
    ]);
    expect(
      results.some(
        (result) => (result as { status: string }).status === "renamed",
      ),
    ).toBe(true);
    expect(f.effects()).toBe(1);
  });
  it.each([
    { workspaceId: "foreign" },
    { projectId: "foreign" },
    { key: "invalid" },
    { title: "" },
    { title: "a".repeat(1001) },
    { title: "🧭".repeat(251) },
    { expectedTitle: "bad\0name" },
    { title: "bad\0name" },
    { expectedTitle: 4 },
  ])("refuses invalid or foreign mutation input: %j", async (change) => {
    const f = await fixture();
    expect(await f.title(f.create(), { ...input, ...change })).toMatchObject({
      status: "refused",
    });
    expect(f.effects()).toBe(0);
  });
});
