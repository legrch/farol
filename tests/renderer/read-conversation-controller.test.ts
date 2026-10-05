import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import type { ReadConversationView } from "../../src/pkg/product-settings/chat-conversation";
import { fixture, bootstrap, deferred } from "./fixture";
const operationId = "44444444-4444-4444-8444-444444444444",
  workspaceId = "22222222-2222-4222-8222-222222222222",
  confirmationId = "77777777-7777-4777-8777-777777777777";
const binding = {
  profileId: "profile",
  backendGeneration: "backend",
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  operationId,
  turnGeneration: "1",
};
const base: ReadConversationView = {
  kind: "chatgpt.readonly-conversation",
  operationId,
  handleId: "first",
  binding,
  conversationId: "conversation",
  phase: "running",
  hasResult: false,
  deliveryAcknowledged: false,
  lifecycleSettled: false,
  released: false,
  followReady: false,
  cursor: "0",
  frames: [],
};
const controllers: WindowController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.restoreAllMocks();
});
async function setup() {
  const f = fixture(),
    c = new WindowController(f.api);
  controllers.push(c);
  await c.start();
  const snapshot = bootstrap().configuration;
  const preview = {
    kind: "chatgpt.readonly-task-preview",
    operationId,
    workspaceId,
    workspaceLabel: "Workspace",
    relativePath: "note.md",
    bytes: 4,
    contextCharacters: 4,
    contextLimit: 24000,
    contextTruncated: false,
    excludedPaths: [],
    expiresAt: "2026-10-05T05:00:00.000Z",
    sendAvailable: true,
  };
  const reply = (evidence: unknown) => ({ ok: true, snapshot, evidence });
  vi.mocked(f.api.configure).mockResolvedValueOnce(reply(preview));
  await c.configure(
    { kind: "chatgpt.prepare-readonly-task", workspaceId },
    "chat-readonly:prepare:test",
  );
  vi.mocked(f.api.configure).mockResolvedValueOnce(
    reply({ ...preview, account: { confirmationId, state: "observed" } }),
  );
  await c.configure(
    { kind: "chatgpt.inspect-readonly-account", operationId },
    "inspect",
  );
  vi.mocked(f.api.configure).mockResolvedValueOnce(
    reply({ ...preview, account: { confirmationId, state: "approved" } }),
  );
  await c.configure(
    { kind: "chatgpt.approve-readonly-account", operationId, confirmationId },
    "approve",
  );
  return { f, c, reply };
}
describe("renderer adoption of exact Go conversation replies", () => {
  it.each([false, true])(
    "keeps early text, explicit result ACK, and same-owner follow-up (refresh=%s)",
    async (refresh) => {
      const { f, c, reply } = await setup();
      const respond = (evidence: unknown) =>
        vi.mocked(f.api.configure).mockImplementationOnce(async () => {
          if (refresh) await c.refresh();
          return reply(evidence);
        });
      const command = {
        kind: "chatgpt.submit-readonly-task" as const,
        operationId,
      };
      respond(base);
      expect((await c.configure(command, "send")).state).toBe("applied");
      const early = {
        ...base,
        cursor: "1",
        frames: [{ sequence: "1", delta: "Early." }],
      };
      respond(early);
      expect(
        (
          await c.configure(
            {
              kind: "chatgpt.observe-readonly-conversation",
              operationId,
              handleId: "first",
              cursor: "0",
            },
            "observe",
          )
        ).state,
      ).toBe("applied");
      expect(c.getSnapshot().readConversation?.turns[0]?.text).toBe("Early.");
      expect(c.getSnapshot().readConversation?.turns[0]?.view.hasResult).toBe(
        false,
      );
      const offered = {
        ...early,
        frames: [],
        phase: "result-ready",
        hasResult: true,
        result: {
          resultId: "result",
          outcome: "completed",
          code: "",
          text: "Early.",
          complete: true,
          acknowledged: false,
          retention: "memory_only",
        },
      };
      respond(offered);
      await c.configure(
        {
          kind: "chatgpt.observe-readonly-conversation",
          operationId,
          handleId: "first",
          cursor: "1",
        },
        "observe",
      );
      expect(c.getSnapshot().readConversation?.turns[0]?.view.followReady).toBe(
        false,
      );
      const ready = {
        ...offered,
        deliveryAcknowledged: true,
        lifecycleSettled: true,
        released: true,
        followReady: true,
        result: { ...offered.result, acknowledged: true },
      };
      respond(ready);
      expect(
        (
          await c.configure(
            {
              kind: "chatgpt.ack-readonly-conversation",
              operationId,
              handleId: "first",
              resultId: "result",
              cursor: "1",
            },
            "ack",
          )
        ).state,
      ).toBe("applied");
      const next = {
        ...base,
        handleId: "second",
        binding: {
          ...binding,
          turnId: "next-turn",
          operationId: "next-op",
          turnGeneration: "2",
        },
      };
      respond(next);
      expect(
        (
          await c.configure(
            {
              kind: "chatgpt.follow-readonly-conversation",
              operationId,
              handleId: "first",
              prompt: "Next?",
            },
            "follow",
          )
        ).state,
      ).toBe("applied");
      expect(c.getSnapshot().readConversation?.turns).toHaveLength(2);
      expect(
        c.getSnapshot().readConversation?.turns[0]?.view.result?.text,
      ).toBe("Early.");
      expect(
        vi
          .mocked(f.api.configure)
          .mock.calls.filter(
            ([x]) => x.kind === "chatgpt.submit-readonly-task",
          ),
      ).toHaveLength(1);
    },
  );
  it("keeps a reply fenced when refresh changes its configuration revision", async () => {
    const { f, c, reply } = await setup();
    const held = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValueOnce(held.promise);
    const pending = c.configure(
      { kind: "chatgpt.submit-readonly-task", operationId },
      "send",
    );
    const next = bootstrap();
    next.configuration.settings.revision += 1;
    vi.mocked(f.api.bootstrap).mockResolvedValueOnce(next);
    await c.refresh();
    held.resolve(reply(base));
    expect((await pending).state).toBe("unknown");
    expect(c.getSnapshot().readConversation).toBeNull();
    expect(c.getSnapshot().configuration).toEqual(next.configuration);
  });
  it("latches a double Send synchronously and refuses crossed owner evidence without adoption", async () => {
    const { f, c, reply } = await setup();
    const held = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValueOnce(held.promise);
    const cmd = { kind: "chatgpt.submit-readonly-task" as const, operationId };
    const a = c.configure(cmd, "send"),
      b = c.configure(cmd, "send");
    await Promise.resolve();
    await Promise.resolve();
    held.resolve(
      reply({ ...base, binding: { ...binding, operationId: "replacement" } }),
    );
    expect((await a).state).toBe("unknown");
    expect((await b).state).toBe("unknown");
    expect(c.getSnapshot().readConversation).toBeNull();
    await c.configure(cmd, "send");
    expect(
      vi
        .mocked(f.api.configure)
        .mock.calls.filter(([x]) => x.kind === cmd.kind),
    ).toHaveLength(1);
  });
  it("does not convert a host uncertainty reply to a retryable refusal", async () => {
    const { f, c } = await setup();
    vi.mocked(f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CHATGPT_CONVERSATION_UNCONFIRMED",
      snapshot: bootstrap().configuration,
    });
    expect(
      (
        await c.configure(
          { kind: "chatgpt.submit-readonly-task", operationId },
          "send",
        )
      ).state,
    ).toBe("unknown");
  });
});
