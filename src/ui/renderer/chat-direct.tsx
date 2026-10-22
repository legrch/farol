import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RendererFacade, WindowSnapshot } from "./contract";
import { conversationDraftKey } from "./conversation-draft";
import { ReadConversationPromptSchema } from "../../pkg/product-settings/chat-conversation";

function fenced(snapshot: WindowSnapshot): boolean {
  return (
    snapshot.status !== "current" ||
    snapshot.configuration?.status !== "ready" ||
    !snapshot.buildId ||
    snapshot.readPreview !== null ||
    snapshot.readConversation !== null ||
    snapshot.configuration.settings.setup.chatgpt.outcomeUnknown ||
    Object.values(snapshot.intents).some(
      (i) => i.state === "pending" || i.state === "unknown",
    )
  );
}
function preview(snapshot: WindowSnapshot) {
  const p = snapshot.directChatPreview;
  return p &&
    p.buildId === snapshot.buildId &&
    snapshot.configuration?.status === "ready" &&
    p.revision === snapshot.configuration.settings.revision &&
    snapshot.intents[p.intention]?.state === "applied"
    ? p
    : null;
}

/** A window-owned unsent draft and explicit account confirmation. */
export function ChatDirect({
  snapshot,
  facade,
}: Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}>) {
  const drafts = facade.conversationDraft;
  const key = JSON.stringify(["typed-first", snapshot.buildId]);
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.read(key));
  const field = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const composition = useRef(false);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const observed = preview(snapshot);
  const inspectAttempt = Object.values(snapshot.intents).find((i) =>
    i.id.startsWith("chat-direct:inspect:"),
  );
  const sendAttempt = observed
    ? snapshot.intents[`chat-direct:start:${observed.value.operationId}`]
    : undefined;
  const paused = pending || fenced(snapshot);
  useLayoutEffect(() => {
    const input = field.current;
    const saved = drafts.read(key);
    input?.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    return () => {
      if (input)
        drafts.selection(key, input.selectionStart, input.selectionEnd);
    };
  }, [drafts, key]);

  async function inspect() {
    const before = facade.getSnapshot();
    if (
      busy.current ||
      fenced(before) ||
      before.directChatPreview ||
      Object.keys(before.intents).some((id) =>
        id.startsWith("chat-direct:inspect:"),
      )
    )
      return;
    busy.current = true;
    setPending(true);
    const operationId = crypto.randomUUID();
    try {
      const result = await facade.configure(
        { kind: "chatgpt.inspect-chat-account", operationId },
        `chat-direct:inspect:${operationId}`,
      );
      setMessage(
        result.state === "applied"
          ? "The open account was observed. Confirm it before sending."
          : result.state === "unknown"
            ? "Account inspection is unconfirmed. Sending is paused."
            : "Account inspection is unavailable. Check the connection and supported model settings.",
      );
    } catch {
      setMessage("Account inspection is unconfirmed. Sending is paused.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function start() {
    const before = facade.getSnapshot();
    const p = preview(before);
    const submitted = drafts.read(key);
    const intention = p ? `chat-direct:start:${p.value.operationId}` : "";
    if (
      busy.current ||
      composition.current ||
      fenced(before) ||
      !p ||
      before.intents[intention] ||
      !ReadConversationPromptSchema.safeParse(submitted.text).success
    )
      return;
    busy.current = true;
    setPending(true);
    try {
      const result = await facade.configure(
        {
          kind: "chatgpt.start-conversation",
          operationId: p.value.operationId,
          confirmationId: p.value.confirmationId,
          prompt: submitted.text,
        },
        intention,
      );
      if (result.state === "applied") {
        if (!composition.current) drafts.clearSubmitted(key, submitted.edit);
        const conversation = facade.getSnapshot().readConversation;
        const nextKey =
          conversation?.origin === "typed" &&
          conversation.operationId === p.value.operationId
            ? conversationDraftKey(conversation.turns.at(-1)?.view ?? null)
            : null;
        if (nextKey) drafts.rebind(key, nextKey);
      } else
        setMessage(
          result.state === "unknown"
            ? "The send outcome is unconfirmed. Do not send this message again."
            : "The message was refused. Review the current account and connection status.",
        );
    } catch {
      setMessage(
        "The send outcome is unconfirmed. Do not send this message again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (snapshot.readConversation) return null;
  return (
    <section
      className="settings-group"
      aria-label="New Chat conversation"
      data-operation-id={observed?.value.operationId}
      data-session-id={observed?.value.sessionId}
      data-confirmation-id={observed?.value.confirmationId}
    >
      <h2>Chat</h2>
      <p className="description">
        Review the signed-in account in ChatGPT, then check it here before
        sending your first message.
      </p>
      <div className="control-row">
        <button
          type="button"
          disabled={
            paused ||
            Boolean(inspectAttempt) ||
            Boolean(snapshot.directChatPreview)
          }
          onClick={() => void inspect()}
        >
          Check account
        </button>
      </div>
      <label className="field">
        First message
        <textarea
          ref={field}
          value={draft.text}
          onChange={(event) => {
            const i = event.currentTarget;
            drafts.capture(key, i.value, i.selectionStart, i.selectionEnd);
          }}
          onSelect={(event) => {
            const i = event.currentTarget;
            drafts.selection(key, i.selectionStart, i.selectionEnd);
          }}
          onCompositionStart={() => {
            composition.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composition.current = false;
            setComposing(false);
          }}
        />
      </label>
      <p className="description">
        Use a nonblank message of at most 8192 UTF-8 bytes.
      </p>
      <div className="control-row">
        <button
          type="button"
          className="primary"
          disabled={
            paused ||
            composing ||
            !observed ||
            Boolean(sendAttempt) ||
            !ReadConversationPromptSchema.safeParse(draft.text).success
          }
          onClick={() => void start()}
        >
          Use this account and send
        </button>
      </div>
      {observed && (
        <p role="status">The account will be checked again before sending.</p>
      )}
      {snapshot.directChatPreview && !observed && (
        <p role="status">
          The account check is no longer current. Sending is paused.
        </p>
      )}
      {(message || inspectAttempt?.code || sendAttempt?.code) && (
        <p role="status">
          {message ||
            "This conversation cannot continue from the current window state."}
        </p>
      )}
    </section>
  );
}
