import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReadConversation,
  type ReadConversationProps,
} from "../../src/ui/renderer/read-conversation";
import type { ReadConversationView } from "../../src/pkg/product-settings/chat-conversation";

// Component fixtures only: no Electron, Go execution, native host or provider proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots = new Set<Root>();
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function view(
  overrides: Partial<ReadConversationView> = {},
): ReadConversationView {
  return {
    kind: "chatgpt.readonly-conversation",
    operationId: "operation",
    handleId: "handle",
    binding: {
      profileId: "profile",
      backendGeneration: "backend",
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: "1",
      participantId: "participant",
      turnId: "turn",
      operationId: "operation",
      turnGeneration: "1",
    },
    conversationId: "conversation",
    phase: "running",
    hasResult: false,
    deliveryAcknowledged: false,
    lifecycleSettled: false,
    released: false,
    followReady: false,
    cursor: "0",
    frames: [],
    ...overrides,
  };
}
function result(
  overrides: Partial<NonNullable<ReadConversationView["result"]>> = {},
): NonNullable<ReadConversationView["result"]> {
  return {
    resultId: "result",
    outcome: "completed",
    code: "COMPLETED",
    text: "Retained final response.",
    complete: true,
    acknowledged: false,
    retention: "memory_only",
    ...overrides,
  };
}
function ready() {
  return view({
    phase: "delivered",
    hasResult: true,
    result: result({ acknowledged: true }),
    deliveryAcknowledged: true,
    lifecycleSettled: true,
    released: true,
    followReady: true,
  });
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mount(overrides: Partial<ReadConversationProps> = {}) {
  let props: ReadConversationProps = {
    view: view(),
    history: [],
    text: "",
    busy: false,
    blocked: false,
    onObserve: vi.fn(async () => {}),
    onAcknowledge: vi.fn(async () => {}),
    onFollow: vi.fn(async (_prompt: string) => {}),
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <ReadConversation {...props} />
        </StrictMode>,
      ),
    );
  };
  await render();
  const button = (label: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`Button missing: ${label}`);
    return found;
  };
  return {
    host,
    button,
    get props() {
      return props;
    },
    get field() {
      return host.querySelector("textarea")!;
    },
    async update(next: Partial<ReadConversationProps>) {
      props = { ...props, ...next };
      await render();
    },
    async click(label: string) {
      await act(async () => button(label).click());
    },
    async remount() {
      await act(async () => root.render(null));
      await render();
    },
    async unmount() {
      await act(async () => root.unmount());
      roots.delete(root);
    },
  };
}
async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function advance(milliseconds = 250) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}
function status(host: HTMLElement, term: string) {
  const dt = [...host.querySelectorAll("dt")].find(
    (item) => item.textContent === term,
  );
  return dt?.nextElementSibling?.textContent;
}

describe("ReadConversation presentation and explicit actions", () => {
  it("presents exact turn metadata and accessible controls without visible identities", async () => {
    const source = view({
      handleId: "exact-handle",
      conversationId: "exact-conversation",
      cursor: "18446744073709551615",
    });
    source.binding.turnId = "exact-turn";
    source.binding.taskId = "exact-task";
    const h = await mount({ view: source, text: "Useful answer." });
    const current = h.host.querySelector('[aria-label="Current Chat turn"]')!;
    const attributes = [
      ["data-handle-id", source.handleId],
      ["data-turn-id", source.binding.turnId],
      ["data-task-id", source.binding.taskId],
      ["data-conversation-id", source.conversationId],
      ["data-cursor", source.cursor],
      ["data-phase", source.phase],
      ["data-follow-ready", "false"],
    ] as const;
    for (const [name, value] of attributes)
      expect(current.getAttribute(name)).toBe(value);
    for (const value of [
      source.handleId,
      source.binding.turnId,
      source.binding.taskId,
      source.conversationId,
      source.cursor,
    ])
      expect(h.host.textContent).not.toContain(value);
    expect(
      current.querySelector('[aria-label="Chat answer"]')!.textContent,
    ).toBe("Useful answer.");
    expect(h.field.closest("label")!.textContent).toBe("Follow-up message");
    expect(h.button("Send follow-up").type).toBe("button");
    expect(h.button("Acknowledge result").type).toBe("button");
    await h.update({
      view: {
        ...source,
        cursor: "0",
        phase: "delivered",
        followReady: true,
        released: true,
        conversationId: "",
      },
    });
    expect(h.host.querySelector('[aria-label="Current Chat turn"]')).toBe(
      current,
    );
    expect(current.getAttribute("data-cursor")).toBe("0");
    expect(current.getAttribute("data-phase")).toBe("delivered");
    expect(current.getAttribute("data-follow-ready")).toBe("true");
    expect(current.getAttribute("data-conversation-id")).toBe("");
    await h.update({ view: null });
    for (const [name] of attributes)
      expect(current.hasAttribute(name)).toBe(false);
  });

  it("shows useful incremental text before a result, then prefers retained final text", async () => {
    const h = await mount({ text: "First useful delta.\nNext line." });
    expect(
      h.host.querySelector('[aria-label="Chat answer"]')!.textContent,
    ).toBe("First useful delta.Next line.");
    expect(
      h.host.querySelector('[aria-label="Chat answer"] br'),
    ).not.toBeNull();
    expect(h.button("Acknowledge result").disabled).toBe(true);
    expect(h.props.onAcknowledge).not.toHaveBeenCalled();
    await h.update({
      view: view({ phase: "result-ready", hasResult: true, result: result() }),
      text: "Old partial text.",
    });
    expect(h.host.textContent).toContain("Retained final response.");
    expect(h.host.textContent).not.toContain("Old partial text.");
    expect(status(h.host, "Result acknowledgement")).toBe("Not acknowledged");
    expect(status(h.host, "Lifecycle settlement")).toBe("Not settled");
    expect(status(h.host, "Resource release")).toBe("Not released");
    expect(h.button("Send follow-up").disabled).toBe(true);
    await h.update({
      view: view({ hasResult: true, result: result({ text: "" }) }),
    });
    expect(
      h.host.querySelector('[aria-label="Chat answer"]')!.textContent,
    ).toBe("");
  });

  it("retains prior-turn text as plain content, with final text preferred", async () => {
    const h = await mount({
      view: null,
      history: [
        {
          view: view({ handleId: "previous", result: result() }),
          text: "Partial",
        },
        {
          view: view({ handleId: "earlier" }),
          text: "<img src=x onerror=alert(1)>",
        },
      ],
    });
    expect(h.host.textContent).toContain("Retained final response.");
    expect(h.host.textContent).not.toContain("Partial");
    expect(h.host.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(h.host.querySelector("img")).toBeNull();
    expect(h.button("Acknowledge result").disabled).toBe(true);
    expect(h.props.onFollow).not.toHaveBeenCalled();
  });

  it.each(["unknown", "future-phase"])(
    "mount/remount with %s retains output and never observes, follows or ACKs automatically",
    async (phase) => {
      vi.useFakeTimers();
      const h = await mount({
        view: view({ phase, hasResult: true, result: result() }),
      });
      await advance(1000);
      await h.remount();
      await advance(1000);
      expect(h.host.textContent).toContain("The turn state is unknown.");
      expect(h.host.textContent).toContain("Retained final response.");
      expect(h.props.onObserve).not.toHaveBeenCalled();
      expect(h.props.onFollow).not.toHaveBeenCalled();
      expect(h.props.onAcknowledge).not.toHaveBeenCalled();
      expect(h.button("Acknowledge result").disabled).toBe(false);
      await h.click("Acknowledge result");
      expect(h.props.onAcknowledge).toHaveBeenCalledTimes(1);
      expect(h.props.onObserve).not.toHaveBeenCalled();
    },
  );

  it("serializes 250 ms observation, uses updated callbacks and cleans up", async () => {
    vi.useFakeTimers();
    const wait = deferred();
    const observe = vi.fn(() => wait.promise);
    const h = await mount({ onObserve: observe });
    expect(observe).not.toHaveBeenCalled();
    await advance(249);
    expect(observe).not.toHaveBeenCalled();
    await advance(1);
    expect(observe).toHaveBeenCalledTimes(1);
    const next = vi.fn(async () => {});
    await h.update({ onObserve: next, text: "More output." });
    await advance(1000);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    await act(async () => wait.resolve());
    await advance();
    expect(next).toHaveBeenCalledTimes(1);
    await h.unmount();
    await advance(1000);
    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps observing a completed unACKed result until release without inferring settlement", async () => {
    vi.useFakeTimers();
    const h = await mount({
      view: view({ phase: "result-ready", hasResult: true, result: result() }),
    });
    await advance(500);
    expect(h.props.onObserve).toHaveBeenCalledTimes(2);
    expect(h.props.onAcknowledge).not.toHaveBeenCalled();
    expect(status(h.host, "Delivery acknowledgement")).toBe("Not confirmed");
    expect(status(h.host, "Lifecycle settlement")).toBe("Not settled");
    await h.update({ view: ready() });
    await advance(1000);
    expect(h.props.onObserve).toHaveBeenCalledTimes(2);
    expect(status(h.host, "Result acknowledgement")).toBe("Acknowledged");
    expect(status(h.host, "Lifecycle settlement")).toBe("Settled");
    expect(status(h.host, "Resource release")).toBe("Released");
  });

  it("does not overlap observation when a paused effect restarts", async () => {
    vi.useFakeTimers();
    const wait = deferred();
    const observe = vi.fn(() => wait.promise);
    const h = await mount({ onObserve: observe });
    await advance();
    await h.update({ busy: true });
    await h.update({ busy: false });
    await advance(750);
    expect(observe).toHaveBeenCalledTimes(1);
    await act(async () => wait.resolve());
    await advance();
    expect(observe).toHaveBeenCalledTimes(2);
    await h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["blocked", "busy", "unknown", "released", "absent"])(
    "stops polling on %s even when an earlier observation is pending",
    async (state) => {
      vi.useFakeTimers();
      const wait = deferred();
      const observe = vi.fn(() => wait.promise);
      const h = await mount({ onObserve: observe });
      await advance();
      await h.update(
        state === "blocked" || state === "busy"
          ? { [state]: true }
          : {
              view:
                state === "absent"
                  ? null
                  : view({
                      phase: state === "unknown" ? "unknown" : "running",
                      released: state === "released",
                    }),
            },
      );
      await act(async () => wait.resolve());
      await advance(1000);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(h.props.onFollow).not.toHaveBeenCalled();
      expect(h.props.onAcknowledge).not.toHaveBeenCalled();
    },
  );

  it.each([
    "no-result",
    "not-offered",
    "result-ACKed",
    "delivery-ACKed",
    "blocked",
    "busy",
  ])("does not enable result ACK for %s", async (state) => {
    const h = await mount({
      view: view({
        phase: "unknown",
        hasResult: state !== "not-offered",
        ...(state === "no-result"
          ? {}
          : { result: result({ acknowledged: state === "result-ACKed" }) }),
        deliveryAcknowledged: state === "delivery-ACKed",
      }),
      blocked: state === "blocked",
      busy: state === "busy",
    });
    expect(h.button("Acknowledge result").disabled).toBe(true);
    await h.click("Acknowledge result");
    expect(h.props.onAcknowledge).not.toHaveBeenCalled();
  });

  it("ACK is explicit and synchronous duplicate clicks dispatch only once", async () => {
    const wait = deferred();
    const acknowledge = vi.fn(() => wait.promise);
    const h = await mount({
      view: view({ phase: "unknown", hasResult: true, result: result() }),
      onAcknowledge: acknowledge,
    });
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => {
      h.button("Acknowledge result").click();
      h.button("Acknowledge result").click();
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(h.button("Acknowledge result").disabled).toBe(true);
    expect(status(h.host, "Lifecycle settlement")).toBe("Not settled");
    await act(async () => wait.resolve());
    expect(status(h.host, "Result acknowledgement")).toBe("Not acknowledged");
  });

  it.each([
    "not-ready",
    "busy",
    "blocked",
    "unknown",
    "absent",
    "history-bound",
  ])(
    "requires explicit Follow readiness and local guards for %s",
    async (state) => {
      const h = await mount({
        view:
          state === "absent"
            ? null
            : {
                ...ready(),
                followReady: state !== "not-ready",
                phase: state === "unknown" ? "unknown" : "delivered",
              },
        busy: state === "busy",
        blocked: state === "blocked",
        history:
          state === "history-bound"
            ? Array.from({ length: 31 }, (_, index) => ({
                view: view({ handleId: `past-${index}` }),
                text: "Previous text.",
              }))
            : [],
      });
      await type(h.field, "Next question.");
      expect(h.button("Send follow-up").disabled).toBe(true);
      await h.click("Send follow-up");
      expect(h.props.onFollow).not.toHaveBeenCalled();
    },
  );

  it("Follow uses the exact draft only on click, guards duplicate clicks and preserves newer edits", async () => {
    const wait = deferred();
    const follow = vi.fn((_prompt: string) => wait.promise);
    const h = await mount({ view: ready(), onFollow: follow });
    await type(h.field, "  Next question.  ");
    await act(async () => {
      h.field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(follow).not.toHaveBeenCalled();
    await act(async () => {
      h.button("Send follow-up").click();
      h.button("Send follow-up").click();
    });
    expect(follow).toHaveBeenCalledExactlyOnceWith("  Next question.  ");
    expect(h.button("Send follow-up").disabled).toBe(true);
    await type(h.field, "A newer draft.");
    await act(async () => wait.resolve());
    expect(h.field.value).toBe("A newer draft.");
  });

  it("shares the synchronous action latch between Follow and ACK", async () => {
    const wait = deferred();
    const h = await mount({
      view: view({ followReady: true, hasResult: true, result: result() }),
      onFollow: vi.fn(() => wait.promise),
    });
    await type(h.field, "Next question.");
    await act(async () => {
      h.button("Send follow-up").click();
      h.button("Acknowledge result").click();
    });
    expect(h.props.onFollow).toHaveBeenCalledTimes(1);
    expect(h.props.onAcknowledge).not.toHaveBeenCalled();
    await act(async () => wait.resolve());
  });

  it("allows 30 previous turns, then disables Follow at 32 total turns", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      view: view({ handleId: `past-${index}` }),
      text: "Previous text.",
    }));
    const h = await mount({ view: ready(), history });
    await type(h.field, "Next question.");
    expect(h.button("Send follow-up").disabled).toBe(false);
    await h.update({
      history: [
        ...history,
        { view: view({ handleId: "last" }), text: "Last retained turn." },
      ],
    });
    await h.click("Send follow-up");
    expect(h.props.onFollow).not.toHaveBeenCalled();
    expect(h.field.value).toBe("Next question.");
    expect(h.host.textContent).toContain("Last retained turn.");
  });

  it.each([
    ["blank", " \n\t", false],
    ["ASCII limit", "a".repeat(8192), true],
    ["ASCII overflow", "a".repeat(8193), false],
    ["two-byte limit", "é".repeat(4096), true],
    ["two-byte overflow", "é".repeat(4097), false],
    ["emoji limit", "🙂".repeat(2048), true],
    ["emoji overflow", "🙂".repeat(2049), false],
    ["unpaired high surrogate", "x\ud800", false],
    ["unpaired low surrogate", "\udfffy", false],
    ["reversed surrogates", "\udc00\ud800", false],
  ] as const)(
    "validates %s as UTF-8 without altering the draft",
    async (_name, prompt, valid) => {
      const h = await mount({ view: ready() });
      await type(h.field, prompt);
      expect(h.button("Send follow-up").disabled).toBe(!valid);
      expect(h.field.value).toBe(prompt);
      await h.click("Send follow-up");
      if (valid)
        expect(h.props.onFollow).toHaveBeenCalledExactlyOnceWith(prompt);
      else expect(h.props.onFollow).not.toHaveBeenCalled();
    },
  );

  it("preserves the draft, focused textarea, caret and IME composition across progress updates", async () => {
    const h = await mount({ view: ready() });
    const field = h.field;
    await type(field, "Draft 日本語");
    field.focus();
    field.setSelectionRange(2, 5);
    await act(async () => {
      field.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      h.button("Send follow-up").click();
    });
    await h.update({
      view: view({ cursor: "3" }),
      text: "New delta.",
      busy: true,
    });
    expect(h.field).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Draft 日本語");
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 5]);
    await h.update({ view: ready(), busy: false });
    expect(h.button("Send follow-up").disabled).toBe(true);
    expect(h.props.onFollow).not.toHaveBeenCalled();
    await act(async () => {
      field.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
    });
    expect(h.button("Send follow-up").disabled).toBe(false);
    await h.click("Send follow-up");
    expect(h.props.onFollow).toHaveBeenCalledExactlyOnceWith("Draft 日本語");
  });

  it.each(["observe", "acknowledge", "follow"] as const)(
    "uses safe failure text after %s and prevents repeats",
    async (action) => {
      vi.useFakeTimers();
      const fail = vi.fn(async () => {
        throw new Error("private raw diagnostic <secret>");
      });
      const h = await mount(
        action === "observe"
          ? { onObserve: fail }
          : action === "acknowledge"
            ? {
                view: view({
                  phase: "unknown",
                  hasResult: true,
                  result: result(),
                }),
                onAcknowledge: fail,
              }
            : { view: ready(), onFollow: fail },
      );
      if (action === "observe") await advance();
      else if (action === "acknowledge") await h.click("Acknowledge result");
      else {
        await type(h.field, "Retain this draft.");
        await h.click("Send follow-up");
      }
      expect(h.host.querySelector('[role="alert"]')!.textContent).toContain(
        "paused",
      );
      expect(h.host.textContent).not.toContain("private raw diagnostic");
      expect(h.host.textContent).not.toContain("<secret>");
      await advance(1000);
      await h.click("Acknowledge result");
      await h.click("Send follow-up");
      expect(fail).toHaveBeenCalledTimes(1);
      if (action === "follow") expect(h.field.value).toBe("Retain this draft.");
    },
  );
});
