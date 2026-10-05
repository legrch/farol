import { z } from "zod";
import {
  readChatGptAccount,
  ChatGptAccountObservationSchema,
  type ChatGptAccountObservation,
} from "../../../apps/desktop/chatgpt-account-probe";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
  PhysicalCorrelation,
  PhysicalFailure,
  PhysicalFrame,
  PhysicalPrevious,
  PhysicalSelection,
  PhysicalObservedSelection,
} from "../../../apps/desktop/chatgpt-physical-api";
import {
  readPublicAssistantMessages,
  publicContentVisible,
} from "./chatgpt-public-turn";
import { publicMarkdownBlock } from "./chatgpt-public-markdown";

export type PhysicalPageRequiredControls =
  PhysicalSelection["requiredControls"];
export type PhysicalPageSelection = PhysicalSelection;
export type PhysicalPageObservedSelection = PhysicalObservedSelection;
export type PhysicalPagePolicy = Readonly<{
  e2eOrigin: string | null;
  accountObservationProfile?: "provider-session-v1";
  // Selected by the host route, never inferred from provider markup.
  contentProfile?: PhysicalPageContentProfile;
}>;
const productionPolicy: PhysicalPagePolicy = { e2eOrigin: null };

type VerifyInput = Parameters<ChatGptPhysicalApi["verifySend"]>[0];
export type PhysicalPageSendInput = Parameters<ChatGptPhysicalApi["send"]>[0];
type SendInput = PhysicalPageSendInput;

/** PRIVATE page DTOs. The host retains these; never persist prompt or page state. */
export type PhysicalPageVerifyResponse =
  | PhysicalFailure
  | Readonly<{
      state: "witnessed";
      binding: PhysicalBinding;
      operationId: string;
      evidenceId: string;
      intentDigest: string;
      previous: PhysicalPrevious;
      observed: PhysicalPageObservedSelection;
      sourceProfile: "message-anchors-v1";
      baselineUserIds: readonly string[];
      account?: ChatGptAccountObservation | undefined;
    }>;
export type PhysicalPageSubmission = Readonly<{
  originBinding: PhysicalBinding;
  operationId: string;
  evidenceId: string;
  intentDigest: string;
  promptDigest: string;
  baselineUserIds: readonly string[];
  previous: PhysicalPrevious;
  selection: PhysicalPageSelection;
}>;
export type PhysicalPageSendResponse = Awaited<
  ReturnType<ChatGptPhysicalApi["send"]>
>;
export type PhysicalPageObservation = Readonly<{
  binding: PhysicalBinding; // Actual host-guarded current view/document.
  operationId: string;
  deadlineMillis: number;
  submission: PhysicalPageSubmission;
  correlation: PhysicalCorrelation;
}>;
export type PhysicalPageContentProfile =
  "message-anchors-v1" | "farol-controlled-settled-segments-v1";
export type PhysicalPageObserveResponse =
  | PhysicalFailure
  | Readonly<{
      state: "observed";
      originBinding: PhysicalBinding;
      binding: PhysicalBinding;
      correlation: PhysicalCorrelation;
      frame: PhysicalFrame | null;
      observed: PhysicalPageObservedSelection;
      sourceProfile: "message-anchors-v1";
    }>;
export type PhysicalPageCancelResponse = Awaited<
  ReturnType<ChatGptPhysicalApi["cancel"]>
>;
export type PhysicalPagePrepareResponse =
  | PhysicalFailure
  | Readonly<{
      readiness:
        "ready" | "sign-in-required" | "awaiting-owner" | "unavailable";
    }>;

// Validate the serialization boundary before putting anything in page code.
const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const viewSchema = {
  viewId: idSchema,
  viewGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  documentGeneration: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  partition: z.enum([
    "persist:farol-next-chatgpt",
    "persist:farol-dev-chatgpt",
  ]),
};
const bindingSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...viewSchema,
    phase: z.literal("home"),
    url: z.string().url().max(2048),
    conversationId: z.null(),
  }),
  z.strictObject({
    ...viewSchema,
    phase: z.literal("conversation"),
    url: z.string().url().max(2048),
    conversationId: idSchema,
  }),
]);
const policySchema = z.strictObject({
  contentProfile: z
    .enum(["message-anchors-v1", "farol-controlled-settled-segments-v1"])
    .optional(),
  accountObservationProfile: z.literal("provider-session-v1").optional(),
  e2eOrigin: z
    .string()
    .max(2048)
    .nullable()
    .refine((value) => {
      if (value === null) return true;
      try {
        const origin = new URL(value);
        return (
          origin.origin === value &&
          origin.protocol === "http:" &&
          (origin.hostname === "127.0.0.1" ||
            origin.hostname === "localhost") &&
          !origin.username &&
          !origin.password &&
          !origin.search &&
          !origin.hash
        );
      } catch {
        return false;
      }
    }),
});

const previousSchema = z
  .strictObject({ userTurnId: idSchema, replyId: idSchema })
  .nullable();
const controlsSchema = z.strictObject({
  modelLabel: idSchema,
  effortLabel: idSchema.nullable(),
  modeLabel: idSchema.nullable(),
  connector: z.strictObject({ id: idSchema, label: idSchema }).nullable(),
});
const requiredControlsSchema = z.strictObject({
  model: z.literal(true),
  effort: z.boolean(),
  mode: z.boolean(),
  connector: z.boolean(),
});
const stringFact = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    source: z.literal("public-dom"),
    value: idSchema,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    code: z.enum(["not-exposed", "unqualified"]),
  }),
]);
const observedSchema = z.strictObject({
  modelLabel: stringFact,
  effortLabel: stringFact,
  modeLabel: stringFact,
  connectorLabel: stringFact,
});
const operationSchema = { binding: bindingSchema, operationId: idSchema };
const verifyFields = {
  ...operationSchema,
  accountDeadlineMillis: z.number().int().positive().safe().optional(),
  previous: previousSchema,
  intentDigest: idSchema,
  controls: controlsSchema,
  requiredControls: requiredControlsSchema,
};
const verifySchema = z.strictObject(verifyFields);
const witnessSchema = z.strictObject({
  ...verifyFields,
  account: ChatGptAccountObservationSchema.optional(),
  evidenceId: z.string().uuid(),
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
});
const sendSchema = z.strictObject({
  ...operationSchema,
  accountDeadlineMillis: z.number().int().positive().safe().optional(),
  witness: witnessSchema,
  intentDigest: idSchema,
  prompt: z
    .string()
    .min(1)
    .max(64 * 1024),
});
const submissionSchema = z.strictObject({
  originBinding: bindingSchema,
  operationId: idSchema,
  evidenceId: z.string().uuid(),
  intentDigest: idSchema,
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  baselineUserIds: z.array(idSchema).max(512),
  previous: previousSchema,
  controls: controlsSchema,
  requiredControls: requiredControlsSchema,
});
const observationSchema = z.strictObject({
  ...operationSchema,
  submission: submissionSchema,
  correlation: z.strictObject({
    userTurnId: idSchema.nullable(),
    replyId: idSchema.nullable(),
  }),
});

// The page receives only public controls and mechanics. Declaration provenance,
// config, account and grant pins never cross this serialization boundary.
// An explicit account observation profile also supplies a mechanical deadline.
type PageVerify = Pick<
  VerifyInput,
  "binding" | "operationId" | "previous" | "intentDigest"
> & {
  controls: PhysicalPageSelection["controls"];
  requiredControls: PhysicalPageRequiredControls;
  accountDeadlineMillis?: number | undefined;
};
type PageWitness = PageVerify & {
  account?: ChatGptAccountObservation | undefined;
  evidenceId: string;
  observed: PhysicalPageObservedSelection;
  sourceProfile: "message-anchors-v1";
};
type PageSend = Pick<
  SendInput,
  "binding" | "operationId" | "intentDigest" | "prompt"
> & { witness: PageWitness; accountDeadlineMillis?: number | undefined };
type PageSubmission = Omit<PhysicalPageSubmission, "selection"> & {
  controls: PhysicalPageSelection["controls"];
  requiredControls: PhysicalPageRequiredControls;
};
type PageObservation = Omit<
  PhysicalPageObservation,
  "deadlineMillis" | "submission"
> & { submission: PageSubmission };
type Request =
  | { action: "prepare"; binding: PhysicalBinding }
  | { action: "verify"; input: PageVerify }
  | { action: "send"; input: PageSend }
  | {
      action: "observe" | "cancel";
      input: PageObservation;
      contentProfile: PhysicalPageContentProfile;
    };
type Response =
  | PhysicalPagePrepareResponse
  | PhysicalPageVerifyResponse
  | PhysicalPageSendResponse
  | PhysicalPageObserveResponse
  | PhysicalPageCancelResponse;

/** Self-contained serialization: no module closures or hidden provider state. */
async function physicalPage(
  request: Request,
  readMessages: typeof readPublicAssistantMessages,
  markdown: typeof publicMarkdownBlock,
  contentVisible: typeof publicContentVisible,
  e2eOrigin: string | null,
  accountProfile: "provider-session-v1" | null,
  readAccount: typeof readChatGptAccount | null,
  contentProfile: PhysicalPageContentProfile,
): Promise<Response> {
  type WitnessRecord = {
    witness: PageWitness;
    contentProfile: PhysicalPageContentProfile;
    baselineUserIds: string[];
    ids: string[];
    composerToken: string;
    controlFingerprint: string;
    spent: boolean;
  };
  type OperationRecord = {
    submission: PageSubmission;
    correlation: PhysicalCorrelation | null;
    binding: PhysicalBinding;
    cancelled: boolean;
  };
  type Store = {
    witnesses: Map<string, WitnessRecord>;
    operations: Map<string, OperationRecord>;
    spentOperations: Set<string>;
    composers: WeakMap<HTMLElement, string>;
  };
  const key = Symbol.for("farol-next.physical-page.v1");
  const getStore = (): Store => {
    let store = Reflect.get(globalThis, key) as Store | undefined;
    if (!store) {
      store = {
        witnesses: new Map(),
        operations: new Map(),
        spentOperations: new Set(),
        composers: new WeakMap(),
      };
      Reflect.set(globalThis, key, store);
    }
    return store;
  };
  const fail = (
    code: string,
    state: PhysicalFailure["state"] = "refused",
  ): PhysicalFailure => ({ state, code });
  const abort = (code: string): never => {
    throw new Error(code);
  };
  const stable = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        return item;
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    });
  const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
  const controls = (selector: string, root: ParentNode = document) =>
    [...root.querySelectorAll(selector)].filter(contentVisible);
  const blocked = () =>
    controls(
      'button[aria-label="Turn off temporary chat"],[data-testid="login-button"],a[href*="/auth/login"],button[name="login"]',
    ).length > 0;
  const canonical = (binding: PhysicalBinding) => {
    try {
      const expected = new URL(binding.url);
      const actual = new URL(location.href);
      // Only a separately supplied host policy grants the dev fixture origin.
      const basePath = e2eOrigin === null ? "" : "/chatgpt";
      return (
        expected.origin === (e2eOrigin ?? "https://chatgpt.com") &&
        (e2eOrigin === null ||
          binding.partition === "persist:farol-dev-chatgpt") &&
        actual.href === expected.href &&
        !expected.search &&
        !expected.hash &&
        !expected.username &&
        !expected.password &&
        (binding.phase === "home"
          ? expected.pathname === (basePath || "/")
          : /^[a-zA-Z0-9-]+$/u.test(binding.conversationId) &&
            expected.pathname === `${basePath}/c/${binding.conversationId}`)
      );
    } catch {
      return false;
    }
  };
  const currentComposer = () => {
    const inputs = controls(
      '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]',
    );
    if (inputs.length !== 1 || !(inputs[0] instanceof HTMLElement))
      return abort("PHYSICAL_COMPOSER_UNAVAILABLE");
    const composer = inputs[0];
    if (
      composer.getAttribute("aria-disabled") === "true" ||
      (composer instanceof HTMLTextAreaElement &&
        (composer.disabled || composer.readOnly)) ||
      (!(composer instanceof HTMLTextAreaElement) &&
        composer.getAttribute("contenteditable") !== "true")
    )
      return abort("PHYSICAL_COMPOSER_UNAVAILABLE");
    const form = composer.closest("form");
    if (!form) return abort("PHYSICAL_COMPOSER_UNAVAILABLE");
    return { composer, form };
  };
  const chipSelector =
    '[data-testid="composer-app-chip"],[data-testid*="app-mention"],[data-testid*="connector-chip"],[data-prompt-link-href^="app://asdk_app_"],a[href*="/plugins/plugin_asdk_app_"]';
  const chips = (root: ParentNode) =>
    controls(chipSelector, root).filter(
      (element, _index, all) =>
        !all.some((parent) => parent !== element && parent.contains(element)),
    );
  const draft = (composer: HTMLElement) => {
    if (composer instanceof HTMLTextAreaElement) return composer.value;
    const clone = composer.cloneNode(true) as HTMLElement;
    for (const chip of clone.querySelectorAll(chipSelector)) chip.remove();
    return clone.innerText || clone.textContent || "";
  };
  const fact = (value: string | null) =>
    value === null
      ? { state: "unknown" as const, code: "not-exposed" as const }
      : !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)
        ? { state: "unknown" as const, code: "unqualified" as const }
        : { state: "observed" as const, source: "public-dom" as const, value };
  const selection = (
    expectedControls: PhysicalPageSelection["controls"],
    required: PhysicalPageRequiredControls,
    enforce = true,
  ) => {
    // Observation reads controls even if the composer is disabled or unavailable
    // after Send. Readiness and immutable-selection admission are pre-send checks.
    const inputs = enforce
      ? []
      : controls(
          '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]',
        );
    const form = enforce
      ? currentComposer().form
      : inputs.length === 1
        ? inputs[0]!.closest("form")
        : null;
    const scoped = (selector: string) => (form ? controls(selector, form) : []);
    const models = controls('button[aria-label="Select ChatGPT model"]');
    const efforts = scoped('button[aria-haspopup="menu"][data-tone="neutral"]');
    const modes = scoped(
      'button[data-testid="composer-mode-button"],[data-testid="composer-mode-chip"],button[aria-label="Select mode"],button[aria-label="Search"][aria-pressed="true"],button[aria-label="Deep research"][aria-pressed="true"],button[aria-label="Agent mode"][aria-pressed="true"]',
    );
    const connectors = form ? chips(form) : [];
    if (
      enforce &&
      (models.length > 1 ||
        efforts.length > 1 ||
        modes.length > 1 ||
        connectors.length > 1)
    )
      return abort("PHYSICAL_SELECTION_AMBIGUOUS");
    const label = (node: Element | undefined) => {
      const text = node instanceof HTMLElement ? node.innerText.trim() : "";
      return text && text.length <= 256 ? text : null;
    };
    const modelLabel = models.length === 1 ? label(models[0]) : null;
    const effortLabel = efforts.length === 1 ? label(efforts[0]) : null;
    const modeLabel =
      modes.length === 1
        ? (label(modes[0]) ??
          (modes[0]?.getAttribute("aria-pressed") === "true"
            ? modes[0].getAttribute("aria-label")
            : null))
        : null;
    const chip = connectors.length === 1 ? connectors[0] : undefined;
    const link =
      chip?.getAttribute("data-prompt-link-href") ?? chip?.getAttribute("href");
    const app = link?.match(/^app:\/\/(asdk_app_[A-Za-z0-9]+)$/u)?.[1];
    const plugin = link?.match(
      /^https:\/\/chatgpt\.com\/g\/[^/?#]+\/plugins\/(plugin_asdk_app_[A-Za-z0-9]+)$/u,
    )?.[1];
    const connectorId =
      chip?.getAttribute("data-plugin-id") ??
      chip?.getAttribute("data-app-id") ??
      (app ? `plugin_${app}` : (plugin ?? null));
    const connectorLabel =
      chip?.getAttribute("data-app-name") ??
      (app || plugin ? label(chip) : null);
    if (
      enforce &&
      (!modelLabel ||
        (required.effort && (!expectedControls.effortLabel || !effortLabel)) ||
        (required.mode && (!expectedControls.modeLabel || !modeLabel)) ||
        (required.connector &&
          (!expectedControls.connector || !connectorId || !connectorLabel)))
    )
      return abort("PHYSICAL_SELECTION_UNEXPOSED");
    if (
      enforce &&
      (modelLabel !== expectedControls.modelLabel ||
        (effortLabel !== null &&
          effortLabel !== expectedControls.effortLabel) ||
        (modeLabel !== null && modeLabel !== expectedControls.modeLabel) ||
        (connectorLabel !== null &&
          (!expectedControls.connector ||
            connectorId !== expectedControls.connector.id ||
            connectorLabel !== expectedControls.connector.label)))
    )
      return abort("PHYSICAL_SELECTION_MISMATCH");
    const fieldFact = (
      elements: Element[],
      value: string | null,
      scopedField = false,
    ) =>
      elements.length > 1 ||
      (elements.length === 1 && value === null) ||
      (scopedField && inputs.length > 1)
        ? { state: "unknown" as const, code: "unqualified" as const }
        : fact(value);
    const observed: PhysicalPageObservedSelection = {
      modelLabel: fieldFact(models, modelLabel),
      effortLabel: fieldFact(efforts, effortLabel, true),
      modeLabel: fieldFact(modes, modeLabel, true),
      connectorLabel: fieldFact(connectors, connectorLabel, true),
    };
    return {
      observed,
      controlFingerprint: stable({
        modelLabel,
        effortLabel,
        modeLabel,
        connectorId,
        connectorLabel,
      }),
    };
  };
  const role = (element: Element) =>
    element.getAttribute("data-message-author-role");
  const anchor = (element: Element) => {
    const value = element
      .closest("[data-message-id]")
      ?.getAttribute("data-message-id");
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))
      return abort("PHYSICAL_ANCHOR_UNQUALIFIED");
    return value;
  };
  const messages = () => {
    // Hidden role anchors also prevent proving a blank Home/history.
    const all = [
      ...document.querySelectorAll(
        '[data-message-author-role="user"],[data-message-author-role="assistant"]',
      ),
    ];
    if (all.length > 512 || all.some((node) => !contentVisible(node)))
      return abort("PHYSICAL_HISTORY_UNQUALIFIED");
    const ids = all.map(anchor);
    if (
      new Set(ids).size !== ids.length ||
      all.some((node) =>
        all.some((parent) => parent !== node && parent.contains(node)),
      )
    )
      return abort("PHYSICAL_ANCHOR_AMBIGUOUS");
    return all;
  };
  const readFrame = (
    userId: string,
    assistants: Element[],
    profile: PhysicalPageContentProfile,
  ): PhysicalFrame => {
    if (assistants.some((element) => role(element) !== "assistant"))
      return abort("PHYSICAL_TURN_UNQUALIFIED");
    // Unknown declared content profiles are never silently treated as ordinary prose.
    for (const element of assistants) {
      for (const root of element.querySelectorAll(".markdown")) {
        const declared = root.getAttribute("data-farol-source-profile");
        if (
          declared !== null &&
          (profile !== "farol-controlled-settled-segments-v1" ||
            declared !== profile)
        )
          return abort("PHYSICAL_CONTENT_UNQUALIFIED");
      }
    }
    const frameMessages = readMessages(
      assistants,
      contentVisible,
      markdown,
      contentVisible,
      profile === "farol-controlled-settled-segments-v1",
    );
    const parents = new Set([userId]);
    for (const message of frameMessages) {
      if (
        message.parentId !== null &&
        message.parentId !== undefined &&
        !parents.has(message.parentId)
      )
        return abort("PHYSICAL_PARENT_MISMATCH");
      parents.add(message.id);
    }
    // No global Stop-as-terminal: every associated article must supply its own proof.
    return {
      userId,
      messages: frameMessages,
      terminal:
        frameMessages.length > 0 &&
        frameMessages.every((message) => message.complete) &&
        frameMessages.at(-1)?.channel === "answer",
    };
  };
  const previousReady = (
    binding: PhysicalBinding,
    previous: PhysicalPrevious,
  ) => {
    const all = messages();
    if (previous === null) {
      if (binding.phase !== "home" || all.length)
        return abort("PHYSICAL_PREVIOUS_MISMATCH");
    } else {
      if (binding.phase !== "conversation")
        return abort("PHYSICAL_PREVIOUS_MISMATCH");
      const user = all.filter((element) => role(element) === "user").at(-1);
      if (!user || anchor(user) !== previous.userTurnId)
        return abort("PHYSICAL_PREVIOUS_MISMATCH");
      const assistants = all.slice(all.indexOf(user) + 1);
      if (!assistants[0] || anchor(assistants[0]) !== previous.replyId)
        return abort("PHYSICAL_PREVIOUS_MISMATCH");
      if (!readFrame(previous.userTurnId, assistants, contentProfile).terminal)
        return abort("PHYSICAL_PREVIOUS_UNSETTLED");
    }
    return all;
  };
  const stopSelector =
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]';
  const sendSelector =
    '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"]';
  const sendControl = (form: Element) => {
    const sends = controls(sendSelector, form);
    if (
      sends.length !== 1 ||
      !(sends[0] instanceof HTMLButtonElement) ||
      sends[0].disabled ||
      sends[0].getAttribute("aria-disabled") === "true"
    )
      return abort("PHYSICAL_SEND_UNAVAILABLE");
    return sends[0];
  };
  const normalize = (text: string) => text.replace(/\r\n?/gu, "\n");
  const sha256 = async (value: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(normalize(value)),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const checkBinding = (binding: PhysicalBinding) => {
    if (!canonical(binding) || blocked())
      return abort("PHYSICAL_BINDING_STALE");
  };
  const checked = (input: PageVerify, expectedDraft: string) => {
    if (
      accountProfile !== null &&
      (!Number.isSafeInteger(input.accountDeadlineMillis) ||
        input.accountDeadlineMillis! <= Date.now())
    )
      return abort("PHYSICAL_ACCOUNT_DEADLINE");
    checkBinding(input.binding);
    const { composer, form } = currentComposer();
    if (normalize(draft(composer)) !== normalize(expectedDraft))
      return abort("PHYSICAL_DRAFT_CHANGED");
    if (controls(stopSelector, form).length)
      return abort("PHYSICAL_COMPOSER_BUSY");
    const { observed, controlFingerprint } = selection(
      input.controls,
      input.requiredControls,
    );
    const all = previousReady(input.binding, input.previous);
    return { composer, form, observed, controlFingerprint, all };
  };
  const accountCurrent = (
    value: ChatGptAccountObservation | undefined,
    binding: PhysicalBinding,
  ) => {
    const now = Date.now();
    if (
      !value ||
      value.state !== "observed" ||
      value.source !== "provider-session-v1" ||
      value.documentUrl !== binding.url ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(value.observedAtMillis) ||
      value.observedAtMillis > now ||
      now - value.observedAtMillis >= 5000 ||
      value.expiresAtMillis <= now ||
      !/^[a-f0-9]{64}$/u.test(value.accountKey)
    )
      return abort("PHYSICAL_ACCOUNT_UNAVAILABLE");
    return value;
  };
  const errorCode = (error: unknown) =>
    error instanceof Error && /^PHYSICAL_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "PHYSICAL_SOURCE_UNQUALIFIED";

  if (request.action === "prepare") {
    if (!canonical(request.binding)) return fail("PHYSICAL_BINDING_STALE");
    if (
      controls(
        '[data-testid="login-button"],a[href*="/auth/login"],button[name="login"]',
      ).length
    )
      return { readiness: "sign-in-required" };
    if (blocked()) return { readiness: "awaiting-owner" };
    try {
      const { composer, form } = currentComposer();
      return {
        readiness:
          draft(composer) === "" && !controls(stopSelector, form).length
            ? "ready"
            : "awaiting-owner",
      };
    } catch {
      return { readiness: "unavailable" };
    }
  }
  if (request.action === "verify") {
    const input = request.input;
    try {
      let current = checked(input, "");
      let account: ChatGptAccountObservation | undefined;
      if (accountProfile !== null) {
        if (!readAccount) return fail("PHYSICAL_ACCOUNT_UNAVAILABLE");
        account = accountCurrent(await readAccount(e2eOrigin), input.binding);
        current = checked(input, "");
      }
      const store = getStore();
      if (
        store.spentOperations.has(input.operationId) ||
        store.operations.has(input.operationId)
      )
        return fail("PHYSICAL_OPERATION_SPENT");
      if (store.witnesses.size >= 512) return fail("PHYSICAL_WITNESS_CAPACITY");
      const witness: PageWitness = {
        binding: input.binding,
        operationId: input.operationId,
        evidenceId: crypto.randomUUID(),
        intentDigest: input.intentDigest,
        previous: input.previous,
        controls: input.controls,
        requiredControls: input.requiredControls,
        ...(account
          ? { account, accountDeadlineMillis: input.accountDeadlineMillis! }
          : {}),
        observed: current.observed,
        sourceProfile: "message-anchors-v1",
      };
      const baselineUserIds = current.all
        .filter((element) => role(element) === "user")
        .map(anchor);
      let composerToken = store.composers.get(current.composer);
      if (!composerToken) {
        composerToken = crypto.randomUUID();
        store.composers.set(current.composer, composerToken);
      }
      store.witnesses.set(witness.evidenceId, {
        witness,
        contentProfile,
        baselineUserIds,
        ids: current.all.map(anchor),
        composerToken,
        controlFingerprint: current.controlFingerprint,
        spent: false,
      });
      return {
        state: "witnessed",
        binding: witness.binding,
        operationId: witness.operationId,
        evidenceId: witness.evidenceId,
        intentDigest: witness.intentDigest,
        previous: witness.previous,
        observed: witness.observed,
        sourceProfile: witness.sourceProfile,
        baselineUserIds,
        ...(account ? { account } : {}),
      };
    } catch (error) {
      return fail(errorCode(error));
    }
  }
  if (request.action === "send") {
    const input = request.input;
    const result = (
      state: "submitted" | "not-sent" | "unknown",
      code: string,
    ): PhysicalPageSendResponse => ({
      state,
      code,
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: input.witness.evidenceId,
    });
    const store = getStore();
    const record = store.witnesses.get(input.witness.evidenceId);
    if (
      !record ||
      record.contentProfile !== contentProfile ||
      record.spent ||
      store.spentOperations.has(input.operationId) ||
      store.operations.has(input.operationId) ||
      !equal(record.witness, input.witness) ||
      !equal(input.binding, input.witness.binding) ||
      input.operationId !== input.witness.operationId ||
      input.intentDigest !== input.witness.intentDigest ||
      (accountProfile !== null) !== (record.witness.account !== undefined)
    )
      return result("not-sent", "PHYSICAL_WITNESS_INVALID");
    // Consume before any async work or insertion. Concurrent dispatches cannot pass.
    record.spent = true;
    store.spentOperations.add(input.operationId);
    const verify: PageVerify = {
      binding: input.binding,
      operationId: input.operationId,
      previous: input.witness.previous,
      intentDigest: input.intentDigest,
      controls: input.witness.controls,
      requiredControls: input.witness.requiredControls,
      ...(accountProfile !== null
        ? {
            accountDeadlineMillis: Math.min(
              input.accountDeadlineMillis ?? 0,
              input.witness.accountDeadlineMillis ?? 0,
            ),
          }
        : {}),
    };
    let submission: PageSubmission | undefined;
    let clicked = false;
    try {
      const fresh = (expectedDraft: string) => {
        const current = checked(verify, expectedDraft);
        if (
          store.composers.get(current.composer) !== record.composerToken ||
          !equal(current.all.map(anchor), record.ids) ||
          !equal(current.observed, record.witness.observed) ||
          current.controlFingerprint !== record.controlFingerprint
        )
          return abort("PHYSICAL_WITNESS_STALE");
        return current;
      };
      fresh("");
      // Envelope intentDigest is opaque; only this separate digest correlates text.
      const promptDigest = await sha256(input.prompt);
      fresh("");
      let currentAccount: ChatGptAccountObservation | undefined;
      if (accountProfile !== null) {
        const original = accountCurrent(record.witness.account, input.binding);
        if (!readAccount) return abort("PHYSICAL_ACCOUNT_UNAVAILABLE");
        currentAccount = accountCurrent(
          await readAccount(e2eOrigin),
          input.binding,
        );
        if (currentAccount.accountKey !== original.accountKey)
          return abort("PHYSICAL_ACCOUNT_CHANGED");
      }
      const current = fresh(""); // Recheck after the final awaited account/hash work.
      if (currentAccount) accountCurrent(currentAccount, input.binding);
      submission = {
        originBinding: input.binding,
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        intentDigest: input.intentDigest,
        promptDigest,
        baselineUserIds: record.baselineUserIds,
        previous: input.witness.previous,
        controls: verify.controls,
        requiredControls: verify.requiredControls,
      };
      const { composer } = current;
      if (composer instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (!setter) return abort("PHYSICAL_INSERT_UNAVAILABLE");
        setter.call(composer, input.prompt);
      } else {
        // Append through the native editor path; never replace inline app chips.
        composer.focus();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const caret = window.getSelection();
        if (!caret) return abort("PHYSICAL_INSERT_UNAVAILABLE");
        caret.removeAllRanges();
        caret.addRange(range);
        if (!document.execCommand("insertText", false, input.prompt))
          return abort("PHYSICAL_INSERT_UNAVAILABLE");
      }
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: input.prompt,
          inputType: "insertText",
        }),
      );
      const final = fresh(input.prompt);
      const send = sendControl(final.form);
      // Final synchronous check immediately before the one effect.
      fresh(input.prompt);
      if (currentAccount) accountCurrent(currentAccount, input.binding);
      store.operations.set(input.operationId, {
        submission,
        correlation: null,
        binding: input.binding,
        cancelled: false,
      });
      clicked = true;
      send.click();
      return result("submitted", "PHYSICAL_SEND_ACKNOWLEDGED");
    } catch (error) {
      return result(
        clicked ? "unknown" : "not-sent",
        clicked ? "PHYSICAL_SEND_UNKNOWN" : errorCode(error),
      );
    }
  }

  const input = request.input;
  const submission = input.submission;
  const store = getStore();
  let operation = store.operations.get(input.operationId);
  if (
    input.operationId !== submission.operationId ||
    (operation && !equal(operation.submission, submission))
  )
    return fail("PHYSICAL_OPERATION_MISMATCH");
  const origin = submission.originBinding;
  const transition = () => {
    const binding = input.binding;
    checkBinding(binding);
    if (
      binding.viewId !== origin.viewId ||
      binding.viewGeneration !== origin.viewGeneration ||
      binding.partition !== origin.partition ||
      binding.documentGeneration !== origin.documentGeneration ||
      new URL(binding.url).origin !== new URL(origin.url).origin ||
      (origin.phase === "conversation" &&
        (binding.phase !== "conversation" ||
          binding.conversationId !== origin.conversationId)) ||
      (origin.phase === "home" && submission.previous !== null)
    )
      return abort("PHYSICAL_BINDING_STALE");
  };
  const userText = (element: Element) => {
    // Only an actual public app marker qualifies an app-label prefix removal.
    const clone = element.cloneNode(true) as HTMLElement;
    // Detached innerText falls back to textContent. Remove invisible/control nodes
    // using the corresponding live DOM, never read hidden descendants as prompt.
    let visited = 0;
    const prune = (live: Element, copy: Element, depth = 0) => {
      if (++visited > 8192 || depth > 64)
        return abort("PHYSICAL_USER_TEXT_UNQUALIFIED");
      const originals = [...live.children];
      const copies = [...copy.children];
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i]!;
        const child = copies[i]!;
        if (
          !contentVisible(original) ||
          ["SCRIPT", "STYLE", "BUTTON", "SVG", "TEMPLATE", "NOSCRIPT"].includes(
            original.tagName,
          )
        )
          child.remove();
        else {
          if (
            ["IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME"].includes(
              original.tagName,
            )
          )
            return abort("PHYSICAL_USER_TEXT_UNQUALIFIED");
          prune(original, child, depth + 1);
        }
      }
    };
    prune(element, clone);
    const exposedMarkers = chips(element);
    const markers = [...clone.querySelectorAll(chipSelector)].filter(
      (node, _index, all) =>
        !all.some((parent) => parent !== node && parent.contains(node)),
    );
    if (markers.length !== exposedMarkers.length)
      return abort("PHYSICAL_USER_TEXT_UNQUALIFIED");
    if (markers.length > 1) return abort("PHYSICAL_USER_TEXT_UNQUALIFIED");
    if (markers[0]) {
      const expected = submission.controls.connector;
      const marker = markers[0];
      const link =
        marker.getAttribute("data-prompt-link-href") ??
        marker.getAttribute("href");
      const app = link?.match(/^app:\/\/(asdk_app_[A-Za-z0-9]+)$/u)?.[1];
      const plugin = link?.match(
        /^https:\/\/chatgpt\.com\/g\/[^/?#]+\/plugins\/(plugin_asdk_app_[A-Za-z0-9]+)$/u,
      )?.[1];
      const markerId =
        marker.getAttribute("data-plugin-id") ??
        marker.getAttribute("data-app-id") ??
        (app ? `plugin_${app}` : (plugin ?? null));
      const literal = (exposedMarkers[0] as HTMLElement).innerText;
      const markerLabel =
        marker.getAttribute("data-app-name") ??
        (app || plugin ? literal.trim() : null);
      if (
        !expected ||
        markerId !== expected.id ||
        markerLabel !== expected.label ||
        !literal ||
        !(element as HTMLElement).innerText.startsWith(literal)
      )
        return abort("PHYSICAL_USER_TEXT_UNQUALIFIED");
      marker.remove();
      const text = clone.innerText || clone.textContent || "";
      // A public app-prefix delimiter may be rendered separately from prompt bytes.
      // Try only bounded exact variants; the digest still proves the original text.
      return [
        ...new Set([
          text,
          ...[" ", "\n", "\n\n"]
            .filter((delimiter) => text.startsWith(delimiter))
            .map((delimiter) => text.slice(delimiter.length)),
        ]),
      ];
    }
    return [clone.innerText || clone.textContent || ""];
  };
  try {
    transition();
    if (
      operation?.binding.phase === "conversation" &&
      (input.binding.phase !== "conversation" ||
        input.binding.conversationId !== operation.binding.conversationId)
    )
      return fail("PHYSICAL_BINDING_STALE");
    const retained =
      input.correlation.userTurnId !== null
        ? input.correlation
        : (operation?.correlation ?? null);
    if (
      input.correlation.userTurnId !== null &&
      operation?.correlation &&
      (input.correlation.userTurnId !== operation.correlation.userTurnId ||
        (operation.correlation.replyId !== null &&
          input.correlation.replyId !== operation.correlation.replyId))
    )
      return fail("PHYSICAL_CORRELATION_MISMATCH");
    let all = messages();
    const snapshot = all.map(anchor);
    const excluded = new Set([
      ...submission.baselineUserIds,
      ...(submission.previous
        ? [submission.previous.userTurnId, submission.previous.replyId]
        : []),
    ]);
    let userId = retained?.userTurnId ?? null;
    if (retained?.replyId && !userId)
      return fail("PHYSICAL_CORRELATION_MISMATCH");
    if (userId && excluded.has(userId))
      return fail("PHYSICAL_CORRELATION_MISMATCH");
    if (!userId) {
      const candidates: string[] = [];
      const texts = new Map<string, string[]>();
      for (const element of all.filter(
        (node) => role(node) === "user" && !excluded.has(anchor(node)),
      )) {
        const variants = userText(element);
        if (variants.some((text) => text.length > 64 * 1024))
          return fail("PHYSICAL_USER_TEXT_UNQUALIFIED");
        texts.set(anchor(element), variants);
        let matches = false;
        for (const text of variants) {
          const digest = await sha256(text);
          transition();
          const now = messages();
          if (
            !equal(now.map(anchor), snapshot) ||
            [...texts].some(
              ([id, observedText]) =>
                !equal(
                  userText(now.find((node) => anchor(node) === id)!),
                  observedText,
                ),
            )
          )
            return fail("PHYSICAL_CORRELATION_CHANGED");
          if (digest === submission.promptDigest) matches = true;
        }
        if (matches) candidates.push(anchor(element));
      }
      if (candidates.length > 1) return fail("PHYSICAL_CORRELATION_AMBIGUOUS");
      userId = candidates[0] ?? null;
    }
    transition();
    all = messages();
    if (!equal(all.map(anchor), snapshot))
      return fail("PHYSICAL_CORRELATION_CHANGED");
    let assistants: Element[] = [];
    let frame: PhysicalFrame | null = null;
    let replyId: string | null = null;
    if (userId !== null) {
      const user = all.find(
        (node) => role(node) === "user" && anchor(node) === userId,
      );
      if (!user) return fail("PHYSICAL_CORRELATION_UNAVAILABLE");
      const parent =
        user
          .closest("[data-parent-message-id]")
          ?.getAttribute("data-parent-message-id") ?? null;
      if (parent !== null && parent !== submission.previous?.replyId)
        return fail("PHYSICAL_PARENT_MISMATCH");
      const after = all.slice(all.indexOf(user) + 1);
      const nextUser = after.findIndex((node) => role(node) === "user");
      assistants = nextUser < 0 ? after : after.slice(0, nextUser);
      if (assistants.some((node) => excluded.has(anchor(node))))
        return fail("PHYSICAL_CORRELATION_MISMATCH");
      replyId = assistants[0] ? anchor(assistants[0]) : null;
      if (retained?.replyId && retained.replyId !== replyId)
        return fail("PHYSICAL_CORRELATION_MISMATCH");
      // First-send CID comes from the actual canonical URL after exact user correlation.
      frame = assistants.length
        ? readFrame(userId, assistants, request.contentProfile)
        : null;
    } else if (input.binding.phase !== origin.phase)
      return fail("PHYSICAL_CORRELATION_UNAVAILABLE");
    const correlation: PhysicalCorrelation = { userTurnId: userId, replyId };
    const { observed } = selection(
      submission.controls,
      submission.requiredControls,
      false,
    );
    if (!operation) {
      if (store.operations.size >= 512)
        return fail("PHYSICAL_OPERATION_CAPACITY");
      operation = {
        submission,
        correlation,
        binding: input.binding,
        cancelled: false,
      };
      store.operations.set(input.operationId, operation);
    } else {
      operation.correlation = correlation;
      operation.binding = input.binding;
    }
    if (request.action === "observe")
      return {
        state: "observed",
        originBinding: origin,
        binding: input.binding,
        correlation,
        observed,
        sourceProfile: "message-anchors-v1",
        frame,
      };

    const terminalProof = () =>
      userId !== null && replyId !== null && frame?.terminal
        ? {
            binding: input.binding,
            correlation: { userTurnId: userId, replyId },
            frame,
          }
        : null;
    const terminal = terminalProof();
    if (terminal) return { state: "already-terminal", proof: terminal };
    if (operation.cancelled) return fail("PHYSICAL_CANCEL_SPENT", "unknown");
    if (userId === null)
      return fail("PHYSICAL_CORRELATION_UNAVAILABLE", "unknown");
    // Stop belongs to the current composer only and the correlated latest turn.
    if (
      all.filter((node) => role(node) === "user").at(-1) &&
      anchor(all.filter((node) => role(node) === "user").at(-1)!) !== userId
    )
      return fail("PHYSICAL_CANCEL_TURN_STALE", "unknown");
    const { form } = currentComposer();
    const stops = controls(stopSelector, form);
    if (
      stops.length !== 1 ||
      !(stops[0] instanceof HTMLButtonElement) ||
      stops[0].disabled ||
      stops[0].getAttribute("aria-disabled") === "true"
    )
      return fail("PHYSICAL_STOP_UNAVAILABLE", "unknown");
    transition();
    operation.cancelled = true;
    try {
      stops[0].click();
    } catch {
      return fail("PHYSICAL_CANCEL_UNKNOWN", "unknown");
    }
    // Only immediate actual full correlated terminal proof confirms cancellation.
    transition();
    const now = messages();
    if (!equal(now.map(anchor), snapshot))
      return fail("PHYSICAL_CORRELATION_CHANGED", "unknown");
    const currentUser = now.find(
      (node) => role(node) === "user" && anchor(node) === userId,
    );
    if (!currentUser)
      return fail("PHYSICAL_CORRELATION_UNAVAILABLE", "unknown");
    const currentAfter = now.slice(now.indexOf(currentUser) + 1);
    if (currentAfter.some((node) => role(node) !== "assistant"))
      return fail("PHYSICAL_CANCEL_TURN_STALE", "unknown");
    frame = currentAfter.length
      ? readFrame(userId, currentAfter, request.contentProfile)
      : null;
    const proof = terminalProof();
    return proof
      ? { state: "confirmed-terminal", proof }
      : {
          state: "requested",
          binding: input.binding,
          code: "PHYSICAL_CANCEL_ACKNOWLEDGED",
        };
  } catch (error) {
    return fail(
      errorCode(error),
      request.action === "cancel" ? "unknown" : "refused",
    );
  }
}

function script(request: Request, policy: PhysicalPagePolicy): string {
  const parsed = policySchema.safeParse(policy);
  if (
    !parsed.success ||
    ("contentProfile" in request &&
      parsed.data.contentProfile !== undefined &&
      request.contentProfile !== parsed.data.contentProfile)
  ) {
    const failure = {
      state: request.action === "send" ? "not-sent" : "refused",
      code: "PHYSICAL_POLICY_INVALID",
      ...(request.action === "send"
        ? {
            binding: request.input.binding,
            operationId: request.input.operationId,
            evidenceId: request.input.witness.evidenceId,
          }
        : {}),
    };
    return `(${JSON.stringify(failure)})`;
  }
  const contentProfile =
    "contentProfile" in request
      ? request.contentProfile
      : (parsed.data.contentProfile ?? "message-anchors-v1");
  return `(${physicalPage.toString()})(${JSON.stringify(request)},${readPublicAssistantMessages.toString()},${publicMarkdownBlock.toString()},${publicContentVisible.toString()},${JSON.stringify(parsed.data.e2eOrigin)},${JSON.stringify(parsed.data.accountObservationProfile ?? null)},${parsed.data.accountObservationProfile ? readChatGptAccount.toString() : "null"},${JSON.stringify(contentProfile)})`;
}
const invalid = '({state:"refused",code:"PHYSICAL_INPUT_INVALID"})';
export function physicalPrepareProbeScript(
  binding: PhysicalBinding,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const parsed = bindingSchema.safeParse(binding);
  return parsed.success
    ? script({ action: "prepare", binding: parsed.data }, policy)
    : invalid;
}
export function physicalVerifySendScript(
  input: VerifyInput,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const physicalSelection = input.selection;
  const parsed = verifySchema.safeParse({
    binding: input.binding,
    operationId: input.operationId,
    previous: input.previous,
    intentDigest: input.intentDigest,
    controls: physicalSelection?.controls,
    requiredControls: physicalSelection?.requiredControls,
    ...(policy.accountObservationProfile
      ? { accountDeadlineMillis: input.deadlineMillis }
      : {}),
  });
  return parsed.success
    ? script({ action: "verify", input: parsed.data }, policy)
    : invalid;
}
export function physicalSendScript(
  input: SendInput,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const witness = input.witness;
  const physicalSelection = witness.selection.declared;
  const parsed = sendSchema.safeParse({
    binding: input.binding,
    operationId: input.operationId,
    intentDigest: input.intentDigest,
    prompt: input.prompt,
    ...(policy.accountObservationProfile
      ? { accountDeadlineMillis: input.deadlineMillis }
      : {}),
    witness: {
      binding: witness.binding,
      operationId: witness.operationId,
      evidenceId: witness.evidenceId,
      intentDigest: witness.intentDigest,
      previous: witness.previous,
      controls: physicalSelection?.controls,
      requiredControls: physicalSelection?.requiredControls,
      observed: witness.selection.observed,
      sourceProfile: witness.selection.sourceProfile,
      ...(witness.account
        ? {
            account: witness.account,
            accountDeadlineMillis: witness.deadlineMillis,
          }
        : {}),
    },
  });
  if (parsed.success)
    return script({ action: "send", input: parsed.data }, policy);
  const bound = z
    .strictObject({
      binding: bindingSchema,
      operationId: idSchema,
      evidenceId: idSchema,
    })
    .safeParse({
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: witness.evidenceId,
    });
  return bound.success
    ? `(${JSON.stringify({ ...bound.data, state: "not-sent", code: "PHYSICAL_INPUT_INVALID" })})`
    : invalid;
}
export function physicalObserveScript(
  input: PhysicalPageObservation,
  contentProfile: PhysicalPageContentProfile | undefined = undefined,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const selectedProfile =
    contentProfile ?? policy.contentProfile ?? "message-anchors-v1";
  const parsed = observationSchema.safeParse(projectObservation(input));
  return parsed.success &&
    ["message-anchors-v1", "farol-controlled-settled-segments-v1"].includes(
      selectedProfile,
    )
    ? script(
        {
          action: "observe",
          input: parsed.data,
          contentProfile: selectedProfile,
        },
        policy,
      )
    : invalid;
}
export function physicalCancelScript(
  input: PhysicalPageObservation,
  contentProfile: PhysicalPageContentProfile | undefined = undefined,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const selectedProfile =
    contentProfile ?? policy.contentProfile ?? "message-anchors-v1";
  const parsed = observationSchema.safeParse(projectObservation(input));
  return parsed.success &&
    ["message-anchors-v1", "farol-controlled-settled-segments-v1"].includes(
      selectedProfile,
    )
    ? script(
        {
          action: "cancel",
          input: parsed.data,
          contentProfile: selectedProfile,
        },
        policy,
      )
    : invalid;
}

function projectObservation(input: PhysicalPageObservation): PageObservation {
  const submission = input.submission;
  return {
    binding: input.binding,
    operationId: input.operationId,
    correlation: input.correlation,
    submission: {
      originBinding: submission.originBinding,
      operationId: submission.operationId,
      evidenceId: submission.evidenceId,
      intentDigest: submission.intentDigest,
      promptDigest: submission.promptDigest,
      baselineUserIds: submission.baselineUserIds,
      previous: submission.previous,
      controls: submission.selection.controls,
      requiredControls: submission.selection.requiredControls,
    },
  };
}
