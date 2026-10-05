// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatGptPublicTurn,
  readPublicAssistantMessages,
} from "../../src/apps/desktop/chatgpt-public-turn";
import { publicMarkdownBlock } from "../../src/apps/desktop/chatgpt-public-markdown";

// The harness is untyped JS. Exercise its real DOM reader in JSDOM and its
// observation loop with virtual time; no Electron, browser or provider runs.
const modulePath = "../e2e/lib/read-conversation-witness.mjs";
const {
  readConversationUi,
  waitConversationRead,
  conversationScript,
  conversationOutput,
  conversationId,
  conversationUiWitness,
} = await import(modulePath);
const surface = { evaluate: async (read: () => unknown) => read() };
const active = vi.fn();
const current = (value: { currentPresent: boolean }) => value.currentPresent;

function preview() {
  document.body.innerHTML = `
    <p role="status">Action in progress…</p>
    <section aria-label="Read-only file preview">
      <p role="status">Submission is pending. Do not send this preview again.</p>
      <button>Send to ChatGPT</button>
      <p>synthetic-file-body-excluded-from-diagnostics</p>
      <textarea>synthetic-draft-excluded-from-diagnostics</textarea>
    </section>`;
  const send = document.querySelector("button")!;
  const clicks = vi.spyOn(send, "click");
  send.click(); // Original one-shot Send; observation has no action authority.
  send.disabled = true;
  return clicks;
}

function projectTurn() {
  const script = conversationScript("Synthetic workspace");
  document.querySelector('[aria-label="Read-only file preview"]')!.remove();
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Read conversation");
  section.innerHTML = `
    <section aria-label="Current Chat turn" data-handle-id="handle-1"
      data-turn-id="turn-1" data-task-id="task-1"
      data-conversation-id="${conversationId}" data-cursor="1"
      data-phase="running" data-follow-ready="false">
      <p role="status">Turn in progress.</p>
      <p aria-label="Chat answer"></p>
      <button disabled>Acknowledge result</button>
    </section>
    <textarea disabled aria-label="Follow-up message"></textarea>
    <button disabled>Send follow-up</button>`;
  section.querySelector('[aria-label="Chat answer"]')!.textContent =
    conversationOutput[0][0];
  document.body.append(section);
  return script;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  active.mockClear();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("conversation transition observation, synthetic DOM only", () => {
  it.each([
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ])(
    "keeps the independent turn %s segment %s expectation equal to public Markdown",
    (turn, segment) => {
      const raw = conversationScript("Synthetic workspace")[turn].segments[
        segment
      ];
      expect(Object.keys(raw).sort()).toEqual(["id", "text"]);
      const paragraph = document.createElement("p");
      paragraph.textContent = raw.text;
      expect(publicMarkdownBlock(paragraph, () => true)).toBe(
        conversationOutput[turn][segment],
      );
    },
  );

  it("accepts the real public Markdown projection before terminal generation", async () => {
    preview();
    const script = projectTurn();
    const article = document.createElement("article");
    article.innerHTML = `<div data-message-id="${script[0].replyId}"
      data-parent-message-id="${script[0].userId}"
      data-message-author-role="assistant" data-message-channel="final"
      data-is-streaming="true"><div class="markdown"
      data-farol-source-profile="farol-controlled-settled-segments-v1">
      <p data-segment-id="${script[0].segments[0].id}"
      data-segment-state="settled"></p></div></div>`;
    article.querySelector("p")!.textContent = script[0].segments[0].text;
    const messages = readPublicAssistantMessages(
      [article.firstElementChild!],
      () => true,
      publicMarkdownBlock,
      () => true,
      true,
    );
    const output = new ChatGptPublicTurn(
      script[0].userId,
      script[0].replyId,
      0,
    ).observe({ userId: script[0].userId, messages, terminal: false }, 0);
    expect(output.completed).toBe(false);
    expect(output.items).toHaveLength(1);
    expect(output.answer).toBe(
      "The selected file is a read\\-only startup canary\\.",
    );
    document.querySelector('[aria-label="Chat answer"]')!.textContent =
      output.answer;
    const ui = await readConversationUi(surface);
    expect(() => conversationUiWitness(ui, "early", script, 0)).not.toThrow();
  });

  it("waits past 5 seconds for the original Send projection, before the 12-second command deadline", async () => {
    const clicks = preview();
    const failure = vi.fn();
    let settled = false;
    const pending = waitConversationRead(
      () => readConversationUi(surface),
      current,
      active,
      { onFailure: failure },
    ).then((value: unknown) => {
      settled = true;
      return value;
    });
    setTimeout(projectTurn, 9000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(settled).toBe(false);
    expect(failure).not.toHaveBeenCalled();
    expect(clicks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    const ui = await pending;
    expect(Date.now()).toBe(9000);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(ui).toMatchObject({ currentPresent: true, phase: "running" });
    // The existing exact identity/phase/answer/future-text checks still apply.
    expect(() =>
      conversationUiWitness(
        ui,
        "early",
        conversationScript("Synthetic workspace"),
        0,
      ),
    ).not.toThrow();
    expect(() =>
      conversationUiWitness(
        { ...(ui as object), conversationId: "crossed" },
        "early",
        conversationScript("Synthetic workspace"),
        0,
      ),
    ).toThrow("CHAT_UI_CID_CROSSED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "status",
      "Outcome unknown. The action may already have taken effect.",
      "CHAT_UI_REFUSED_OR_UNKNOWN",
    ],
    [
      "status",
      "Send is unavailable for the current account and model route. The file has not been resent.",
      "CHAT_UI_REFUSED_OR_UNKNOWN",
    ],
    ["alert", "Action refused: CHATGPT_MODEL_UNQUALIFIED", "CHAT_UI_ALERT"],
  ])(
    "stops on %s %s without a current turn or another Send",
    async (role, text, code) => {
      const clicks = preview();
      const status = document.createElement("p");
      status.setAttribute("role", role);
      status.textContent = text;
      document.body.append(status); // Includes shell feedback outside the preview.
      const failure = vi.fn();
      await expect(
        waitConversationRead(
          () => readConversationUi(surface),
          current,
          active,
          { onFailure: failure },
        ),
      ).rejects.toThrow(code);
      expect(Date.now()).toBe(0);
      expect(active).toHaveBeenCalledTimes(2); // Before and after the same read.
      expect(clicks).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(failure.mock.calls[0]?.[0]).toMatchObject({
        elapsedMillis: 0,
        lastUi: { currentPresent: false },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains the last bounded public UI and ledger counts when 20 seconds expire", async () => {
    const clicks = preview();
    const failure = vi.fn();
    const read = vi.fn(async () => ({
      ...(await readConversationUi(surface)),
      ledger: {
        attemptedSends: 0,
        acceptedSends: 0,
        accountGets: 2,
        accountSession: "synthetic-account-excluded-from-diagnostics",
      },
    }));
    const pending = waitConversationRead(read, current, active, {
      onFailure: failure,
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(19000);
    const notice = document.querySelector('section [role="status"]')!;
    notice.textContent = "Last pending observation. " + "x".repeat(10000);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    expect(error.message).toContain("CHAT_OBSERVATION_TIMEOUT_NO_RETRY");
    expect(error.message).toContain("Last pending observation.");
    expect(error.message.length).toBeLessThan(5000);
    expect(error.message).not.toContain("excluded-from-diagnostics");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      elapsedMillis: 20000,
      lastUi: {
        currentPresent: false,
        preview: {
          present: true,
          buttons: [{ name: "Send to ChatGPT", disabled: true }],
        },
        ledger: { attemptedSends: 0, acceptedSends: 0, accountGets: 2 },
      },
    });
    expect(JSON.stringify(failure.mock.calls)).not.toContain(
      "excluded-from-diagnostics",
    );
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the total deadline and previous diagnostic when a later DOM read stalls", async () => {
    const clicks = preview();
    const failure = vi.fn();
    let release: (value: unknown) => void = () => {};
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    const read = vi
      .fn()
      .mockImplementationOnce(() => readConversationUi(surface))
      .mockReturnValue(stalled);
    const pending = waitConversationRead(read, current, active, {
      onFailure: failure,
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await pending).message).toContain(
      "CHAT_OBSERVATION_TIMEOUT_NO_RETRY",
    );
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      elapsedMillis: 20000,
      lastUi: { currentPresent: false },
    });
    release({ currentPresent: true });
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed DOM read and rejects ambiguous current turns", async () => {
    preview();
    projectTurn();
    document
      .querySelector('[aria-label="Read conversation"]')!
      .append(
        document
          .querySelector('[aria-label="Current Chat turn"]')!
          .cloneNode(true),
      );
    const read = vi.fn(() => readConversationUi(surface));
    await expect(waitConversationRead(read, current, active)).rejects.toThrow(
      "CHAT_UI_CURRENT_AMBIGUOUS",
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "honors cancellation during a pending read (resolves=%s)",
    async (resolves) => {
      const clicks = preview();
      let cancelled = false;
      let release: (value: unknown) => void = () => {};
      const stalled = new Promise((resolve) => {
        release = resolve;
      });
      const read = vi
        .fn()
        .mockImplementationOnce(() => readConversationUi(surface))
        .mockReturnValue(stalled);
      const failure = vi.fn();
      const pending = waitConversationRead(
        read,
        current,
        () => {
          if (cancelled) throw new Error("HARNESS_CANCELLED");
        },
        { onFailure: failure },
      ).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(100);
      cancelled = true;
      if (resolves) release({ currentPresent: true });
      await vi.advanceTimersByTimeAsync(75);
      expect(failure).toHaveBeenCalledTimes(1);
      expect((await pending).message).toContain("HARNESS_CANCELLED");
      expect(failure.mock.calls[0]?.[0].lastUi).toMatchObject({
        currentPresent: false,
      });
      release({ currentPresent: true });
      await vi.advanceTimersByTimeAsync(30000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(clicks).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains a projected unknown phase without copying answer or history content", async () => {
    const clicks = preview();
    projectTurn();
    document
      .querySelector('[aria-label="Current Chat turn"]')!
      .setAttribute("data-phase", "unknown");
    document.querySelector('[aria-label="Chat answer"]')!.textContent =
      "synthetic-answer-excluded-from-diagnostics😀";
    document
      .querySelector('[aria-label="Current Chat turn"]')!
      .setAttribute("data-cursor", "2");
    const history = document.createElement("section");
    history.setAttribute("aria-label", "Previous turns");
    history.innerHTML =
      '<p class="notice">synthetic-history-excluded-from-diagnostics</p>';
    document.querySelector('[aria-label="Read conversation"]')!.append(history);
    const failure = vi.fn();
    const error = await waitConversationRead(
      () => readConversationUi(surface),
      current,
      active,
      { onFailure: failure },
    ).catch((error: Error) => error);
    expect(error.message).toContain("CHAT_UI_OUTCOME_UNKNOWN");
    expect(error.message).not.toContain("excluded-from-diagnostics");
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      lastUi: {
        currentPresent: true,
        phase: "unknown",
        cursor: "2",
        answerBytes: Buffer.byteLength(
          "synthetic-answer-excluded-from-diagnostics😀",
          "utf8",
        ),
      },
    });
    expect(JSON.stringify(failure.mock.calls)).not.toContain(
      "excluded-from-diagnostics",
    );
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
