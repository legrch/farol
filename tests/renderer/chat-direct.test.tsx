import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDirect } from "../../src/ui/renderer/chat-direct";
import { ChatReadonly } from "../../src/ui/renderer/chat-readonly";
import { WindowController } from "../../src/ui/renderer/controller";
import { conversationDraftKey } from "../../src/ui/renderer/conversation-draft";
import type { ReadConversationView } from "../../src/pkg/product-settings/chat-conversation";
import { bootstrap, deferred, fixture } from "./fixture";

// Real renderer/controller, mocked IPC replies only. No host, provider, browser,
// filesystem, packaged application, or account verification is exercised.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const operationId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const confirmationId = "77777777-7777-4777-8777-777777777777";
const roots: Root[] = [];
const controllers: WindowController[] = [];
const fixtureCrypto = globalThis.crypto;
beforeEach(() => {
  vi.stubGlobal("crypto", {
    subtle: fixtureCrypto.subtle,
    randomUUID: vi.fn(() => operationId),
  });
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function turn(
  overrides: Partial<ReadConversationView> = {},
): ReadConversationView {
  return {
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
    frames: [{ sequence: "1", delta: "Useful early output." }],
    ...overrides,
  };
}
async function mount(configuration = bootstrap().configuration) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration,
  });
  const reply = (evidence: unknown) => ({
    ok: true,
    snapshot: configuration,
    evidence,
  });
  vi.mocked(f.api.configure).mockImplementation(async (command) =>
    command.kind === "chatgpt.inspect-chat-account"
      ? reply({
          kind: "chatgpt.chat-account-preview",
          operationId: command.operationId,
          sessionId,
          confirmationId,
          state: "observed",
        })
      : reply(turn()),
  );
  const c = new WindowController(f.api);
  controllers.push(c);
  await c.start();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return snapshot.readConversation ? (
      <ChatReadonly snapshot={snapshot} facade={c} />
    ) : (
      <ChatDirect snapshot={snapshot} facade={c} />
    );
  }
  const render = async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
  };
  await render();
  const button = (label: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const field = () => host.querySelector("textarea")!;
  const type = async (text: string, start = text.length, end = start) => {
    await act(async () => {
      const input = field();
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, text);
      input.setSelectionRange(start, end);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const remount = async () => {
    await act(async () => root.render(null));
    await render();
  };
  const calls = () =>
    vi.mocked(f.api.configure).mock.calls.map(([command]) => command);
  return {
    f,
    c,
    root,
    host,
    reply,
    configuration,
    button,
    click,
    field,
    type,
    remount,
    render,
    calls,
  };
}
const inspect = "Check account",
  send = "Use this account and send";

describe("ChatDirect with the actual window controller", () => {
  it("observes, acknowledges and follows a typed conversation despite unrelated Computer outcomeUnknown", async () => {
    const configuration = bootstrap().configuration;
    configuration.settings.setup.computer.outcomeUnknown = true;
    const h = await mount(configuration);
    await h.type("First typed message");
    await h.click(inspect);
    await h.click(send);
    const first = h.c.getSnapshot().readConversation!.turns[0]!.view;
    expect(h.c.getSnapshot().readConversation?.origin).toBe("typed");
    expect(h.host.textContent).toContain("Useful early output.");
    const offered = {
      ...first,
      frames: [],
      phase: "result-ready",
      hasResult: true,
      result: {
        resultId: "result",
        outcome: "completed",
        code: "",
        text: "Useful early output.",
        complete: true,
        acknowledged: false,
        retention: "memory_only" as const,
      },
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(offered));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(h.calls()[2]).toEqual({
      kind: "chatgpt.observe-readonly-conversation",
      operationId,
      handleId: first.handleId,
      cursor: first.cursor,
    });
    expect(
      h.c.getSnapshot().readConversation?.turns[0]?.view.result?.text,
    ).toBe("Useful early output.");
    expect(h.button("Acknowledge result").disabled).toBe(false);
    const ready = {
      ...offered,
      phase: "delivered",
      deliveryAcknowledged: true,
      lifecycleSettled: true,
      released: true,
      followReady: true,
      result: { ...offered.result, acknowledged: true },
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(ready));
    await h.click("Acknowledge result");
    expect(h.calls()[3]).toEqual({
      kind: "chatgpt.ack-readonly-conversation",
      operationId,
      handleId: first.handleId,
      cursor: first.cursor,
      resultId: "result",
    });
    await h.type("Follow the same owner");
    expect(h.button("Send follow-up").disabled).toBe(false);
    const next = turn({
      handleId: "next-handle",
      cursor: "0",
      frames: [],
      binding: {
        ...first.binding,
        turnId: "next-turn",
        operationId: "next-admission",
        turnGeneration: "2",
      },
    });
    vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(next));
    await h.click("Send follow-up");
    expect(h.calls()[4]).toEqual({
      kind: "chatgpt.follow-readonly-conversation",
      operationId,
      handleId: first.handleId,
      prompt: "Follow the same owner",
    });
    expect(h.c.getSnapshot().readConversation?.turns[1]?.view.binding).toEqual(
      next.binding,
    );
    const retainedConfiguration = h.c.getSnapshot().configuration;
    expect(
      retainedConfiguration?.status === "ready" &&
        retainedConfiguration.settings.setup.computer.outcomeUnknown,
    ).toBe(true);
  });

  it("keeps the file-read conversation fenced by Computer outcomeUnknown", async () => {
    const configuration = bootstrap().configuration;
    configuration.settings.setup.computer.outcomeUnknown = true;
    const h = await mount(configuration);
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const metadata = {
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
      expiresAt: "2026-10-05T23:59:00.000Z",
      sendAvailable: true,
    };
    await act(async () => {
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(metadata));
      await h.c.configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        "prepare-read",
      );
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        h.reply({
          ...metadata,
          account: { confirmationId, state: "observed" },
        }),
      );
      await h.c.configure(
        { kind: "chatgpt.inspect-readonly-account", operationId },
        "inspect-read",
      );
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(
        h.reply({
          ...metadata,
          account: { confirmationId, state: "approved" },
        }),
      );
      await h.c.configure(
        {
          kind: "chatgpt.approve-readonly-account",
          operationId,
          confirmationId,
        },
        "approve-read",
      );
      const ready = turn({
        binding: { ...turn().binding, taskId: operationId },
        phase: "delivered",
        hasResult: true,
        deliveryAcknowledged: true,
        lifecycleSettled: true,
        released: true,
        followReady: true,
        result: {
          resultId: "result",
          outcome: "completed",
          code: "",
          text: "Useful early output.",
          complete: true,
          acknowledged: true,
          retention: "memory_only",
        },
      });
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(ready));
      expect(
        (
          await h.c.configure(
            { kind: "chatgpt.submit-readonly-task", operationId },
            "start-read",
          )
        ).state,
      ).toBe("applied");
    });
    expect(h.c.getSnapshot().readConversation?.origin).toBeUndefined();
    await h.type("Must stay fenced");
    expect(h.button("Send follow-up").disabled).toBe(true);
    await h.click("Send follow-up");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await h.remount();
    expect(h.button("Send follow-up").disabled).toBe(true);
    expect(h.calls().map((c) => c.kind)).toEqual([
      "chatgpt.prepare-readonly-task",
      "chatgpt.inspect-readonly-account",
      "chatgpt.approve-readonly-account",
      "chatgpt.submit-readonly-task",
    ]);
  });

  it("requires explicit inspection and sends the exact typed prompt once without Computer or read approval", async () => {
    const h = await mount();
    expect(h.configuration.settings.computer.workspaces).toEqual([]);
    expect(h.configuration.settings.setup.computer.verified).toBeNull();
    expect(h.c.getSnapshot().readPreview).toBeNull();
    expect(h.calls()).toEqual([]);
    await h.type("  First typed message\n");
    expect(h.button(send).disabled).toBe(true);
    await h.click(send);
    await h.render();
    await h.remount();
    expect(h.calls()).toEqual([]);
    await h.click(inspect);
    expect(h.calls()).toEqual([
      { kind: "chatgpt.inspect-chat-account", operationId },
    ]);
    expect(h.c.getSnapshot().directChatPreview?.value.state).toBe("observed");
    await h.remount();
    expect(h.calls()).toHaveLength(1);
    expect(h.button(send).disabled).toBe(false);
    await act(async () => {
      h.button(send).click();
      h.button(send).click();
    });
    expect(h.calls()).toEqual([
      { kind: "chatgpt.inspect-chat-account", operationId },
      {
        kind: "chatgpt.start-conversation",
        operationId,
        confirmationId,
        prompt: "  First typed message\n",
      },
    ]);
    expect(h.c.getSnapshot().readConversation).toMatchObject({
      origin: "typed",
    });
    expect(
      h.c.getSnapshot().readConversation?.turns[0]?.view.binding.taskId,
    ).not.toBe(operationId);
    expect(h.host.textContent).toContain("Useful early output.");
    expect(h.field().value).toBe("");
    await h.remount();
    expect(h.host.textContent).toContain("Useful early output.");
    expect(h.calls()).toHaveLength(2);
    expect(h.button("Send follow-up").disabled).toBe(true);
  });

  it.each(["pending", "unknown", "refused"] as const)(
    "fences a %s inspection across remount without retry or Send",
    async (state) => {
      const h = await mount();
      const held = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(held.promise);
      await h.type("First");
      await act(async () => {
        h.button(inspect).click();
        h.button(inspect).click();
      });
      await h.remount();
      expect(h.button(inspect).disabled).toBe(true);
      expect(h.button(send).disabled).toBe(true);
      if (state !== "pending") {
        await act(async () =>
          held.resolve(
            state === "unknown"
              ? {}
              : {
                  ok: false,
                  error: "CHATGPT_ACCOUNT_CHANGED",
                  snapshot: h.configuration,
                },
          ),
        );
        expect(Object.values(h.c.getSnapshot().intents)[0]?.state).toBe(state);
        await h.remount();
      }
      await h.click(inspect);
      await h.click(send);
      expect(h.button(inspect).disabled).toBe(true);
      expect(h.button(send).disabled).toBe(true);
      expect(h.calls()).toHaveLength(1);
      expect(h.c.getSnapshot().readConversation).toBeNull();
      if (state === "pending") await act(async () => held.resolve({}));
    },
  );

  it.each(["pending", "unknown", "refused"] as const)(
    "fences a %s first Send across remount and preserves its unsent draft",
    async (state) => {
      const h = await mount();
      await h.type("First");
      await h.click(inspect);
      const held = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(held.promise);
      await act(async () => {
        h.button(send).click();
        h.button(send).click();
      });
      await h.remount();
      if (state !== "pending") {
        await act(async () =>
          held.resolve(
            state === "unknown"
              ? {}
              : {
                  ok: false,
                  error: "CHATGPT_ACCOUNT_CHANGED",
                  snapshot: h.configuration,
                },
          ),
        );
        expect(
          h.c.getSnapshot().intents[`chat-direct:start:${operationId}`]?.state,
        ).toBe(state);
        await h.remount();
      }
      expect(h.field().value).toBe("First");
      expect(h.button(send).disabled).toBe(true);
      expect(h.button(inspect).disabled).toBe(true);
      await h.click(send);
      await h.click(inspect);
      expect(h.calls()).toHaveLength(2);
      expect(h.c.getSnapshot().readConversation).toBeNull();
      if (state === "pending") await act(async () => held.resolve({}));
    },
  );

  it("preserves text and caret through inspection, render and remount, and blocks IME submission", async () => {
    const h = await mount();
    await h.type("Typing a message", 2, 7);
    await h.click(inspect);
    await h.render();
    expect([h.field().selectionStart, h.field().selectionEnd]).toEqual([2, 7]);
    await h.remount();
    expect(h.field().value).toBe("Typing a message");
    expect([h.field().selectionStart, h.field().selectionEnd]).toEqual([2, 7]);
    await act(async () =>
      h
        .field()
        .dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        ),
    );
    expect(h.button(send).disabled).toBe(true);
    await h.click(send);
    await h.type("Typing with IME", 3, 8);
    await h.render();
    expect([h.field().selectionStart, h.field().selectionEnd]).toEqual([3, 8]);
    expect(h.calls()).toHaveLength(1);
    await act(async () =>
      h
        .field()
        .dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        ),
    );
    expect(h.button(send).disabled).toBe(false);
    await h.click(send);
    expect(h.calls()[1]).toMatchObject({ prompt: "Typing with IME" });
  });

  it("enforces nonblank, valid Unicode and the UTF-8 byte limit before IPC", async () => {
    const h = await mount();
    await h.click(inspect);
    for (const prompt of [
      "",
      " \n\t",
      "x".repeat(8193),
      "é".repeat(4096) + "x",
      "\ud800",
    ]) {
      await h.type(prompt);
      expect(h.button(send).disabled).toBe(true);
      await h.click(send);
    }
    expect(h.calls()).toHaveLength(1);
    const boundary = "é".repeat(4096);
    await h.type(boundary);
    expect(h.button(send).disabled).toBe(false);
    await h.click(send);
    expect(h.calls()[1]).toMatchObject({ prompt: boundary });
  });

  it("pauses an inspected account when configuration changes and never auto-sends on refresh", async () => {
    const h = await mount();
    await h.type("First");
    await h.click(inspect);
    const next = bootstrap();
    next.configuration.settings.revision++;
    vi.mocked(h.f.api.bootstrap).mockResolvedValueOnce(next);
    await act(async () => h.c.refresh());
    expect(h.button(send).disabled).toBe(true);
    expect(h.host.textContent).toContain("no longer current");
    await h.remount();
    await h.click(send);
    expect(h.calls()).toHaveLength(1);
    expect(h.field().value).toBe("First");
  });

  it.each([false, true])(
    "late first success clears only the submitted edit (newer draft=%s) and uses the existing Follow owner",
    async (newer) => {
      const h = await mount();
      await h.type("Submitted first");
      await h.click(inspect);
      const held = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(held.promise);
      await act(async () => h.button(send).click());
      await h.remount();
      if (newer) await h.type("Newer follow draft", 2, 8);
      const ready = turn({
        phase: "delivered",
        hasResult: true,
        deliveryAcknowledged: true,
        lifecycleSettled: true,
        released: true,
        followReady: true,
        result: {
          resultId: "result",
          outcome: "completed",
          code: "",
          text: "Useful early output.",
          complete: true,
          acknowledged: true,
          retention: "memory_only",
        },
      });
      await act(async () => held.resolve(h.reply(ready)));
      expect(h.field().value).toBe(newer ? "Newer follow draft" : "");
      expect(h.c.conversationDraft.read(conversationDraftKey(ready)).text).toBe(
        newer ? "Newer follow draft" : "",
      );
      expect(h.calls()).toHaveLength(2);
      await h.remount();
      expect(h.field().value).toBe(newer ? "Newer follow draft" : "");
      if (!newer) {
        expect(h.button("Send follow-up").disabled).toBe(true);
        return;
      }
      const next = turn({
        handleId: "next-handle",
        cursor: "0",
        frames: [],
        binding: {
          ...ready.binding,
          turnId: "next-turn",
          operationId: "next-admission",
          turnGeneration: "2",
        },
      });
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.reply(next));
      await h.click("Send follow-up");
      expect(h.calls()[2]).toEqual({
        kind: "chatgpt.follow-readonly-conversation",
        operationId,
        handleId: ready.handleId,
        prompt: "Newer follow draft",
      });
      const conversation = h.c.getSnapshot().readConversation!;
      expect(conversation.origin).toBe("typed");
      expect(conversation.turns).toHaveLength(2);
      expect(conversation.turns[1]?.view.binding.taskId).toBe(
        ready.binding.taskId,
      );
      expect(
        h.calls().filter((c) => c.kind === "chatgpt.start-conversation"),
      ).toHaveLength(1);
    },
  );

  it("preserves the newer draft's caret when a late first success transfers it into Follow", async () => {
    const h = await mount();
    await h.type("Submitted first");
    await h.click(inspect);
    const held = deferred<unknown>();
    vi.mocked(h.f.api.configure).mockReturnValueOnce(held.promise);
    await act(async () => h.button(send).click());
    await h.remount();
    await h.type("Newer follow draft", 2, 8);
    await act(async () => held.resolve(h.reply(turn())));
    expect(h.field().value).toBe("Newer follow draft");
    expect([h.field().selectionStart, h.field().selectionEnd]).toEqual([2, 8]);
    await h.remount();
    expect([h.field().selectionStart, h.field().selectionEnd]).toEqual([2, 8]);
    expect(h.calls()).toHaveLength(2);
  });

  it.each(["transport rejected", "valid unconfirmed reply"] as const)(
    "retains and fences the first draft after %s across remount",
    async (outcome) => {
      const h = await mount();
      await h.type("Do not repeat this first message");
      await h.click(inspect);
      if (outcome === "transport rejected")
        vi.mocked(h.f.api.configure).mockRejectedValueOnce(
          new Error("IPC unavailable"),
        );
      else
        vi.mocked(h.f.api.configure).mockResolvedValueOnce({
          ok: false,
          error: "CHATGPT_CONVERSATION_UNCONFIRMED",
          snapshot: h.configuration,
        });
      await h.click(send);
      expect(
        h.c.getSnapshot().intents[`chat-direct:start:${operationId}`]?.state,
      ).toBe("unknown");
      await h.remount();
      expect(h.field().value).toBe("Do not repeat this first message");
      expect(h.button(send).disabled).toBe(true);
      await h.click(send);
      expect(h.calls()).toHaveLength(2);
    },
  );
});
