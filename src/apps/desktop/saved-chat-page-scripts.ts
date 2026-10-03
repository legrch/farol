import { z } from "zod";
import {
  PublicTurnFrameSchema,
  readPublicAssistantMessages,
  publicContentVisible,
} from "./chatgpt-public-turn";
import { publicMarkdownBlock } from "./chatgpt-public-markdown";

// These scripts run only in the isolated Next ChatGPT partition. First-message
// helpers return content-free metadata. Follow-up observation returns only the
// bounded public frame of the caller-bound turn, never account text or full history.

const visible = `const visible = (element) => {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
};`;

const composer = `const composer = [
  document.querySelector("#prompt-textarea"),
  document.querySelector('[data-testid="prompt-textarea"]'),
  document.querySelector('[contenteditable="true"][data-virtualkeyboard="true"]')
].find(visible);
const composerText = () => composer instanceof HTMLTextAreaElement
  ? composer.value : (composer?.innerText ?? composer?.textContent ?? "");`;

const emptyNormal = `const normalEmpty = () =>
  location.href === expectedHref &&
  new URL(location.href).searchParams.get("temporary-chat") !== "true" &&
  ![...document.querySelectorAll("button")].some((button) =>
    visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") &&
  document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length === 0 &&
  composer instanceof HTMLElement && composerText() === "";`;

const digest = `const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(value.replace(/\\r\\n?/g, "\\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};`;

export function savedChatReadinessScript(expectedHref: string): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    ${visible}
    ${composer}
    ${emptyNormal}
    return { ready: normalEmpty() };
  })()`;
}

export function savedChatInsertScript(
  expectedHref: string,
  message: string,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const message = ${JSON.stringify(message)};
    ${visible}
    ${composer}
    ${emptyNormal}
    if (!normalEmpty()) return { inserted: false };
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return { inserted: false };
      setter.call(composer, message);
    } else {
      composer.replaceChildren(document.createTextNode(message));
    }
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true, data: message, inputType: "insertText"
    }));
    return { inserted: true };
  })()`;
}

/** Hash check and single click are one page operation; an unknown answer is never retried. */
export function savedChatSubmitScript(
  expectedHref: string,
  expectedDigest: string,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const expectedDigest = ${JSON.stringify(expectedDigest)};
    ${visible}
    ${composer}
    ${digest}
    const safe = () => location.href === expectedHref &&
      new URL(location.href).searchParams.get("temporary-chat") !== "true" &&
      ![...document.querySelectorAll("button")].some((button) =>
        visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") &&
      document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length === 0 &&
      composer instanceof HTMLElement;
    if (!safe()) return { clicked: false };
    const text = composerText();
    if (await sha256(text) !== expectedDigest || !safe() || composerText() !== text)
      return { clicked: false };
    if (location.href !== expectedHref ||
        new URL(location.href).searchParams.get("temporary-chat") === "true" ||
        [...document.querySelectorAll("button")].some((button) =>
          visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") ||
        document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length !== 0 ||
        !(composer instanceof HTMLElement))
      return { clicked: false };
    const send = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="Send message"]'),
      document.querySelector('button[aria-label="Send"]')
    ].find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
    if (!(send instanceof HTMLButtonElement)) return { clicked: false };
    send.click();
    return { clicked: true };
  })()`;
}

/** A fresh helper must also prove an exact visible history entry. */
export function savedChatProofScript(
  expectedHref: string,
  firstMessageDigest: string,
  titleDigest: string,
  requireHistory: boolean,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const firstMessageDigest = ${JSON.stringify(firstMessageDigest)};
    const titleDigest = ${JSON.stringify(titleDigest)};
    const requireHistory = ${JSON.stringify(requireHistory)};
    ${visible}
    ${digest}
    if (location.href !== expectedHref) return { verified: false, titleVerified: false };
    const messages = [...document.querySelectorAll('[data-message-author-role="user"]')].filter(visible);
    if (messages.length !== 1 || await sha256(messages[0].innerText ?? messages[0].textContent ?? "") !== firstMessageDigest)
      return { verified: false, titleVerified: false };
    const expectedPath = new URL(expectedHref).pathname;
    const historyRoots = [...document.querySelectorAll('[data-testid="history"],nav[aria-label="Chat history"],nav[aria-label="History"]')].filter(visible);
    const history = [...new Set(historyRoots.flatMap((root) => [...root.querySelectorAll('a[href]')]))].filter((link) => {
      if (!visible(link)) return false;
      try {
        const target = new URL(link.href, location.href);
        return target.origin === new URL(expectedHref).origin &&
          target.pathname === expectedPath && !target.search && !target.hash;
      }
      catch { return false; }
    });
    if (requireHistory && history.length !== 1)
      return { verified: false, titleVerified: false };
    return {
      verified: true,
      titleVerified: history.length === 1 &&
        await sha256(history[0].innerText ?? history[0].textContent ?? "") === titleDigest
    };
  })()`;
}

// Candidate physical profile only. Literal control values are supplied by Chat;
// this adapter has no model catalogue, account inference or durable operation state.
const savedId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const savedGeneration = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const SavedChatPhysicalBindingSchema = z.strictObject({
  conversationId: savedId,
  conversationUrl: z.string().url().max(2048),
  viewId: savedId,
  viewGeneration: savedGeneration,
  documentGeneration: savedGeneration,
  partition: z.enum([
    "persist:farol-next-chatgpt",
    "persist:farol-dev-chatgpt",
  ]),
});
export type SavedChatPhysicalBinding = Readonly<
  z.infer<typeof SavedChatPhysicalBindingSchema>
>;
export const SavedChatFollowUpRequestSchema = z.strictObject({
  binding: SavedChatPhysicalBindingSchema,
  selection: z.strictObject({
    model: savedId,
    effort: savedId,
    connector: z.strictObject({ id: savedId, label: savedId }),
  }),
  previous: z.strictObject({ userId: savedId, assistantId: savedId }),
  operation: z.strictObject({
    id: savedId,
    state: z.enum(["not-sent", "submitted", "unknown"]),
  }),
  message: z
    .string()
    .min(1)
    .max(64 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceId: savedId.nullable(),
  correlation: z
    .strictObject({ userId: savedId, assistantId: savedId.nullable() })
    .nullable(),
});
export const SavedChatFollowUpActionSchema = z.enum([
  "prepare",
  "submit",
  "observe",
]);
export type SavedChatFollowUpRequest = Readonly<
  z.infer<typeof SavedChatFollowUpRequestSchema>
>;
export const SavedChatFollowUpCodeSchema = z.enum([
  "SAVED_CHAT_INVALID",
  "SAVED_CHAT_BINDING_STALE",
  "SAVED_CHAT_BINDING_UNQUALIFIED",
  "SAVED_CHAT_SELECTION_UNSUPPORTED",
  "SAVED_CHAT_SELECTION_AMBIGUOUS",
  "SAVED_CHAT_SELECTION_MISMATCH",
  "SAVED_CHAT_TURN_UNSETTLED",
  "SAVED_CHAT_DRAFT_PRESENT",
  "SAVED_CHAT_DRAFT_CHANGED",
  "SAVED_CHAT_SEND_UNAVAILABLE",
  "SAVED_CHAT_OPERATION_UNSETTLED",
  "SAVED_CHAT_SEND_UNKNOWN",
  "SAVED_CHAT_CORRELATION_UNAVAILABLE",
  "SAVED_CHAT_CORRELATION_AMBIGUOUS",
  "SAVED_CHAT_SOURCE_UNSUPPORTED",
]);
export type SavedChatFollowUpCode = z.infer<typeof SavedChatFollowUpCodeSchema>;
const savedSelectionSchema = SavedChatFollowUpRequestSchema.shape.selection;
export const SavedChatFollowUpResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("prepared"),
    evidenceId: savedId,
    selection: savedSelectionSchema,
  }),
  z.strictObject({
    state: z.literal("submitted"),
    evidenceId: savedId,
    selection: savedSelectionSchema,
  }),
  z.strictObject({
    state: z.literal("observed"),
    userId: savedId,
    assistantId: savedId.nullable(),
    frame: PublicTurnFrameSchema,
  }),
  z.strictObject({
    state: z.literal("not-sent"),
    code: SavedChatFollowUpCodeSchema,
  }),
  z.strictObject({
    state: z.literal("awaiting-owner"),
    code: SavedChatFollowUpCodeSchema,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    code: SavedChatFollowUpCodeSchema,
  }),
]);
export type SavedChatFollowUpResult = Readonly<
  z.infer<typeof SavedChatFollowUpResultSchema>
>;

/** Serialized browser mechanics. Only public DOM anchors/controls are inspected. */
async function savedChatFollowUpPage(
  input: SavedChatFollowUpRequest,
  action: "prepare" | "submit" | "observe",
  readMessages: typeof readPublicAssistantMessages,
  markdown: typeof publicMarkdownBlock,
  contentVisible: typeof publicContentVisible,
): Promise<SavedChatFollowUpResult> {
  type Pending = {
    operationId: string;
    digest: string;
    previousUserId: string;
    previousAssistantId: string;
    selection: string;
    draftText: string | null;
    evidenceId: string;
    binding: string;
    baseline: string[];
    composer: HTMLElement;
    clicked: boolean;
  };
  const key = Symbol.for("farol-next.saved-chat-follow-up.v1");
  const pending = Reflect.get(globalThis, key) as Pending | undefined;
  const binding = JSON.stringify(input.binding);
  const refuse = (
    code: z.infer<typeof SavedChatFollowUpCodeSchema>,
  ): SavedChatFollowUpResult => ({
    state: action === "observe" ? "awaiting-owner" : "not-sent",
    code,
  });
  const visible = (element: Element) => contentVisible(element);
  const controls = (selector: string, root: ParentNode = document) =>
    [...root.querySelectorAll(selector)].filter(visible);
  const href = new URL(location.href);
  const normal = () =>
    location.href === input.binding.conversationUrl &&
    (href.pathname === `/c/${input.binding.conversationId}` ||
      href.pathname === `/chatgpt/c/${input.binding.conversationId}`) &&
    !new URL(location.href).search &&
    !new URL(location.href).hash &&
    controls(
      'button[aria-label="Turn off temporary chat"],[data-testid="login-button"],a[href*="/auth/login"],button[name="login"]',
    ).length === 0;
  if (!normal()) return refuse("SAVED_CHAT_BINDING_STALE");
  const sha256 = async (value: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(value.replace(/\r\n?/gu, "\n")),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const messageSelector =
    '[data-message-author-role="user"],[data-message-author-role="assistant"]';
  const id = (element: Element) =>
    element.closest("[data-message-id]")?.getAttribute("data-message-id") ??
    null;
  const messages = () => controls(messageSelector);
  const uniqueMessages = (elements: Element[]) => {
    const ids = elements.map(id);
    return (
      elements.length <= 512 &&
      ids.every(
        (value) => value !== null && value.length > 0 && value.length <= 256,
      ) &&
      new Set(ids).size === ids.length
    );
  };
  const busy = () =>
    controls(
      '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]',
    ).length > 0;
  const readFrame = (userId: string, assistants: Element[]) => {
    const frameMessages = readMessages(
      assistants,
      contentVisible,
      markdown,
      visible,
    );
    return {
      userId,
      messages: frameMessages,
      terminal:
        frameMessages.length > 0 &&
        frameMessages.every((message) => message.complete) &&
        frameMessages.at(-1)?.channel === "answer" &&
        !busy(),
    };
  };

  if (action === "observe") {
    if (
      input.correlation !== null &&
      (input.correlation.userId === input.previous.userId ||
        input.correlation.assistantId === input.previous.assistantId)
    )
      return refuse("SAVED_CHAT_CORRELATION_UNAVAILABLE");
    const all = messages();
    if (!uniqueMessages(all)) return refuse("SAVED_CHAT_CORRELATION_AMBIGUOUS");
    let users = all.filter(
      (element) => element.getAttribute("data-message-author-role") === "user",
    );
    if (input.correlation !== null)
      users = users.filter(
        (element) => id(element) === input.correlation!.userId,
      );
    else {
      if (
        !pending ||
        pending.binding !== binding ||
        pending.operationId !== input.operation.id ||
        !pending.clicked ||
        pending.digest !== input.digest ||
        pending.previousUserId !== input.previous.userId
      )
        return refuse("SAVED_CHAT_CORRELATION_UNAVAILABLE");
      const fresh = users.filter(
        (element) => !pending.baseline.includes(id(element)!),
      );
      users = [];
      for (const element of fresh) {
        const rendered = (element as HTMLElement).innerText;
        const label = input.selection.connector.label;
        const unprefixed =
          rendered.startsWith(label) &&
          /^\s/u.test(rendered.slice(label.length))
            ? rendered.slice(label.length).trimStart()
            : null;
        if (
          (await sha256(rendered)) === input.digest ||
          (unprefixed !== null && (await sha256(unprefixed)) === input.digest)
        )
          users.push(element);
      }
    }
    if (users.length !== 1)
      return refuse(
        users.length > 1
          ? "SAVED_CHAT_CORRELATION_AMBIGUOUS"
          : "SAVED_CHAT_CORRELATION_UNAVAILABLE",
      );
    const user = users[0]!;
    const assistants: Element[] = [];
    for (const element of all.slice(all.indexOf(user) + 1)) {
      if (element.getAttribute("data-message-author-role") === "user") break;
      assistants.push(element);
    }
    const userId = id(user)!;
    if (
      userId === input.previous.userId ||
      assistants.some((element) => id(element) === input.previous.assistantId)
    )
      return refuse("SAVED_CHAT_CORRELATION_UNAVAILABLE");
    const assistantId =
      input.correlation?.assistantId ??
      (assistants[0] ? id(assistants[0]) : null);
    try {
      const frame = readFrame(userId, assistants);
      const parents = new Set([
        userId,
        ...(input.correlation?.assistantId
          ? [input.correlation.assistantId]
          : []),
      ]);
      for (const message of frame.messages) {
        if (message.parentId !== null && !parents.has(message.parentId!))
          return refuse("SAVED_CHAT_CORRELATION_UNAVAILABLE");
        parents.add(message.id);
      }
      return { state: "observed", userId, assistantId, frame };
    } catch {
      return refuse("SAVED_CHAT_SOURCE_UNSUPPORTED");
    }
  }

  if (input.operation.state !== "not-sent")
    return refuse("SAVED_CHAT_OPERATION_UNSETTLED");
  // Only preparation hashes asynchronously. Submit validates exact draft bytes
  // against that receipt and captures all current controls immediately before click.
  if (action === "prepare" && (await sha256(input.message)) !== input.digest)
    return refuse("SAVED_CHAT_INVALID");
  if (!normal()) return refuse("SAVED_CHAT_BINDING_STALE");
  const inputs = controls(
    '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]',
  );
  if (inputs.length !== 1 || !(inputs[0] instanceof HTMLElement))
    return refuse("SAVED_CHAT_SELECTION_UNSUPPORTED");
  const composer = inputs[0];
  const form = composer.closest("form");
  if (!form) return refuse("SAVED_CHAT_SELECTION_UNSUPPORTED");
  const selection = () => {
    const models = controls('button[aria-label="Select ChatGPT model"]');
    // Narrow candidate selector profile; missing/combined controls are unsupported.
    const efforts = controls(
      'button[aria-haspopup="menu"][data-tone="neutral"]',
      form,
    );
    const chips = controls(
      '[data-testid="composer-app-chip"],[data-testid*="app-mention"],[data-testid*="connector-chip"],[data-prompt-link-href^="app://asdk_app_"]',
      form,
    ).filter(
      (element, _index, all) =>
        !all.some((parent) => parent !== element && parent.contains(element)),
    );
    if (models.length > 1 || efforts.length > 1 || chips.length > 1)
      return "SAVED_CHAT_SELECTION_AMBIGUOUS" as const;
    if (models.length !== 1 || efforts.length !== 1 || chips.length !== 1)
      return "SAVED_CHAT_SELECTION_UNSUPPORTED" as const;
    const chip = chips[0]!;
    const connectorId =
      chip.getAttribute("data-plugin-id") ??
      chip.getAttribute("data-app-id") ??
      (chip
        .getAttribute("data-prompt-link-href")
        ?.match(/^app:\/\/(asdk_app_[A-Za-z0-9]+)$/u)?.[1]
        ? `plugin_${chip.getAttribute("data-prompt-link-href")!.slice(6)}`
        : null);
    const label = chip.getAttribute("data-app-name");
    const model = (models[0] as HTMLElement).innerText.trim();
    const effort = (efforts[0] as HTMLElement).innerText.trim();
    if (!model || !effort || !connectorId || !label)
      return "SAVED_CHAT_SELECTION_UNSUPPORTED" as const;
    if (
      model !== input.selection.model ||
      effort !== input.selection.effort ||
      connectorId !== input.selection.connector.id ||
      label !== input.selection.connector.label
    )
      return "SAVED_CHAT_SELECTION_MISMATCH" as const;
    return { model, effort, connector: { id: connectorId, label } };
  };
  const current = selection();
  if (typeof current === "string") return refuse(current);
  if (location.href !== input.binding.conversationUrl || busy())
    return refuse("SAVED_CHAT_TURN_UNSETTLED");
  const all = messages();
  const lastUser = all
    .filter(
      (element) => element.getAttribute("data-message-author-role") === "user",
    )
    .at(-1);
  if (
    !uniqueMessages(all) ||
    !lastUser ||
    id(lastUser) !== input.previous.userId
  )
    return refuse("SAVED_CHAT_TURN_UNSETTLED");
  try {
    const frame = readFrame(
      input.previous.userId,
      all.slice(all.indexOf(lastUser) + 1),
    );
    if (!frame.terminal || frame.messages[0]?.id !== input.previous.assistantId)
      return refuse("SAVED_CHAT_TURN_UNSETTLED");
    const parents = new Set([input.previous.userId]);
    for (const message of frame.messages) {
      if (message.parentId !== null && !parents.has(message.parentId!))
        return refuse("SAVED_CHAT_TURN_UNSETTLED");
      parents.add(message.id);
    }
  } catch {
    return refuse("SAVED_CHAT_SOURCE_UNSUPPORTED");
  }
  if (
    pending?.clicked &&
    (pending.operationId === input.operation.id ||
      pending.previousUserId === input.previous.userId)
  )
    return refuse("SAVED_CHAT_OPERATION_UNSETTLED");
  const draft = () => {
    if (composer instanceof HTMLTextAreaElement) return composer.value;
    const clone = composer.cloneNode(true) as HTMLElement;
    for (const marker of clone.querySelectorAll(
      '[data-testid="composer-app-chip"],[data-prompt-link-href^="app://asdk_app_"],a[href*="/plugins/plugin_asdk_app_"]',
    ))
      marker.remove();
    return clone.innerText || clone.textContent || "";
  };
  if (action === "prepare") {
    if (draft() !== "") return refuse("SAVED_CHAT_DRAFT_PRESENT");
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!setter) return refuse("SAVED_CHAT_SELECTION_UNSUPPORTED");
      setter.call(composer, input.message);
    } else {
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      const caret = window.getSelection();
      if (!caret) return refuse("SAVED_CHAT_SELECTION_UNSUPPORTED");
      caret.removeAllRanges();
      caret.addRange(range);
      if (!document.execCommand("insertText", false, input.message))
        return refuse("SAVED_CHAT_SELECTION_UNSUPPORTED");
    }
    composer.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: input.message,
        inputType: "insertText",
      }),
    );
    if (!normal()) return refuse("SAVED_CHAT_BINDING_STALE");
    const preparedSelection = selection();
    if (typeof preparedSelection === "string") return refuse(preparedSelection);
    if (draft() !== input.message) return refuse("SAVED_CHAT_DRAFT_CHANGED");
    const evidenceId = crypto.randomUUID();
    Reflect.set(globalThis, key, {
      evidenceId,
      operationId: input.operation.id,
      digest: input.digest,
      previousUserId: input.previous.userId,
      previousAssistantId: input.previous.assistantId,
      selection: JSON.stringify(input.selection),
      draftText: input.message,
      binding,
      baseline: all.map((element) => id(element)!),
      composer,
      clicked: false,
    } satisfies Pending);
    return { state: "prepared", evidenceId, selection: preparedSelection };
  }
  if (
    !pending ||
    pending.clicked ||
    pending.operationId !== input.operation.id ||
    pending.binding !== binding ||
    pending.evidenceId !== input.evidenceId ||
    pending.digest !== input.digest ||
    pending.draftText !== input.message ||
    pending.previousUserId !== input.previous.userId ||
    pending.previousAssistantId !== input.previous.assistantId ||
    pending.selection !== JSON.stringify(input.selection) ||
    pending.composer !== composer ||
    draft() !== input.message
  )
    return refuse("SAVED_CHAT_DRAFT_CHANGED");
  const send = controls(
    '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"]',
    form,
  );
  if (
    send.length !== 1 ||
    !(send[0] instanceof HTMLButtonElement) ||
    send[0].disabled
  )
    return refuse("SAVED_CHAT_SEND_UNAVAILABLE");
  const finalSelection = selection();
  if (typeof finalSelection === "string") return refuse(finalSelection);
  // A document-local click fuse, not a journal: latch before invoking the DOM
  // action, even when its acknowledgement throws. Go owns settlement/recovery.
  if (!normal() || busy()) return refuse("SAVED_CHAT_TURN_UNSETTLED");
  pending.clicked = true;
  pending.draftText = null;
  try {
    send[0].click();
  } catch {
    return { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" };
  }
  return {
    state: "submitted",
    evidenceId: pending.evidenceId,
    selection: finalSelection,
  };
}

export function savedChatFollowUpScript(
  candidate: unknown,
  action: "prepare" | "submit" | "observe",
): string {
  const parsed = SavedChatFollowUpRequestSchema.safeParse(candidate);
  if (
    !parsed.success ||
    !SavedChatFollowUpActionSchema.safeParse(action).success
  )
    return '({ state: "not-sent", code: "SAVED_CHAT_INVALID" })';
  return `(${savedChatFollowUpPage.toString()})(${JSON.stringify(parsed.data)},${JSON.stringify(action)},${readPublicAssistantMessages.toString()},${publicMarkdownBlock.toString()},${publicContentVisible.toString()})`;
}
