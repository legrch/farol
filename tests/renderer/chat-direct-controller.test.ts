import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import type { ReadConversationView } from "../../src/pkg/product-settings/chat-conversation";
import { bootstrap, deferred, fixture } from "./fixture";

// jsdom with actual WindowController and mocked IPC. These replies are correlation
// fixtures, not evidence of a live account, Go execution or provider acceptance.
const operationId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const confirmationId = "77777777-7777-4777-8777-777777777777";
const otherId = "88888888-8888-4888-8888-888888888888";
const account = {
  kind: "chatgpt.chat-account-preview",
  operationId,
  sessionId,
  confirmationId,
  state: "observed",
} as const;
const start = {
  kind: "chatgpt.start-conversation",
  operationId,
  confirmationId,
  prompt: "First typed message",
} as const;
const base: ReadConversationView = {
  kind: "chatgpt.readonly-conversation",
  operationId,
  handleId: "first-handle",
  binding: {
    profileId: "profile",
    backendGeneration: "backend",
    ownerId: "owner",
    sessionId,
    taskId: "independent-go-task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "first-turn",
    operationId: "go-admission",
    turnGeneration: "1",
  },
  conversationId: "conversation",
  phase: "running",
  hasResult: false,
  deliveryAcknowledged: false,
  lifecycleSettled: false,
  released: false,
  followReady: false,
  cursor: "1",
  frames: [{ sequence: "1", delta: "Early." }],
};
const controllers: WindowController[] = [];
const fixtureCrypto = globalThis.crypto;
beforeEach(() =>
  vi.stubGlobal("crypto", {
    subtle: fixtureCrypto.subtle,
    randomUUID: vi.fn(() => operationId),
  }),
);
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(inspected = true) {
  const f = fixture(),
    c = new WindowController(f.api);
  controllers.push(c);
  await c.start();
  const snapshot = bootstrap().configuration;
  const reply = (evidence: unknown) => ({ ok: true, snapshot, evidence });
  if (inspected) {
    vi.mocked(f.api.configure).mockResolvedValueOnce(reply(account));
    expect(
      (
        await c.configure(
          { kind: "chatgpt.inspect-chat-account", operationId },
          `chat-direct:inspect:${operationId}`,
        )
      ).state,
    ).toBe("applied");
  }
  return { f, c, reply, snapshot };
}
describe("typed Chat reply adoption in the actual WindowController", () => {
  it.each([false, true])(
    "adopts the inspected session with an independent Go task and keeps early output (refresh=%s)",
    async (refresh) => {
      const h = await setup();
      vi.mocked(h.f.api.configure).mockImplementationOnce(async () => {
        if (refresh) await h.c.refresh();
        return h.reply(base);
      });
      expect((await h.c.configure(start, "start")).state).toBe("applied");
      const retained = h.c.getSnapshot().readConversation!;
      expect(retained).toMatchObject({
        origin: "typed",
        operationId,
        revision: 1,
        turns: [
          {
            text: "Early.",
            view: { binding: { sessionId, taskId: "independent-go-task" } },
          },
        ],
      });
      expect(h.c.getSnapshot().readPreview).toBeNull();
      const configuration = h.c.getSnapshot().configuration;
      expect(
        configuration?.status === "ready" &&
          configuration.settings.computer.workspaces,
      ).toEqual([]);
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        h.reply({
          ...base,
          cursor: "2",
          frames: [{ sequence: "2", delta: " More." }],
        }),
      );
      expect(
        (
          await h.c.configure(
            {
              kind: "chatgpt.observe-readonly-conversation",
              operationId,
              handleId: base.handleId,
              cursor: "1",
            },
            "progress",
          )
        ).state,
      ).toBe("applied");
      expect(h.c.getSnapshot().readConversation?.turns[0]?.text).toBe(
        "Early. More.",
      );
      expect(h.c.getSnapshot().readConversation?.origin).toBe("typed");
    },
  );

  it.each([
    ["wrong operation", { ...account, operationId: otherId }],
    ["non-UUID session", { ...account, sessionId: "session" }],
    ["non-UUID confirmation", { ...account, confirmationId: "confirmation" }],
    ["unsolicited approval", { ...account, state: "approved" }],
    ["no evidence", undefined],
  ])("rejects %s account inspection evidence", async (_label, evidence) => {
    const h = await setup(false);
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(evidence));
    expect(
      (
        await h.c.configure(
          { kind: "chatgpt.inspect-chat-account", operationId },
          "inspect",
        )
      ).state,
    ).toBe("unknown");
    expect(h.c.getSnapshot().directChatPreview).toBeNull();
    expect(h.c.getSnapshot().readConversation).toBeNull();
  });

  it.each([
    "absent inspection",
    "wrong confirmation",
    "wrong operation",
  ] as const)("does not adopt a typed first reply with %s", async (reason) => {
    const h = await setup(reason !== "absent inspection");
    const command = {
      ...start,
      ...(reason === "wrong confirmation" ? { confirmationId: otherId } : {}),
      ...(reason === "wrong operation" ? { operationId: otherId } : {}),
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(
      h.reply({ ...base, operationId: command.operationId }),
    );
    expect((await h.c.configure(command, "start")).state).toBe("unknown");
    expect(h.c.getSnapshot().readConversation).toBeNull();
  });

  it.each([
    [
      "wrong inspected session",
      { ...base, binding: { ...base.binding, sessionId: otherId } },
    ],
    ["wrong operation", { ...base, operationId: otherId }],
    [
      "non-first generation",
      { ...base, binding: { ...base.binding, turnGeneration: "2" } },
    ],
    [
      "skipped early cursor",
      { ...base, cursor: "2", frames: [{ sequence: "2", delta: "Early." }] },
    ],
    ["unsettled Follow", { ...base, followReady: true }],
  ])("does not adopt a first reply with %s", async (_label, evidence) => {
    const h = await setup();
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(evidence));
    expect(await h.c.configure(start, "start")).toMatchObject({
      state: "unknown",
      code: "READ_CONVERSATION_UNCONFIRMED",
    });
    expect(h.c.getSnapshot().readConversation).toBeNull();
    expect(h.c.getSnapshot().directChatPreview?.value).toEqual(account);
  });

  it.each(["inspection", "start"] as const)(
    "rejects a late %s reply after revision or build changes",
    async (action) => {
      for (const changed of ["revision", "build"] as const) {
        const h = await setup(action === "start");
        const held = deferred<unknown>(),
          entered = deferred<void>();
        vi.mocked(h.f.api.configure).mockImplementationOnce(() => {
          entered.resolve();
          return held.promise;
        });
        const pending = h.c.configure(
          action === "start"
            ? start
            : { kind: "chatgpt.inspect-chat-account", operationId },
          action,
        );
        await entered.promise;
        const next = bootstrap();
        if (changed === "revision") next.configuration.settings.revision++;
        else next.build.buildId = "4".repeat(64);
        vi.mocked(h.f.api.bootstrap).mockResolvedValueOnce(next);
        await h.c.refresh();
        held.resolve(h.reply(action === "start" ? base : account));
        expect((await pending).state).toBe("unknown");
        expect(h.c.getSnapshot().readConversation).toBeNull();
        if (action === "inspection")
          expect(h.c.getSnapshot().directChatPreview).toBeNull();
        expect(h.c.getSnapshot().status).toBe(
          changed === "build" ? "incompatible" : "current",
        );
      }
    },
  );

  it("latches identical pending and unknown Sends, rejects conflicting payloads, and retains no prompt in intents", async () => {
    const h = await setup();
    const held = deferred<unknown>(),
      entered = deferred<void>();
    vi.mocked(h.f.api.configure).mockImplementationOnce(() => {
      entered.resolve();
      return held.promise;
    });
    const a = h.c.configure(start, "start"),
      b = h.c.configure(start, "start");
    await entered.promise;
    expect(h.c.getSnapshot().intents.start?.state).toBe("pending");
    expect(
      await h.c.configure({ ...start, prompt: "Different" }, "start"),
    ).toMatchObject({ state: "refused", code: "INTENTION_PAYLOAD_CONFLICT" });
    held.resolve({});
    expect((await a).state).toBe("unknown");
    expect(await b).toEqual(await a);
    expect(await h.c.configure(start, "start")).toEqual(await a);
    expect(h.f.api.configure).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.c.getSnapshot().intents)).not.toContain(
      start.prompt,
    );
  });

  it.each(["", " \n\t", "x".repeat(8193), "é".repeat(4096) + "x", "\ud800"])(
    "refuses an invalid prompt before IPC (case %#)",
    async (prompt) => {
      const h = await setup();
      expect(await h.c.configure({ ...start, prompt }, "start")).toMatchObject({
        state: "refused",
        code: "SETTINGS_INPUT_INVALID",
      });
      expect(h.f.api.configure).toHaveBeenCalledTimes(1);
      expect(h.c.getSnapshot().readConversation).toBeNull();
    },
  );

  it.each([
    "profileId",
    "backendGeneration",
    "ownerId",
    "sessionId",
    "taskId",
    "taskEpoch",
    "participantId",
    "turnId",
    "operationId",
    "turnGeneration",
  ] as const)(
    "keeps early output and fences progress that crosses current binding %s",
    async (key) => {
      const h = await setup();
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(base));
      await h.c.configure(start, "start");
      const retained = h.c.getSnapshot().readConversation;
      const value =
        key === "taskEpoch" || key === "turnGeneration" ? "2" : "crossed";
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        h.reply({
          ...base,
          binding: { ...base.binding, [key]: value },
          cursor: "2",
          frames: [{ sequence: "2", delta: "Rejected." }],
        }),
      );
      expect(
        (
          await h.c.configure(
            {
              kind: "chatgpt.observe-readonly-conversation",
              operationId,
              handleId: base.handleId,
              cursor: "1",
            },
            "observe",
          )
        ).state,
      ).toBe("unknown");
      expect(h.c.getSnapshot().readConversation).toBe(retained);
      expect(retained?.turns[0]?.text).toBe("Early.");
    },
  );

  it.each(["handle", "cursor", "conversation"] as const)(
    "retains the adopted turn when progress crosses its current %s",
    async (changed) => {
      const h = await setup();
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(base));
      await h.c.configure(start, "start");
      const retained = h.c.getSnapshot().readConversation;
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        h.reply({
          ...base,
          ...(changed === "handle" ? { handleId: "crossed-handle" } : {}),
          ...(changed === "conversation"
            ? { conversationId: "crossed-conversation" }
            : {}),
          cursor: "2",
          frames: [{ sequence: "2", delta: "Rejected." }],
        }),
      );
      expect(
        (
          await h.c.configure(
            {
              kind: "chatgpt.observe-readonly-conversation",
              operationId,
              handleId: base.handleId,
              cursor: changed === "cursor" ? "0" : "1",
            },
            "observe",
          )
        ).state,
      ).toBe("unknown");
      expect(h.c.getSnapshot().readConversation).toBe(retained);
      expect(retained?.turns[0]?.text).toBe("Early.");
    },
  );
});
