import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  conversationDraftKey,
  type ConversationDraftStore,
} from "./conversation-draft";
import {
  ReadConversationPromptSchema,
  type ReadConversationView,
} from "../../pkg/product-settings/chat-conversation";

export type ReadConversationProps = Readonly<{
  title?: string;
  drafts: ConversationDraftStore;
  view: ReadConversationView | null;
  history: readonly { view: ReadConversationView; text: string }[];
  text: string;
  busy: boolean;
  blocked: boolean;
  onObserve: () => Promise<void>;
  onAcknowledge: () => Promise<void>;
  onFollow: (prompt: string) => Promise<void>;
}>;

function phaseLabel(phase: string): string | null {
  switch (phase) {
    case "admitted":
      return "Turn admitted.";
    case "pending":
      return "Turn queued.";
    case "running":
      return "Turn in progress.";
    case "awaiting-owner":
      return "Turn awaiting owner action.";
    case "result-ready":
      return "Result ready.";
    case "delivered":
      return "Result delivered.";
    case "cancelled":
      return "Turn cancelled.";
    default:
      return null;
  }
}

function plainText(text: string) {
  return text.split("\n").map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}

/** Presentation and an unsent local draft; the window retains turn ownership. */
export function ReadConversation({
  title = "Read conversation",
  drafts,
  view,
  history,
  text,
  busy,
  blocked,
  onObserve,
  onAcknowledge,
  onFollow,
}: ReadConversationProps) {
  const draftKey = conversationDraftKey(view);
  const draft = useSyncExternalStore(drafts.subscribe, () =>
    drafts.read(draftKey),
  );
  const field = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [failure, setFailure] = useState("");
  const action = useRef(false);
  const observing = useRef(false);
  const composition = useRef(false);
  const failed = useRef(false);
  const mounted = useRef(false);
  const observe = useRef(onObserve);
  const label = view ? phaseLabel(view.phase) : null;
  const paused = blocked || busy || pending || failure !== "";
  const observeEnabled = Boolean(view && label && !view.released && !paused);
  const offered = Boolean(
    view?.hasResult &&
    view.result &&
    !view.result.acknowledged &&
    !view.deliveryAcknowledged,
  );
  const validDraft = ReadConversationPromptSchema.safeParse(draft.text).success;
  const followEnabled = Boolean(
    view?.followReady &&
    label &&
    history.length < 31 &&
    !paused &&
    !composing &&
    validDraft,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const input = field.current;
    const saved = drafts.read(draftKey);
    input?.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    // Preserve caret on section unmount without moving focus on its return.
    return () => {
      if (input)
        drafts.selection(draftKey, input.selectionStart, input.selectionEnd);
    };
  }, [draftKey, drafts]);
  useLayoutEffect(() => {
    // A first-turn reply can bind an already-mounted Follow field to newer
    // unsent text. Restore its retained selection without moving focus or IME.
    const input = field.current;
    // Unmount cleanup may have captured a newer selection after this render.
    const saved = drafts.read(draftKey);
    if (input && !composition.current && input.value === saved.text)
      input.setSelectionRange(saved.selectionStart, saved.selectionEnd);
  }, [draft, draftKey, drafts]);
  useEffect(() => {
    observe.current = onObserve;
  }, [onObserve]);
  useEffect(() => {
    if (!observeEnabled) return;
    let stopped = false;
    let timer = setTimeout(() => void poll(), 250);
    async function poll() {
      if (stopped || failed.current) return;
      // A changed view/effect must not overlap an earlier pending observation.
      if (!observing.current && !action.current) {
        observing.current = true;
        try {
          await observe.current();
        } catch {
          failed.current = true;
          if (mounted.current)
            setFailure(
              "The turn could not be observed. Actions are paused until its state is confirmed.",
            );
        } finally {
          observing.current = false;
        }
      }
      if (!stopped && !failed.current)
        timer = setTimeout(() => void poll(), 250);
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [observeEnabled]);

  async function acknowledge() {
    if (action.current || failed.current || paused || !offered) return;
    action.current = true;
    setPending(true);
    try {
      await onAcknowledge();
    } catch {
      failed.current = true;
      if (mounted.current)
        setFailure(
          "Result acknowledgement is unconfirmed. Actions are paused; do not repeat it.",
        );
    } finally {
      action.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function follow() {
    if (
      action.current ||
      failed.current ||
      composition.current ||
      !followEnabled
    )
      return;
    const submitted = draft.text;
    const submittedEdit = draft.edit;
    action.current = true;
    setPending(true);
    try {
      await onFollow(submitted);
      if (!composition.current) drafts.clearSubmitted(draftKey, submittedEdit);
    } catch {
      failed.current = true;
      if (mounted.current)
        setFailure(
          "The follow-up outcome is unconfirmed. Actions are paused; do not send it again.",
        );
    } finally {
      action.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section className="settings-group" aria-label={title}>
      <h2>{title}</h2>
      {history.length > 0 && (
        <section aria-label="Previous turns">
          <h3>Previous turns</h3>
          {history.map((turn) => (
            <p className="notice" key={turn.view.handleId}>
              {plainText(turn.view.result?.text ?? turn.text)}
            </p>
          ))}
        </section>
      )}
      <section
        aria-label="Current Chat turn"
        data-handle-id={view?.handleId}
        data-turn-id={view?.binding.turnId}
        data-task-id={view?.binding.taskId}
        data-conversation-id={view?.conversationId}
        data-cursor={view?.cursor}
        data-phase={view?.phase}
        data-follow-ready={view?.followReady}
      >
        <p role="status">
          {view
            ? (label ??
              "The turn state is unknown. Automatic observation is paused.")
            : "No current turn is available."}
        </p>
        <p className="notice" aria-label="Chat answer">
          {plainText(view?.result?.text ?? text)}
        </p>
        {view && (
          <>
            {view.result && (
              <p>
                {view.result.complete
                  ? "Result complete."
                  : "Result incomplete."}
              </p>
            )}
            <dl>
              <dt>Result acknowledgement</dt>
              <dd>
                {view.result
                  ? view.result.acknowledged
                    ? "Acknowledged"
                    : "Not acknowledged"
                  : "No result offered"}
              </dd>
              <dt>Delivery acknowledgement</dt>
              <dd>
                {view.deliveryAcknowledged ? "Confirmed" : "Not confirmed"}
              </dd>
              <dt>Lifecycle settlement</dt>
              <dd>{view.lifecycleSettled ? "Settled" : "Not settled"}</dd>
              <dt>Resource release</dt>
              <dd>{view.released ? "Released" : "Not released"}</dd>
            </dl>
          </>
        )}
        <div className="control-row">
          <button
            type="button"
            disabled={paused || !offered}
            onClick={() => void acknowledge()}
          >
            Acknowledge result
          </button>
        </div>
      </section>
      <label className="field">
        Follow-up message
        <textarea
          ref={field}
          value={draft.text}
          onChange={(event) => {
            const input = event.currentTarget;
            drafts.capture(
              draftKey,
              input.value,
              input.selectionStart,
              input.selectionEnd,
            );
          }}
          onSelect={(event) => {
            const input = event.currentTarget;
            drafts.selection(
              draftKey,
              input.selectionStart,
              input.selectionEnd,
            );
          }}
          onCompositionStart={(event) => {
            composition.current = true;
            setComposing(true);
            const input = event.currentTarget;
            drafts.capture(
              draftKey,
              input.value,
              input.selectionStart,
              input.selectionEnd,
            );
          }}
          onCompositionEnd={() => {
            composition.current = false;
            setComposing(false);
          }}
        />
      </label>
      <p className="description">
        Follow becomes available when the current turn is ready. Use a nonblank
        prompt of at most 8192 UTF-8 bytes.
      </p>
      {history.length >= 31 && (
        <p role="status">
          The retained conversation has reached its turn limit.
        </p>
      )}
      <div className="control-row">
        <button
          type="button"
          className="primary"
          disabled={!followEnabled}
          onClick={() => void follow()}
        >
          Send follow-up
        </button>
      </div>
      {(blocked || busy || pending) && (
        <p role="status">Conversation actions are paused.</p>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}
