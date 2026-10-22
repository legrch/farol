import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
} from "../../apps/desktop/chatgpt-physical-api";
import {
  physicalComposerDraft,
  physicalPrepareProbeScript,
  physicalVerifySendScript,
  physicalSendScript,
  physicalObserveScript,
  physicalCancelScript,
  type PhysicalPageSelection,
  type PhysicalPageSendInput,
  type PhysicalPageVerifyResponse,
  type PhysicalPageSendResponse,
  type PhysicalPageObservation,
  type PhysicalPageObserveResponse,
  type PhysicalPageContentProfile,
  type PhysicalPageCancelResponse,
  type PhysicalPagePrepareResponse,
} from "../../src/apps/desktop/chatgpt-physical-page-scripts";
import {
  ChatGptPublicTurn,
  PublicTurnFrameSchema,
} from "../../src/apps/desktop/chatgpt-public-turn";

// Synthetic CPU/VM public DOM only. No native or provider qualification.
const home = "https://chatgpt.com/";
const conversationId = "12345678-1234-4123-8123-123456789abc";
const conversation = `${home}c/${conversationId}`;
const digest = (text: string) =>
  createHash("sha256").update(text.replace(/\r\n?/gu, "\n")).digest("hex");
const declaration = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "declared-account",
  modelId: "declared-model",
  effort: "declared-effort",
  mode: "declared-mode",
  connectorId: "declared-connector",
  connectorGrantId: "declared-grant",
  toolsEnabled: true,
};
const selection: PhysicalPageSelection = {
  requested: declaration,
  admitted: declaration,
  resolved: {
    selection: declaration,
    configSHA256: "a".repeat(64),
    translationId: "translation",
  },
  controls: {
    modelLabel: "Test model",
    effortLabel: "Light",
    modeLabel: null,
    connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
  },
  requiredControls: { model: true, effort: true, mode: false, connector: true },
};
type VerifyInput = Omit<
  Parameters<ChatGptPhysicalApi["verifySend"]>[0],
  "selection"
> & { selection: PhysicalPageSelection };
type HostWitness = PhysicalPageSendInput["witness"];

class SyntheticElement {
  readonly nodeType = 1;
  parentElement: SyntheticElement | null = null;
  hidden = false;
  disabled = false;
  readOnly = false;
  children: SyntheticElement[] = [];
  childNodes: (SyntheticElement | { nodeType: number; nodeValue: string })[] =
    [];
  private text = "";
  constructor(
    readonly tagName: string,
    readonly attributes: Record<string, string> = {},
    text = "",
  ) {
    this.innerText = text;
  }
  get innerText(): string {
    return this.text + this.children.map((node) => node.innerText).join("");
  }
  set innerText(text: string) {
    this.text = text;
    this.childNodes = text ? [{ nodeType: 3, nodeValue: text }] : [];
  }
  get textContent() {
    return this.innerText;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  getBoundingClientRect() {
    return { width: this.hidden ? 0 : 100, height: 30 };
  }
  append(...nodes: SyntheticElement[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
      this.childNodes.push(node);
    }
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      part = part.trim();
      if (part.startsWith(".")) return this.attributes.class === part.slice(1);
      if (part.startsWith("#")) return this.attributes.id === part.slice(1);
      const tag = /^[a-z]+/u.exec(part)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const attrs = [
        ...part.matchAll(/\[([^=\]*^]+)(?:([*^]?=)"([^"]*)")?\]/gu),
      ];
      return (
        (Boolean(tag) || attrs.length > 0) &&
        attrs.every((match) => {
          const value = this.getAttribute(match[1]!);
          return (
            value !== null &&
            (match[2] === undefined ||
              (match[2] === "="
                ? value === match[3]
                : match[2] === "^="
                  ? value.startsWith(match[3]!)
                  : value.includes(match[3]!)))
          );
        })
      );
    });
  }
  closest(selector: string): SyntheticElement | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  querySelectorAll(selector: string): SyntheticElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  contains(node: SyntheticElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
      this.parentElement.childNodes = this.parentElement.childNodes.filter(
        (node) => node !== this,
      );
      this.parentElement = null;
    }
  }
  cloneNode(): SyntheticElement {
    const node = new SyntheticElement(
      this.tagName,
      { ...this.attributes },
      this.text,
    );
    node.append(...this.children.map((child) => child.cloneNode()));
    return node;
  }
  focus() {}
  dispatchEvent() {
    return true;
  }
}

describe("logical composer draft", () => {
  const read = (composer: SyntheticElement): string =>
    vm.runInNewContext(`(${physicalComposerDraft.toString()})(composer)`, {
      composer,
      HTMLElement: SyntheticElement,
      HTMLTextAreaElement: class {},
    }) as string;
  it.each(["DIV", "P"])(
    "preserves empty and trailing %s lines without mutating inline chips",
    (tag) => {
      const composer = new SyntheticElement("DIV", {}, "first");
      const chip = new SyntheticElement(
        "SPAN",
        { "data-testid": "composer-app-chip" },
        "not prompt",
      );
      const empty = () => {
        const line = new SyntheticElement(tag);
        line.append(new SyntheticElement("BR"));
        return line;
      };
      composer.append(
        chip,
        empty(),
        new SyntheticElement(tag, {}, "third"),
        empty(),
      );
      expect(read(composer)).toBe("first\n\nthird\n");
      expect(composer.contains(chip)).toBe(true);
      expect(chip.innerText).toBe("not prompt");
    },
  );
  it("preserves text and inline breaks, and refuses unsupported or excessive markup", () => {
    const composer = new SyntheticElement("DIV", {}, "first");
    composer.append(
      new SyntheticElement("BR"),
      new SyntheticElement("STRONG", {}, "second"),
    );
    expect(read(composer)).toBe("first\nsecond");
    composer.append(new SyntheticElement("TABLE"));
    expect(() => read(composer)).toThrow("PHYSICAL_DRAFT_UNQUALIFIED");
    const deep = new SyntheticElement("DIV");
    let cursor = deep;
    for (let index = 0; index < 34; index++) {
      const next = new SyntheticElement("SPAN");
      cursor.append(next);
      cursor = next;
    }
    expect(() => read(deep)).toThrow("PHYSICAL_DRAFT_UNQUALIFIED");
    const wide = new SyntheticElement("DIV");
    wide.append(
      ...Array.from({ length: 8193 }, () => new SyntheticElement("BR")),
    );
    expect(() => read(wide)).toThrow("PHYSICAL_DRAFT_UNQUALIFIED");
  });
  it("preserves an inline-wrapped break while a sole root BR remains empty", () => {
    const composer = new SyntheticElement("DIV", {}, "first");
    const inline = new SyntheticElement("SPAN");
    inline.append(new SyntheticElement("BR"));
    composer.append(inline, new SyntheticElement("SPAN", {}, "second"));
    expect(read(composer)).toBe("first\nsecond");
    const empty = new SyntheticElement("DIV");
    empty.append(new SyntheticElement("BR"));
    expect(read(empty)).toBe("");
  });
});

type FactoryPolicy = Readonly<{
  e2eOrigin: string | null;
  accountObservationProfile?: "provider-session-v1";
  contentProfile?: PhysicalPageContentProfile;
}>;
function page({
  editable = false,
  isHome = false,
  e2eOrigin = null,
  account = false,
  contentProfile,
}: {
  editable?: boolean;
  isHome?: boolean;
  e2eOrigin?: string | null;
  account?: boolean;
  contentProfile?: PhysicalPageContentProfile;
} = {}) {
  const policy: FactoryPolicy = {
    e2eOrigin,
    ...(contentProfile ? { contentProfile } : {}),
    ...(account
      ? { accountObservationProfile: "provider-session-v1" as const }
      : {}),
  };
  let accountID: string | null = "fixture-account-A";
  let userID = "fixture-user-A";
  let accountRequests = 0;
  let accountTime = Date.now();
  let onAccountFetch: () => void | Promise<void> = () => {};
  const fetchAccount = async () => {
    accountRequests++;
    await onAccountFetch();
    const payload = JSON.stringify({
      user: { id: userID },
      account: accountID === null ? null : { id: accountID },
      expires: new Date(accountTime + 60_000).toISOString(),
      accessToken: "never-exported-auth-canary",
    });
    return {
      url: `${e2eOrigin ?? "https://chatgpt.com"}/api/auth/session`,
      type: "basic",
      redirected: false,
      status: 200,
      headers: { get: () => "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    };
  };
  const effects = {
    focus: 0,
    events: 0,
    setters: 0,
    insert: 0,
    selection: 0,
    send: 0,
    stop: 0,
  };
  let onSend = () => {};
  let onStop = () => {};
  let onEvent = () => {};
  let onHash = () => {};
  let hashCalls = 0;
  class TextArea extends SyntheticElement {
    private content = "";
    get value() {
      return this.content;
    }
    set value(text: string) {
      effects.setters++;
      this.content = text.replace(/\r\n?/gu, "\n");
    }
  }
  class Button extends SyntheticElement {
    click() {
      if (this.getAttribute("data-testid") === "send-button") {
        effects.send++;
        onSend();
      }
      if (this.getAttribute("data-testid") === "stop-button") {
        effects.stop++;
        onStop();
      }
    }
  }
  const root = new SyntheticElement("MAIN");
  const form = new SyntheticElement("FORM");
  const composer = editable
    ? new SyntheticElement("DIV", {
        id: "prompt-textarea",
        contenteditable: "true",
      })
    : new TextArea("TEXTAREA", { id: "prompt-textarea" });
  composer.focus = () => {
    effects.focus++;
  };
  composer.dispatchEvent = () => {
    effects.events++;
    onEvent();
    return true;
  };
  const model = new Button(
    "BUTTON",
    { "aria-label": "Select ChatGPT model" },
    "Test model",
  );
  const effort = new Button(
    "BUTTON",
    { "aria-haspopup": "menu", "data-tone": "neutral" },
    "Light",
  );
  const connector = new SyntheticElement(
    "SPAN",
    {
      "data-testid": "composer-app-chip",
      "data-plugin-id": "plugin_asdk_app_TEST",
      "data-app-name": "Farol DEV",
    },
    "Farol DEV",
  );
  const send = new Button("BUTTON", { "data-testid": "send-button" });
  const stop = new Button("BUTTON", { "data-testid": "stop-button" });
  stop.hidden = true;
  if (editable) composer.append(connector);
  else form.append(connector);
  form.append(composer, effort, send, stop);
  root.append(model, form);
  const addMessage = (
    id: string,
    role: "user" | "assistant",
    text: string,
    parentId: string | null = null,
    settled = true,
  ) => {
    const node = new SyntheticElement(
      "DIV",
      {
        "data-message-id": id,
        "data-message-author-role": role,
        ...(parentId ? { "data-parent-message-id": parentId } : {}),
        ...(role === "assistant"
          ? {
              "data-message-channel": "final",
              "data-is-streaming": settled ? "false" : "true",
            }
          : {}),
      },
      role === "user" ? text : "",
    );
    const article = new SyntheticElement("ARTICLE");
    article.append(node);
    if (role === "assistant") {
      const markdown = new SyntheticElement("DIV", { class: "markdown" });
      markdown.append(new SyntheticElement("P", {}, text));
      node.append(markdown);
      const copy = new Button("BUTTON", {
        "data-testid": "copy-turn-action-button",
      });
      copy.hidden = !settled;
      article.append(copy);
    }
    root.append(article);
    return node;
  };
  if (!isHome) {
    addMessage("u1", "user", "Earlier");
    addMessage("a1", "assistant", "Earlier answer", "u1");
  }
  const pageHome = e2eOrigin ? `${e2eOrigin}/chatgpt` : home;
  const pageConversation = e2eOrigin
    ? `${e2eOrigin}/chatgpt/c/${conversationId}`
    : conversation;
  const location = { href: isHome ? pageHome : pageConversation };
  const binding: PhysicalBinding = {
    viewId: "view",
    viewGeneration: 1,
    documentGeneration: 7,
    partition: e2eOrigin
      ? "persist:farol-dev-chatgpt"
      : "persist:farol-app-chatgpt",
    ...(isHome
      ? { phase: "home", url: pageHome, conversationId: null }
      : { phase: "conversation", url: pageConversation, conversationId }),
  };
  const input: VerifyInput = {
    binding,
    operationId: "op",
    deadlineMillis: Date.now() + 60_000,
    previous: isHome ? null : { userTurnId: "u1", replyId: "a1" },
    intentDigest: "opaque-go-envelope",
    selection,
  };
  const document = {
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createRange: () => ({
      selectNodeContents() {
        effects.selection++;
      },
      collapse() {
        effects.selection++;
      },
    }),
    execCommand: (_command: string, _ui: boolean, text: string) => {
      effects.insert++;
      composer.append(
        new SyntheticElement("SPAN", {}, text.replace(/\r\n?/gu, "\n")),
      );
      return true;
    },
  };
  const globals = {
    document,
    location,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    ReadableStream,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    ...(account
      ? {
          Date: class extends Date {
            static override now() {
              return accountTime;
            }
          },
          fetch: fetchAccount,
        }
      : {}),
    crypto: {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        digest: async (algorithm: string, data: BufferSource) => {
          hashCalls++;
          onHash();
          return webcrypto.subtle.digest(algorithm, data);
        },
      },
    },
    window: {
      getSelection: () => ({
        removeAllRanges() {
          effects.selection++;
        },
        addRange() {
          effects.selection++;
        },
      }),
    },
    HTMLElement: SyntheticElement,
    HTMLTextAreaElement: TextArea,
    HTMLButtonElement: Button,
    InputEvent: class {},
    getComputedStyle: (node: SyntheticElement) => ({
      display: node.hidden ? "none" : "block",
      visibility: "visible",
      opacity: "1",
    }),
  };
  let context = vm.createContext(globals);
  const run = <T>(script: string) =>
    vm.runInContext(script, context) as Promise<T>;
  const verify = async (candidate = input) => {
    const result = await run<PhysicalPageVerifyResponse>(
      Reflect.apply(physicalVerifySendScript, undefined, [
        candidate,
        policy,
      ]) as string,
    );
    if (result.state !== "witnessed")
      throw new Error(`Fixture verification failed: ${result.code}`);
    // Simulate Main's host-only hydration; raw provider-page response has no pins.
    const evidence = {
      declared: candidate.selection,
      observed: result.observed,
      sourceProfile: result.sourceProfile,
      observedAtMillis: Date.now(),
    };
    const witness: HostWitness = {
      binding: result.binding,
      operationId: result.operationId,
      deadlineMillis: candidate.deadlineMillis,
      evidenceId: result.evidenceId,
      intentDigest: result.intentDigest,
      previous: result.previous,
      selection: evidence,
      ...(result.account ? { account: result.account } : {}),
    };
    return { ...result, witness };
  };
  const sendWitness = (
    witness: HostWitness,
    prompt = "Next\r\nline",
    candidate = input,
  ) =>
    run<PhysicalPageSendResponse>(
      Reflect.apply(physicalSendScript, undefined, [
        {
          binding: candidate.binding,
          operationId: candidate.operationId,
          deadlineMillis: candidate.deadlineMillis,
          intentDigest: candidate.intentDigest,
          witness,
          prompt,
        },
        policy,
      ]) as string,
    );
  const submit = async (prompt = "Next\r\nline") => {
    const verified = await verify();
    const result = await sendWitness(verified.witness, prompt);
    expect(result.state).toBe("submitted");
    const observeInput: PhysicalPageObservation = {
      binding,
      operationId: input.operationId,
      deadlineMillis: input.deadlineMillis,
      submission: {
        originBinding: binding,
        operationId: input.operationId,
        evidenceId: verified.witness.evidenceId,
        intentDigest: input.intentDigest,
        promptDigest: digest(prompt),
        baselineUserIds: verified.baselineUserIds,
        previous: input.previous,
        selection: input.selection,
      },
      correlation: { userTurnId: null, replyId: null },
    };
    return { result, observeInput, witness: verified.witness };
  };
  const observe = (
    candidate: PhysicalPageObservation,
    profile?: PhysicalPageContentProfile,
  ) =>
    run<PhysicalPageObserveResponse>(
      Reflect.apply(physicalObserveScript, undefined, [
        candidate,
        profile,
        policy,
      ]) as string,
    );
  const cancel = (candidate: PhysicalPageObservation) =>
    run<PhysicalPageCancelResponse>(
      Reflect.apply(physicalCancelScript, undefined, [
        candidate,
        undefined,
        policy,
      ]) as string,
    );
  return {
    policy,
    account: {
      requests: () => accountRequests,
      change: (next: string | null, user = userID) => {
        accountID = next;
        userID = user;
      },
      beforeFetch: (fn: () => void | Promise<void>) => {
        onAccountFetch = fn;
      },
      advance: (milliseconds: number) => {
        accountTime += milliseconds;
      },
    },
    root,
    form,
    composer,
    model,
    effort,
    connector,
    send,
    stop,
    location,
    binding,
    input,
    effects,
    addMessage,
    run,
    verify,
    sendWitness,
    submit,
    observe,
    cancel,
    draft: (text: string) => {
      if (composer instanceof TextArea) composer.value = text;
      else composer.append(new SyntheticElement("SPAN", {}, text));
    },
    onSend: (fn: () => void) => {
      onSend = fn;
    },
    onStop: (fn: () => void) => {
      onStop = fn;
    },
    onEvent: (fn: () => void) => {
      onEvent = fn;
    },
    onHash: (fn: () => void) => {
      onHash = fn;
    },
    hashCalls: () => hashCalls,
    reload: () => {
      context = vm.createContext(globals);
    },
    remount: (id: string) => {
      const node = root
        .querySelectorAll("[data-message-id]")
        .find((element) => element.getAttribute("data-message-id") === id)!;
      const article = node.closest("article")!;
      const clone = article.cloneNode();
      article.remove();
      root.append(clone);
      return clone.querySelector("[data-message-id]")!;
    },
  };
}

describe("physical PAGE review refinements: targeted synthetic RED regressions", () => {
  it.each(["http://127.0.0.1:38517", "http://localhost:38517"])(
    "explicit dev loopback policy permits all five factories at %s",
    async (e2eOrigin) => {
      const p = page({ isHome: true, e2eOrigin });
      expect(
        await p.run(
          Reflect.apply(physicalPrepareProbeScript, undefined, [
            p.binding,
            p.policy,
          ]) as string,
        ),
      ).toEqual({ readiness: "ready" });
      expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
        state: "refused",
      }); // URL alone grants nothing.
      const { result, observeInput } = await p.submit();
      expect(result.state).toBe("submitted");
      p.addMessage("new-user", "user", "Next\nline");
      p.location.href = `${e2eOrigin}/chatgpt/c/${conversationId}`;
      const current: PhysicalPageObservation = {
        ...observeInput,
        binding: {
          ...p.binding,
          phase: "conversation",
          url: p.location.href,
          conversationId,
        },
      };
      expect(await p.observe(current)).toMatchObject({
        state: "observed",
        correlation: { userTurnId: "new-user", replyId: null },
        frame: null,
      });
      p.addMessage("new-reply", "assistant", "Pending", "new-user", false);
      p.stop.hidden = false;
      expect(await p.cancel(current)).toMatchObject({ state: "requested" });
      expect(p.effects).toMatchObject({ send: 1, stop: 1 });
    },
  );
  it.each([
    "http://127.0.0.1:38517/",
    "http://127.0.0.1:38517/chatgpt",
    "http://127.1:38517",
    "http://127.0.0.2:38517",
    "https://localhost:38517",
    "http://LOCALHOST:38517",
    "http://localhost:80",
    "http://user@localhost:38517",
    "http://localhost:38517?x=1",
    "http://localhost:38517#x",
    "https://chatgpt.com",
    "http://example.com",
  ])("rejects nonqualified explicit origin %s", async (e2eOrigin) => {
    const p = page();
    expect(
      await p.run(
        Reflect.apply(physicalPrepareProbeScript, undefined, [
          p.binding,
          { e2eOrigin },
        ]) as string,
      ),
    ).toMatchObject({ state: "refused", code: "PHYSICAL_POLICY_INVALID" });
    expect(Object.values(p.effects).every((value) => value === 0)).toBe(true);
  });
  it("invalid policy is refused content-free by every factory without page effects", async () => {
    const p = page();
    const verified = await p.verify();
    const policy: FactoryPolicy = { e2eOrigin: "http://example.com" };
    const observation: PhysicalPageObservation = {
      binding: p.binding,
      operationId: p.input.operationId,
      deadlineMillis: p.input.deadlineMillis,
      submission: {
        originBinding: p.binding,
        operationId: p.input.operationId,
        evidenceId: verified.evidenceId,
        intentDigest: p.input.intentDigest,
        promptDigest: digest("Transient"),
        baselineUserIds: verified.baselineUserIds,
        previous: p.input.previous,
        selection: p.input.selection,
      },
      correlation: { userTurnId: null, replyId: null },
    };
    const scripts = [
      Reflect.apply(physicalPrepareProbeScript, undefined, [p.binding, policy]),
      Reflect.apply(physicalVerifySendScript, undefined, [p.input, policy]),
      Reflect.apply(physicalSendScript, undefined, [
        {
          binding: p.binding,
          operationId: p.input.operationId,
          deadlineMillis: p.input.deadlineMillis,
          intentDigest: p.input.intentDigest,
          witness: verified.witness,
          prompt: "Transient",
        },
        policy,
      ]),
      Reflect.apply(physicalObserveScript, undefined, [
        observation,
        undefined,
        policy,
      ]),
      Reflect.apply(physicalCancelScript, undefined, [
        observation,
        undefined,
        policy,
      ]),
    ];
    for (const script of scripts) {
      expect(script).not.toContain("example.com");
      expect(script).not.toContain("Transient");
      expect(await p.run(script as string)).toMatchObject({
        code: "PHYSICAL_POLICY_INVALID",
      });
    }
    expect(Object.values(p.effects).every((value) => value === 0)).toBe(true);
    expect(p.hashCalls()).toBe(0);
  });
  it("explicit loopback still requires dev partition, exact origin and /chatgpt paths", async () => {
    const e2eOrigin = "http://localhost:38517";
    for (const mutation of [
      "partition",
      "origin",
      "home-path",
      "conversation-path",
      "query",
    ]) {
      const p = page({ isHome: true, e2eOrigin });
      let binding: PhysicalBinding = p.binding;
      if (mutation === "partition")
        binding = { ...binding, partition: "persist:farol-app-chatgpt" };
      if (mutation === "origin") {
        p.location.href = "http://localhost:38518/chatgpt";
        binding = { ...binding, url: p.location.href };
      }
      if (mutation === "home-path") {
        p.location.href = `${e2eOrigin}/`;
        binding = { ...binding, url: p.location.href };
      }
      if (mutation === "conversation-path") {
        p.location.href = `${e2eOrigin}/c/${conversationId}`;
        binding = {
          ...binding,
          phase: "conversation",
          conversationId,
          url: p.location.href,
        };
      }
      if (mutation === "query") {
        p.location.href += "?x=1";
        binding = { ...binding, url: p.location.href };
      }
      expect(
        await p.run(
          Reflect.apply(physicalPrepareProbeScript, undefined, [
            binding,
            p.policy,
          ]) as string,
        ),
      ).toMatchObject({ code: "PHYSICAL_BINDING_STALE" });
    }
  });
  it.each(["effort", "mode", "connector"] as const)(
    "Verify refuses known %s when expected control is null",
    async (field) => {
      const p = page();
      if (field === "mode")
        p.form.append(
          new SyntheticElement(
            "BUTTON",
            { "data-testid": "composer-mode-button" },
            "Search",
          ),
        );
      const candidate: VerifyInput = {
        ...p.input,
        selection: {
          ...selection,
          controls: {
            ...selection.controls,
            ...(field === "effort"
              ? { effortLabel: null }
              : field === "mode"
                ? { modeLabel: null }
                : { connector: null }),
          },
          requiredControls: { ...selection.requiredControls, [field]: false },
        },
      };
      expect(await p.run(physicalVerifySendScript(candidate))).toMatchObject({
        state: "refused",
        code: "PHYSICAL_SELECTION_MISMATCH",
      });
      expect(p.effects.send).toBe(0);
    },
  );
  it.each(["effort", "mode", "connector"] as const)(
    "Send rechecks newly exposed %s against null expected",
    async (field) => {
      const p = page();
      const control =
        field === "mode"
          ? new SyntheticElement(
              "BUTTON",
              { "data-testid": "composer-mode-button" },
              "Search",
            )
          : p[field];
      control.remove();
      const candidate: VerifyInput = {
        ...p.input,
        selection: {
          ...selection,
          controls: {
            ...selection.controls,
            ...(field === "effort"
              ? { effortLabel: null }
              : field === "mode"
                ? { modeLabel: null }
                : { connector: null }),
          },
          requiredControls: { ...selection.requiredControls, [field]: false },
        },
      };
      const { witness } = await p.verify(candidate);
      p.onHash(() => p.form.append(control));
      expect(await p.sendWitness(witness, "Next", candidate)).toMatchObject({
        state: "not-sent",
        code: "PHYSICAL_SELECTION_MISMATCH",
      });
      expect(p.effects.send).toBe(0);
    },
  );
  it("Observe retains exact IDs/frame after required chip clears and reports actual changed controls", async () => {
    const p = page({ editable: true });
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Answer", "u2");
    p.connector.remove();
    p.model.innerText = "Actual changed model";
    p.effort.innerText = "Heavy";
    p.form.append(
      new SyntheticElement(
        "BUTTON",
        { "data-testid": "composer-mode-button" },
        "Search",
      ),
    );
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
      frame: { terminal: true },
      observed: {
        modelLabel: { state: "observed", value: "Actual changed model" },
        effortLabel: { state: "observed", value: "Heavy" },
        modeLabel: { state: "observed", value: "Search" },
        connectorLabel: { state: "unknown", code: "not-exposed" },
      },
    });
    expect(p.effects.send).toBe(1);
  });
  it("Observe keeps correlated frame when composer controls are disabled or unavailable", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Pending", "u2", false);
    p.composer.disabled = true;
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
      observed: { effortLabel: { state: "observed", value: "Light" } },
    });
    p.composer.remove();
    p.model.remove();
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
      frame: { userId: "u2", terminal: false },
      observed: {
        modelLabel: { state: "unknown" },
        effortLabel: { state: "unknown" },
        modeLabel: { state: "unknown" },
        connectorLabel: { state: "unknown" },
      },
    });
    expect(p.effects.send).toBe(1);
  });
  it("Observe reports a changed actual connector label without matching pre-send pins", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Answer", "u2");
    p.connector.attributes["data-plugin-id"] = "plugin_asdk_app_OTHER";
    p.connector.attributes["data-app-name"] = "Actual other connector";
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      observed: {
        connectorLabel: { state: "observed", value: "Actual other connector" },
      },
      correlation: { userTurnId: "u2", replyId: "a2" },
    });
  });
  it.each([6, 8])(
    "Observe refuses document generation %s against origin 7",
    async (documentGeneration) => {
      const p = page();
      const { observeInput } = await p.submit();
      p.addMessage("u2", "user", "Next\nline");
      p.addMessage("a2", "assistant", "Answer", "u2");
      expect(
        await p.observe({
          ...observeInput,
          binding: { ...p.binding, documentGeneration },
        }),
      ).toMatchObject({ state: "refused", code: "PHYSICAL_BINDING_STALE" });
    },
  );
  it("correlated user without assistant has null frame until first actual reply", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: null },
      frame: null,
    });
    p.addMessage("a2", "assistant", "Pending", "u2", false);
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
      frame: { userId: "u2", terminal: false },
    });
  });
});

describe("physical PAGE scripts: synthetic DOM source qualification only", () => {
  it.each([false, true])(
    "verify and prepare are read-only (editable=%s), fresh witnesses and explicit unknown facts",
    async (editable) => {
      const p = page({ editable });
      const before = p.root.cloneNode().innerText;
      expect(
        await p.run<PhysicalPagePrepareResponse>(
          physicalPrepareProbeScript(p.binding),
        ),
      ).toMatchObject({ readiness: "ready" });
      const a = await p.verify();
      const b = await p.verify();
      expect(a.witness.evidenceId).not.toBe(b.witness.evidenceId);
      expect(a.baselineUserIds).toEqual(["u1"]);
      expect(a.witness.selection.observed).toMatchObject({
        modelLabel: { state: "observed", value: "Test model" },
        effortLabel: { state: "observed", value: "Light" },
        connectorLabel: { state: "observed", value: "Farol DEV" },
      });
      expect(Object.keys(a.observed).sort()).toEqual([
        "connectorLabel",
        "effortLabel",
        "modeLabel",
        "modelLabel",
      ]);
      expect(a.observed.modeLabel).toEqual({
        state: "unknown",
        code: "not-exposed",
      });
      expect(p.root.innerText).toBe(before);
      expect(Object.values(p.effects)).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(p.hashCalls()).toBe(0);
    },
  );
  it("proves blank Home only for previous=null and canonical URLs", async () => {
    const p = page({ isHome: true });
    expect((await p.verify()).baselineUserIds).toEqual([]);
    p.addMessage("unexpected", "user", "Old");
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      code: "PHYSICAL_PREVIOUS_MISMATCH",
    });
    const saved = page();
    expect(
      await saved.run(
        physicalVerifySendScript({ ...saved.input, previous: null }),
      ),
    ).toMatchObject({ code: "PHYSICAL_PREVIOUS_MISMATCH" });
    for (const href of [
      home + "?temporary-chat=true",
      home + "#x",
      "https://example.com/",
      conversation,
    ]) {
      const q = page({ isHome: true });
      q.location.href = href;
      expect(await q.run(physicalVerifySendScript(q.input))).toMatchObject({
        code: "PHYSICAL_BINDING_STALE",
      });
    }
  });
  it("previous uses the first assistant anchor and all associated settled articles", async () => {
    const p = page();
    p.addMessage("a2", "assistant", "Second", "a1");
    expect((await p.verify()).witness.previous?.replyId).toBe("a1");
    expect(
      await p.run(
        physicalVerifySendScript({
          ...p.input,
          previous: { userTurnId: "u1", replyId: "a2" },
        }),
      ),
    ).toMatchObject({ code: "PHYSICAL_PREVIOUS_MISMATCH" });
    p.addMessage("a3", "assistant", "Pending", "a2", false);
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      code: "PHYSICAL_PREVIOUS_UNSETTLED",
    });
    expect(p.effects.send).toBe(0);
  });
  it.each(["model", "effort", "connector"] as const)(
    "required observable %s missing fails closed",
    async (field) => {
      const p = page();
      p[field].remove();
      expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
        state: "refused",
        code: "PHYSICAL_SELECTION_UNEXPOSED",
      });
    },
  );
  it("nullable controls are not absence proofs; exposes data-app-id and qualified app links", async () => {
    const p = page();
    p.effort.remove();
    p.connector.remove();
    const input = {
      ...p.input,
      selection: {
        ...selection,
        controls: {
          modelLabel: "Test model",
          effortLabel: null,
          modeLabel: null,
          connector: null,
        },
        requiredControls: {
          model: true as const,
          effort: false,
          mode: false,
          connector: false,
        },
      },
    };
    expect(
      (await p.verify(input)).witness.selection.observed.connectorLabel,
    ).toMatchObject({ state: "unknown" });
    for (const kind of ["data-app-id", "data-prompt-link-href", "href"]) {
      const q = page();
      delete q.connector.attributes["data-plugin-id"];
      q.connector.attributes[kind] =
        kind === "data-app-id"
          ? "plugin_asdk_app_TEST"
          : kind === "href"
            ? `${home}g/g-test/plugins/plugin_asdk_app_TEST`
            : "app://asdk_app_TEST";
      expect(
        (await q.verify()).witness.selection.observed.connectorLabel,
      ).toMatchObject({ state: "observed", value: "Farol DEV" });
    }
  });
  it("mode needs its own actual public control and required masks are fail closed", async () => {
    const p = page();
    const required: VerifyInput = {
      ...p.input,
      selection: {
        ...selection,
        controls: { ...selection.controls, modeLabel: "Search" },
        requiredControls: { ...selection.requiredControls, mode: true },
      },
    };
    expect(await p.run(physicalVerifySendScript(required))).toMatchObject({
      code: "PHYSICAL_SELECTION_UNEXPOSED",
    });
    p.stop.hidden = false;
    expect(await p.run(physicalVerifySendScript(required))).toMatchObject({
      code: "PHYSICAL_COMPOSER_BUSY",
    });
    p.stop.hidden = true;
    p.form.append(
      new SyntheticElement(
        "BUTTON",
        { "aria-label": "Search", "aria-pressed": "true" },
        "Search",
      ),
    );
    expect((await p.verify(required)).observed.modeLabel).toEqual({
      state: "observed",
      source: "public-dom",
      value: "Search",
    });
    const optional: VerifyInput = {
      ...required,
      selection: {
        ...required.selection,
        controls: { ...required.selection.controls, modeLabel: "Agent mode" },
        requiredControls: {
          ...required.selection.requiredControls,
          mode: false,
        },
      },
    };
    expect(await p.run(physicalVerifySendScript(optional))).toMatchObject({
      code: "PHYSICAL_SELECTION_MISMATCH",
    });
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      state: "refused",
      code: "PHYSICAL_SELECTION_MISMATCH",
    });
    const q = page();
    q.effort.remove();
    q.connector.remove();
    const missing: VerifyInput = {
      ...q.input,
      selection: {
        ...selection,
        requiredControls: {
          model: true,
          effort: false,
          mode: false,
          connector: false,
        },
      },
    };
    expect((await q.verify(missing)).observed).toMatchObject({
      effortLabel: { state: "unknown" },
      connectorLabel: { state: "unknown" },
      modeLabel: { state: "unknown" },
    });
    expect(
      await q.run(
        physicalVerifySendScript({
          ...missing,
          selection: {
            ...missing.selection,
            requiredControls: {
              ...missing.selection.requiredControls,
              model: false,
            },
          },
        } as unknown as VerifyInput),
      ),
    ).toMatchObject({ code: "PHYSICAL_INPUT_INVALID" });
  });
  it("effort is scoped to composer; duplicate controls, anchors and bad parents fail closed", async () => {
    const p = page();
    p.root.append(
      new SyntheticElement(
        "BUTTON",
        { "aria-haspopup": "menu", "data-tone": "neutral" },
        "Unrelated",
      ),
    );
    await p.verify();
    p.form.append(
      new SyntheticElement(
        "BUTTON",
        { "aria-haspopup": "menu", "data-tone": "neutral" },
        "Light",
      ),
    );
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      code: "PHYSICAL_SELECTION_AMBIGUOUS",
    });
    const q = page();
    q.addMessage("a1", "assistant", "Duplicate", "u1");
    expect(await q.run(physicalVerifySendScript(q.input))).toMatchObject({
      code: "PHYSICAL_ANCHOR_AMBIGUOUS",
    });
    const r = page();
    r.addMessage("a2", "assistant", "Bad", "other");
    expect(await r.run(physicalVerifySendScript(r.input))).toMatchObject({
      code: "PHYSICAL_PARENT_MISMATCH",
    });
  });
  it("draft, disabled composer and hidden history never mint witnesses", async () => {
    const p = page();
    p.draft("draft");
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      code: "PHYSICAL_DRAFT_CHANGED",
    });
    const q = page();
    q.composer.disabled = true;
    expect(await q.run(physicalVerifySendScript(q.input))).toMatchObject({
      code: "PHYSICAL_COMPOSER_UNAVAILABLE",
    });
    const r = page({ isHome: true });
    r.addMessage("hidden", "user", "Hidden").hidden = true;
    expect(await r.run(physicalVerifySendScript(r.input))).toMatchObject({
      code: "PHYSICAL_HISTORY_UNQUALIFIED",
    });
  });
  it("forged IDs or altered public control witnesses cannot consume the real witness", async () => {
    const p = page();
    const { witness } = await p.verify();
    expect(
      await p.sendWitness({ ...witness, evidenceId: webcrypto.randomUUID() }),
    ).toMatchObject({ state: "not-sent", code: "PHYSICAL_WITNESS_INVALID" });
    const altered = {
      ...witness,
      selection: {
        ...witness.selection,
        declared: {
          ...selection,
          controls: { ...selection.controls, modelLabel: "forged" },
        },
      },
    };
    expect(await p.sendWitness(altered)).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_WITNESS_INVALID",
    });
    expect(await p.sendWitness(witness)).toMatchObject({ state: "submitted" });
    expect(await p.sendWitness(witness)).toMatchObject({ state: "not-sent" });
    p.draft("");
    expect(await p.run(physicalVerifySendScript(p.input))).toMatchObject({
      code: "PHYSICAL_OPERATION_SPENT",
    });
    expect(p.effects.send).toBe(1);
  });
  it("Send keeps opaque intent separate from normalized prompt SHA and preserves inline chip", async () => {
    const p = page({ editable: true });
    const { result, observeInput } = await p.submit();
    expect(observeInput.submission).toMatchObject({
      intentDigest: "opaque-go-envelope",
      promptDigest: digest("Next\nline"),
      baselineUserIds: ["u1"],
    });
    expect(result).toMatchObject({ state: "submitted" });
    expect(p.composer.contains(p.connector)).toBe(true);
    expect(p.effects).toMatchObject({ send: 1, insert: 1, setters: 0 });
    const memory = await p.run<string>(
      `JSON.stringify([...globalThis[Symbol.for("farol.physical-page.v1")].operations.values()])`,
    );
    expect(memory).not.toContain("Next");
  });
  it.each([
    "model",
    "effort",
    "connector",
    "url",
    "draft",
    "history",
    "remount",
  ])(
    "crypto yield rechecks %s before any insertion or click",
    async (change) => {
      const p = page();
      const { witness } = await p.verify();
      p.onHash(() => {
        if (change === "model") p.model.innerText = "Different";
        if (change === "effort") p.effort.innerText = "Different";
        if (change === "connector")
          p.connector.attributes["data-plugin-id"] = "different";
        if (change === "url") p.location.href = home;
        if (change === "draft") p.draft("Owner draft");
        if (change === "history") p.addMessage("u2", "user", "Owner turn");
        if (change === "remount") {
          const clone = p.composer.cloneNode();
          p.composer.remove();
          p.form.append(clone);
        }
      });
      expect(await p.sendWitness(witness)).toMatchObject({ state: "not-sent" });
      expect(p.effects.send).toBe(0);
      expect(p.effects.events).toBe(0);
      expect(await p.sendWitness(witness)).toMatchObject({
        code: "PHYSICAL_WITNESS_INVALID",
      });
    },
  );
  it.each(["selection", "binding", "draft", "previous"])(
    "synchronous insertion event mutation of %s forbids Send",
    async (change) => {
      const p = page();
      const { witness } = await p.verify();
      p.onEvent(() => {
        if (change === "selection") p.model.innerText = "Different";
        if (change === "binding") p.location.href = home;
        if (change === "draft") p.draft("Different");
        if (change === "previous") p.addMessage("u2", "user", "Changed");
      });
      expect(await p.sendWitness(witness)).toMatchObject({ state: "not-sent" });
      expect(p.effects.send).toBe(0);
    },
  );
  it("known optional mode changes invalidate the physical witness", async () => {
    const p = page();
    const mode = new SyntheticElement(
      "BUTTON",
      { "data-testid": "composer-mode-button" },
      "Search",
    );
    p.form.append(mode);
    const candidate: VerifyInput = {
      ...p.input,
      selection: {
        ...selection,
        controls: { ...selection.controls, modeLabel: "Search" },
      },
    };
    const { witness } = await p.verify(candidate);
    p.onHash(() => {
      mode.innerText = "Agent mode";
    });
    expect(await p.sendWitness(witness, "Next", candidate)).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_SELECTION_MISMATCH",
    });
    expect(p.effects.send).toBe(0);
  });
  it("one click throwing is unknown and page fuse blocks both witnesses/concurrent dispatch", async () => {
    const p = page();
    const a = await p.verify();
    const b = await p.verify();
    p.onSend(() => {
      throw new Error("private page data");
    });
    const result = await p.sendWitness(a.witness);
    expect(result).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_SEND_UNKNOWN",
    });
    expect(result).not.toHaveProperty("submission");
    expect(JSON.stringify(result)).not.toContain("private page data");
    expect(await p.sendWitness(a.witness)).toMatchObject({ state: "not-sent" });
    expect(await p.sendWitness(b.witness)).toMatchObject({ state: "not-sent" });
    expect(p.effects.send).toBe(1);
    const q = page();
    const { witness } = await q.verify();
    const results = await Promise.all([
      q.sendWitness(witness),
      q.sendWitness(witness),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual([
      "not-sent",
      "submitted",
    ]);
    expect(q.effects.send).toBe(1);
  });
  it("prompt-free observe waits for real provider IDs and first canonical Home transition", async () => {
    const p = page({ isHome: true });
    const { observeInput } = await p.submit();
    expect(physicalObserveScript(observeInput)).not.toContain("Next");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      binding: { phase: "home", conversationId: null },
      correlation: { userTurnId: null, replyId: null },
      frame: null,
    });
    p.addMessage("provider-u", "user", "Next\nline");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "provider-u", replyId: null },
    });
    p.location.href = conversation;
    const current: PhysicalPageObservation = {
      ...observeInput,
      binding: {
        ...p.binding,
        phase: "conversation",
        conversationId,
        url: conversation,
      },
    };
    expect(await p.observe(current)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "provider-u", replyId: null },
      binding: {
        conversationId,
        viewId: p.binding.viewId,
        viewGeneration: p.binding.viewGeneration,
        documentGeneration: p.binding.documentGeneration,
      },
    });
    p.addMessage("provider-a", "assistant", "Answer", "provider-u");
    expect(await p.observe(current)).toMatchObject({
      state: "observed",
      originBinding: { phase: "home", conversationId: null },
      binding: { conversationId },
      correlation: { userTurnId: "provider-u", replyId: "provider-a" },
      frame: { terminal: true },
    });
    p.location.href = `${home}c/another`;
    expect(
      await p.observe({
        ...current,
        binding: {
          ...current.binding,
          phase: "conversation",
          conversationId: "another",
          url: p.location.href,
        },
      }),
    ).toMatchObject({ code: "PHYSICAL_BINDING_STALE" });
  });
  it("recovers retained IDs on page-context remount in the exact original document without Send", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline", "a1");
    p.addMessage("a2", "assistant", "Answer", "u2");
    const first = await p.observe(observeInput);
    if (first.state !== "observed")
      throw new Error("Fixture observation failed");
    expect(PublicTurnFrameSchema.safeParse(first.frame).success).toBe(true);
    p.reload();
    p.remount("a2");
    const hashes = p.hashCalls();
    const recovered = await p.observe({
      ...observeInput,
      binding: observeInput.binding,
      correlation: first.correlation,
    });
    expect(recovered).toMatchObject({
      state: "observed",
      correlation: first.correlation,
      frame: first.frame,
    });
    expect(p.hashCalls()).toBe(hashes);
    expect(p.effects.send).toBe(1);
    expect(await p.sendWitness((await page().verify()).witness)).toMatchObject({
      state: "not-sent",
    });
  });
  it("qualified actual app marker prefix correlates; unqualified text prefix does not", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    const user = p.addMessage("u2", "user", "");
    user.append(
      p.connector.cloneNode(),
      new SyntheticElement("SPAN", {}, "Next\nline"),
    );
    p.addMessage("a2", "assistant", "Answer", "u2");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
    });
    const q = page();
    const sub = await q.submit();
    q.addMessage("u2", "user", "Farol DEV Next\nline");
    expect(await q.observe(sub.observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: null, replyId: null },
    });
  });
  it("actual qualified app-prefix delimiter is correlated without stripping arbitrary labels", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    const user = p.addMessage("u2", "user", "");
    user.append(
      p.connector.cloneNode(),
      new SyntheticElement("SPAN", {}, "\n\nNext\nline"),
    );
    p.addMessage("a2", "assistant", "Answer", "u2");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
    });
  });
  it("user correlation excludes hidden nested content and rejects duplicate assistant anchors", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    const user = p.addMessage("u2", "user", "Next\nline");
    const hidden = new SyntheticElement("SPAN", {}, "Hidden value");
    hidden.hidden = true;
    user.append(hidden);
    p.addMessage("a2", "assistant", "Answer", "u2");
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
    });
    p.addMessage("a2", "assistant", "Duplicate", "u2");
    expect(await p.observe(observeInput)).toMatchObject({
      code: "PHYSICAL_ANCHOR_AMBIGUOUS",
    });
  });
  it("ambiguous fresh digests, stale retained IDs, changed operations/views/parents refuse", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("u3", "user", "Next\nline");
    expect(await p.observe(observeInput)).toMatchObject({
      code: "PHYSICAL_CORRELATION_AMBIGUOUS",
    });
    expect(
      await p.observe({
        ...observeInput,
        correlation: { userTurnId: "u1", replyId: "a1" },
      }),
    ).toMatchObject({ code: "PHYSICAL_CORRELATION_MISMATCH" });
    expect(
      await p.observe({ ...observeInput, operationId: "other" }),
    ).toMatchObject({ code: "PHYSICAL_OPERATION_MISMATCH" });
    expect(
      await p.observe({
        ...observeInput,
        binding: { ...p.binding, viewGeneration: 2 },
      }),
    ).toMatchObject({ code: "PHYSICAL_BINDING_STALE" });
    const q = page();
    const sub = await q.submit();
    q.addMessage("u2", "user", "Next\nline");
    q.addMessage("a2", "assistant", "Answer", "foreign");
    expect(await q.observe(sub.observeInput)).toMatchObject({
      code: "PHYSICAL_PARENT_MISMATCH",
    });
  });
  it("observation crypto race guards DOM text and binding; no effects", async () => {
    for (const mutate of ["text", "url"]) {
      const p = page();
      const { observeInput } = await p.submit();
      const user = p.addMessage("u2", "user", "Next\nline");
      p.onHash(() => {
        if (mutate === "text") user.innerText = "Different";
        else p.location.href = home;
      });
      expect(await p.observe(observeInput)).toMatchObject({ state: "refused" });
      expect(p.effects.send).toBe(1);
    }
  });
  it("explicit synthetic settled segments decode through production reducer, remount and mutation guard", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    const assistant = p.addMessage("a2", "assistant", "Stable", "u2", false);
    const root = assistant.querySelector(".markdown")!;
    root.attributes["data-farol-source-profile"] =
      "farol-controlled-settled-segments-v1";
    root.children[0]!.attributes["data-segment-id"] = "segment-1";
    root.children[0]!.attributes["data-segment-state"] = "settled";
    expect(await p.observe(observeInput)).toMatchObject({
      code: "PHYSICAL_CONTENT_UNQUALIFIED",
    });
    const qualified = observeInput;
    const first = await p.observe(
      qualified,
      "farol-controlled-settled-segments-v1",
    );
    if (first.state !== "observed") throw new Error("Fixture failed");
    expect(first.frame).toMatchObject({
      terminal: false,
      messages: [
        {
          id: "a2",
          complete: false,
          segments: [{ id: "segment-1", text: "Stable", complete: true }],
        },
      ],
    });
    const reducer = new ChatGptPublicTurn("u2", "a2", 0);
    reducer.observe(first.frame, 0);
    expect(reducer.observe(first.frame, 1).answer).toContain("Stable");
    const remounted = p.remount("a2");
    const same = await p.observe(
      { ...qualified, correlation: { userTurnId: "u2", replyId: "a2" } },
      "farol-controlled-settled-segments-v1",
    );
    if (same.state !== "observed") throw new Error("Fixture failed");
    expect(same.frame).toEqual(first.frame);
    remounted.querySelector(".markdown")!.children[0]!.innerText = "Mutation";
    const changed = await p.observe(
      qualified,
      "farol-controlled-settled-segments-v1",
    );
    if (changed.state !== "observed") throw new Error("Fixture failed");
    expect(() => reducer.observe(changed.frame, 2)).toThrow();
  });
  it("uses the explicitly selected content profile for first observation and follow Verify/Send", async () => {
    const p = page({
      isHome: true,
      e2eOrigin: "http://127.0.0.1:12345",
      contentProfile: "farol-controlled-settled-segments-v1",
    });
    const { observeInput } = await p.submit("First");
    p.addMessage("u1", "user", "First");
    const answer = p.addMessage("a1", "assistant", "Settled first", "u1");
    const root = answer.querySelector(".markdown")!;
    root.attributes["data-farol-source-profile"] =
      "farol-controlled-settled-segments-v1";
    root.children[0]!.attributes["data-segment-id"] = "first-segment";
    root.children[0]!.attributes["data-segment-state"] = "settled";
    const binding: PhysicalBinding = {
      ...p.binding,
      phase: "conversation",
      conversationId,
      url: `http://127.0.0.1:12345/chatgpt/c/${conversationId}`,
    };
    p.location.href = binding.url;
    const firstInput = { ...observeInput, binding };
    for (const profile of [undefined, "message-anchors-v1"] as const) {
      expect(
        await p.run(
          physicalObserveScript(firstInput, profile, {
            e2eOrigin: p.policy.e2eOrigin,
          }),
        ),
      ).toMatchObject({
        state: "refused",
        code: "PHYSICAL_CONTENT_UNQUALIFIED",
      });
    }
    expect(await p.observe(firstInput, "message-anchors-v1")).toMatchObject({
      state: "refused",
      code: "PHYSICAL_POLICY_INVALID",
    });
    expect(
      await p.observe(firstInput, "unqualified" as PhysicalPageContentProfile),
    ).toMatchObject({ state: "refused", code: "PHYSICAL_INPUT_INVALID" });
    const first = await p.observe(firstInput);
    expect(first).toMatchObject({
      state: "observed",
      frame: {
        terminal: true,
        messages: [
          {
            id: "a1",
            complete: true,
            segments: [
              { id: "first-segment", text: "Settled first", complete: true },
            ],
          },
        ],
      },
    });
    p.draft("");
    const follow: VerifyInput = {
      ...p.input,
      binding,
      operationId: "follow",
      previous: { userTurnId: "u1", replyId: "a1" },
      intentDigest: "follow-envelope",
    };
    const verified = await p.verify(follow);
    expect(verified.witness.previous).toEqual(follow.previous);
    expect(
      await p.sendWitness(verified.witness, "Follow", follow),
    ).toMatchObject({ state: "submitted" });
    expect(p.effects.send).toBe(2);
    p.addMessage("u2", "user", "Follow", "a1");
    const secondAnswer = p.addMessage(
      "a2",
      "assistant",
      "Settled follow",
      "u2",
    );
    const secondRoot = secondAnswer.querySelector(".markdown")!;
    secondRoot.attributes["data-farol-source-profile"] =
      "farol-controlled-settled-segments-v1";
    secondRoot.children[0]!.attributes["data-segment-id"] = "follow-segment";
    secondRoot.children[0]!.attributes["data-segment-state"] = "settled";
    const second = await p.observe({
      binding,
      operationId: follow.operationId,
      deadlineMillis: follow.deadlineMillis,
      submission: {
        originBinding: binding,
        operationId: follow.operationId,
        evidenceId: verified.witness.evidenceId,
        intentDigest: follow.intentDigest,
        promptDigest: digest("Follow"),
        baselineUserIds: verified.baselineUserIds,
        previous: follow.previous,
        selection: follow.selection,
      },
      correlation: { userTurnId: null, replyId: null },
    });
    expect(second).toMatchObject({
      state: "observed",
      frame: {
        terminal: true,
        messages: [
          {
            id: "a2",
            complete: true,
            segments: [
              { id: "follow-segment", text: "Settled follow", complete: true },
            ],
          },
        ],
      },
    });
  });
  it.each([
    [undefined, "PHYSICAL_CONTENT_UNQUALIFIED"],
    ["message-anchors-v1", "PHYSICAL_CONTENT_UNQUALIFIED"],
    ["unqualified", "PHYSICAL_POLICY_INVALID"],
  ] as const)(
    "refuses controlled previous history under profile %s without effects",
    async (profile, code) => {
      const p = page({
        e2eOrigin: "http://127.0.0.1:12345",
        ...(profile
          ? { contentProfile: profile as PhysicalPageContentProfile }
          : {}),
      });
      const root = p.root.querySelector(".markdown")!;
      root.attributes["data-farol-source-profile"] =
        "farol-controlled-settled-segments-v1";
      root.children[0]!.attributes["data-segment-id"] = "previous-segment";
      root.children[0]!.attributes["data-segment-state"] = "settled";
      const before = { ...p.effects };
      expect(
        await p.run(physicalVerifySendScript(p.input, p.policy)),
      ).toMatchObject({ state: "refused", code });
      expect(p.effects).toEqual(before);
    },
  );
  it.each([
    ["unknown-profile", "PHYSICAL_CONTENT_UNQUALIFIED"],
    ["pending-segment", "PHYSICAL_PREVIOUS_UNSETTLED"],
    ["pending-article", "PHYSICAL_PREVIOUS_UNSETTLED"],
    ["crossed-parent", "PHYSICAL_PARENT_MISMATCH"],
    ["wrong-reply", "PHYSICAL_PREVIOUS_MISMATCH"],
  ] as const)(
    "keeps previous history guards with the explicit controlled profile: %s",
    async (change, code) => {
      const p = page({
        e2eOrigin: "http://127.0.0.1:12345",
        contentProfile: "farol-controlled-settled-segments-v1",
      });
      const answer = p.root.querySelector('[data-message-id="a1"]')!;
      const root = answer.querySelector(".markdown")!;
      root.attributes["data-farol-source-profile"] =
        "farol-controlled-settled-segments-v1";
      root.children[0]!.attributes["data-segment-id"] = "previous-segment";
      root.children[0]!.attributes["data-segment-state"] = "settled";
      let input = p.input;
      if (change === "unknown-profile")
        root.attributes["data-farol-source-profile"] = "unqualified";
      if (change === "pending-segment")
        root.children[0]!.attributes["data-segment-state"] = "pending";
      if (change === "pending-article")
        answer.attributes["data-is-streaming"] = "true";
      if (change === "crossed-parent")
        answer.attributes["data-parent-message-id"] = "other-user";
      if (change === "wrong-reply")
        input = {
          ...input,
          previous: { userTurnId: "u1", replyId: "other-reply" },
        };
      const before = { ...p.effects };
      expect(
        await p.run(physicalVerifySendScript(input, p.policy)),
      ).toMatchObject({ state: "refused", code });
      expect(p.effects).toEqual(before);
    },
  );
  it("refuses Send if the selected profile changes after Verify", async () => {
    const p = page({
      e2eOrigin: "http://127.0.0.1:12345",
      contentProfile: "farol-controlled-settled-segments-v1",
    });
    const verified = await p.verify();
    const before = { ...p.effects };
    const result = await p.run(
      physicalSendScript(
        {
          binding: p.binding,
          operationId: p.input.operationId,
          deadlineMillis: p.input.deadlineMillis,
          intentDigest: p.input.intentDigest,
          witness: verified.witness,
          prompt: "Follow",
        },
        { ...p.policy, contentProfile: "message-anchors-v1" },
      ),
    );
    expect(result).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_WITNESS_INVALID",
    });
    expect(p.effects).toEqual(before);
  });
  it("ordinary pending prose stays buffered; unknown profile/hidden rich content never commits", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    const assistant = p.addMessage("a2", "assistant", "Pending", "u2", false);
    const first = await p.observe(observeInput);
    if (first.state !== "observed") throw new Error("Fixture failed");
    expect(first.frame?.messages[0]).not.toHaveProperty("segments");
    const reducer = new ChatGptPublicTurn("u2", "a2", 0);
    expect(reducer.observe(first.frame, 100000).answer).toBe("");
    const root = assistant.querySelector(".markdown")!;
    root.append(new SyntheticElement("IMG"));
    expect(await p.observe(observeInput)).toMatchObject({
      state: "refused",
      code: "PHYSICAL_SOURCE_UNQUALIFIED",
    });
    root.children.at(-1)!.hidden = true;
    expect(await p.observe(observeInput)).toMatchObject({ state: "observed" });
    root.attributes["data-farol-source-profile"] = "unqualified";
    expect(await p.observe(observeInput)).toMatchObject({
      code: "PHYSICAL_CONTENT_UNQUALIFIED",
    });
  });
  it("Cancel requests one scoped Stop after the required inline connector chip clears", async () => {
    const p = page({ editable: true });
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Pending", "u2", false);
    p.connector.remove();
    p.stop.hidden = false;
    expect(observeInput.submission.selection.requiredControls.connector).toBe(
      true,
    );
    expect(await p.observe(observeInput)).toMatchObject({
      state: "observed",
      correlation: { userTurnId: "u2", replyId: "a2" },
      frame: { terminal: false },
      observed: { connectorLabel: { state: "unknown", code: "not-exposed" } },
    });
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "requested",
      binding: p.binding,
      code: "PHYSICAL_CANCEL_ACKNOWLEDGED",
    });
    expect(p.effects.stop).toBe(1);
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_SPENT",
    });
    expect(p.effects.stop).toBe(1);
    expect(p.effects.send).toBe(1);
  });
  it("Cancel proves already terminal without Stop after the required inline connector chip clears", async () => {
    const p = page({ editable: true });
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Answer", "u2");
    p.connector.remove();
    expect(observeInput.submission.selection.requiredControls.connector).toBe(
      true,
    );
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "already-terminal",
      proof: {
        binding: p.binding,
        correlation: { userTurnId: "u2", replyId: "a2" },
        frame: { userId: "u2", terminal: true },
      },
    });
    expect(p.effects.stop).toBe(0);
    expect(p.effects.send).toBe(1);
  });
  it("no Stop without full terminal proof is unknown; one acknowledged Stop is requested", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Pending", "u2", false);
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_STOP_UNAVAILABLE",
    });
    expect(p.effects.stop).toBe(0);
    p.stop.hidden = false;
    expect(await p.cancel(observeInput)).toMatchObject({ state: "requested" });
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_SPENT",
    });
    expect(p.effects.stop).toBe(1);
  });
  it("correlated current user can be stopped once before the first assistant renders", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.stop.hidden = false;
    expect(await p.cancel(observeInput)).toMatchObject({ state: "requested" });
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_CANCEL_SPENT",
    });
    expect(p.effects.stop).toBe(1);
  });
  it.each([false, true])(
    "Stop immediate terminal=%s uses actual scoped full frame; throws stay unknown",
    async (terminal) => {
      const p = page();
      const { observeInput } = await p.submit();
      p.addMessage("u2", "user", "Next\nline");
      const assistant = p.addMessage("a2", "assistant", "Answer", "u2", false);
      p.stop.hidden = false;
      p.onStop(() => {
        if (!terminal) throw new Error("private stop error");
        assistant.attributes["data-is-streaming"] = "false";
        assistant
          .closest("article")!
          .querySelector('[data-testid="copy-turn-action-button"]')!.hidden =
          false;
      });
      expect(await p.cancel(observeInput)).toMatchObject(
        terminal
          ? {
              state: "confirmed-terminal",
              proof: {
                correlation: { userTurnId: "u2", replyId: "a2" },
                frame: { terminal: true },
              },
            }
          : { state: "unknown", code: "PHYSICAL_CANCEL_UNKNOWN" },
      );
      expect(await p.cancel(observeInput)).toMatchObject({
        state: terminal ? "already-terminal" : "unknown",
      });
      expect(p.effects.stop).toBe(1);
    },
  );
  it("terminal needs all articles; unrelated Stop never proves completion or cancels another turn", async () => {
    const p = page();
    const { observeInput } = await p.submit();
    p.addMessage("u2", "user", "Next\nline");
    p.addMessage("a2", "assistant", "Answer", "u2");
    const unrelated = new SyntheticElement("BUTTON", {
      "data-testid": "stop-button",
    });
    p.root.append(unrelated);
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "already-terminal",
    });
    expect(p.effects.stop).toBe(0);
    p.addMessage("a3", "assistant", "Still pending", "a2", false);
    expect(await p.cancel(observeInput)).toMatchObject({
      state: "unknown",
      code: "PHYSICAL_STOP_UNAVAILABLE",
    });
    p.stop.hidden = false;
    p.addMessage("u3", "user", "Other turn");
    expect(await p.cancel(observeInput)).toMatchObject({
      code: "PHYSICAL_CANCEL_TURN_STALE",
    });
    expect(p.effects.stop).toBe(0);
  });
  it("projects HOST-held pins out of every factory and raw receipt; readonly scripts carry no prompt", async () => {
    const p = page();
    const pins = {
      ...declaration,
      provider: "private-provider-canary",
      alias: "private-alias-canary",
      accountId: "private-account-canary",
      modelId: "private-model-canary",
      effort: "private-effort-canary",
      mode: "private-mode-canary",
      connectorId: "private-connector-canary",
      connectorGrantId: "private-grant-canary",
    };
    const privateSelection: PhysicalPageSelection = {
      ...selection,
      requested: pins,
      admitted: { ...pins, accountId: "private-admitted-account" },
      resolved: {
        selection: { ...pins, accountId: "private-resolved-account" },
        configSHA256: "b".repeat(64),
        translationId: "private-translation-canary",
      },
    };
    const candidate = { ...p.input, selection: privateSelection };
    const verifySource = physicalVerifySendScript(candidate);
    const verified = await p.verify(candidate);
    const prompt = "private-transient-prompt-canary";
    const observation: PhysicalPageObservation = {
      binding: p.binding,
      operationId: candidate.operationId,
      deadlineMillis: candidate.deadlineMillis,
      submission: {
        originBinding: p.binding,
        operationId: candidate.operationId,
        evidenceId: verified.evidenceId,
        intentDigest: candidate.intentDigest,
        promptDigest: digest(prompt),
        baselineUserIds: verified.baselineUserIds,
        previous: candidate.previous,
        selection: privateSelection,
      },
      correlation: { userTurnId: null, replyId: null },
    };
    const readonlySources = [
      physicalPrepareProbeScript(p.binding),
      verifySource,
      physicalObserveScript(observation),
      physicalCancelScript(observation),
    ];
    const sendSource = physicalSendScript({
      binding: p.binding,
      operationId: candidate.operationId,
      deadlineMillis: candidate.deadlineMillis,
      intentDigest: candidate.intentDigest,
      witness: verified.witness,
      prompt,
    });
    for (const source of [...readonlySources, sendSource]) {
      for (const value of [
        ...Object.values(pins).filter(
          (v): v is string => typeof v === "string",
        ),
        "private-admitted-account",
        "private-resolved-account",
        "private-translation-canary",
        "b".repeat(64),
      ])
        expect(source).not.toContain(value);
    }
    for (const source of readonlySources) expect(source).not.toContain(prompt);
    expect(sendSource).toContain(prompt);
    const rawVerify = await p.run<PhysicalPageVerifyResponse>(verifySource);
    expect(rawVerify).toMatchObject({
      state: "witnessed",
      observed: { modeLabel: { state: "unknown" } },
    });
    expect(rawVerify).not.toHaveProperty("witness");
    expect(rawVerify).not.toHaveProperty("selection");
    expect(rawVerify).not.toHaveProperty("account");
    expect(JSON.stringify(rawVerify)).not.toContain("private-account");
    expect(
      await p.sendWitness(verified.witness, prompt, candidate),
    ).toMatchObject({ state: "submitted" });
    const rawObserve = await p.observe(observation);
    expect(rawObserve).toMatchObject({
      state: "observed",
      observed: { modelLabel: { state: "observed" } },
      sourceProfile: "message-anchors-v1",
    });
    expect(rawObserve).not.toHaveProperty("selection");
    const memory = await p.run<string>(
      `JSON.stringify(globalThis[Symbol.for("farol.physical-page.v1")], (_key, value) => value instanceof Map ? [...value.values()] : value)`,
    );
    expect(memory).not.toContain(prompt);
    expect(memory).not.toContain("private-account");
  });
  it("malformed serialization is content-free and never runs page DOM code", async () => {
    const p = page();
    expect(
      await p.run(
        physicalVerifySendScript({
          ...p.input,
          intentDigest: "private\ninvalid",
        }),
      ),
    ).toEqual({ state: "refused", code: "PHYSICAL_INPUT_INVALID" });
    expect(
      (await p.verify({ ...p.input, deadlineMillis: 1 })).witness
        .deadlineMillis,
    ).toBe(1); // Host owns deadline enforcement.
    expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
  });
});

describe("account-bound page witness: offline snapshot mechanics only", () => {
  it.each([null, "http://127.0.0.1:4317"])(
    "observes independently twice and sends once at %s",
    async (e2eOrigin) => {
      const p = page({ isHome: true, account: true, e2eOrigin });
      const verified = await p.verify();
      expect(verified.account).toMatchObject({
        state: "observed",
        source: "provider-session-v1",
        documentUrl: p.binding.url,
      });
      expect(JSON.stringify(verified)).not.toContain("fixture-account-A");
      expect(JSON.stringify(verified)).not.toContain(
        "never-exported-auth-canary",
      );
      expect(p.account.requests()).toBe(1);
      expect(await p.sendWitness(verified.witness)).toMatchObject({
        state: "submitted",
      });
      expect(p.account.requests()).toBe(2);
      expect(p.effects.send).toBe(1);
      expect(await p.sendWitness(verified.witness)).toMatchObject({
        state: "not-sent",
        code: "PHYSICAL_WITNESS_INVALID",
      });
      expect(p.account.requests()).toBe(2);
      expect(p.effects.send).toBe(1);
    },
  );
  it.each(["account", "user"])(
    "refuses changed %s despite unchanged document and controls",
    async (changed) => {
      const p = page({ account: true });
      const verified = await p.verify();
      p.account.change(
        changed === "account" ? "fixture-account-B" : "fixture-account-A",
        changed === "user" ? "fixture-user-B" : "fixture-user-A",
      );
      expect(await p.sendWitness(verified.witness)).toMatchObject({
        state: "not-sent",
        code: "PHYSICAL_ACCOUNT_CHANGED",
      });
      expect(p.account.requests()).toBe(2);
      expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
      p.account.change("fixture-account-A", "fixture-user-A");
      expect(await p.sendWitness(verified.witness)).toMatchObject({
        state: "not-sent",
        code: "PHYSICAL_WITNESS_INVALID",
      });
      expect(p.account.requests()).toBe(2);
    },
  );
  it("refuses unavailable current account without insertion or replay", async () => {
    const p = page({ account: true });
    const verified = await p.verify();
    p.account.change(null);
    expect(await p.sendWitness(verified.witness)).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_ACCOUNT_UNAVAILABLE",
    });
    expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
  });
  it("does not mint a witness from a missing account", async () => {
    const p = page({ account: true });
    p.account.change(null);
    expect(
      await p.run(physicalVerifySendScript(p.input, p.policy)),
    ).toMatchObject({ state: "refused", code: "PHYSICAL_ACCOUNT_UNAVAILABLE" });
    expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
  });
  it("cannot drop the selected account observation profile at Send", async () => {
    const p = page({ account: true });
    const { witness } = await p.verify();
    expect(
      await p.run(physicalSendScript({ ...p.input, witness, prompt: "text" })),
    ).toMatchObject({ state: "not-sent", code: "PHYSICAL_WITNESS_INVALID" });
    expect(p.effects.send).toBe(0);
    expect(p.account.requests()).toBe(1);
  });
  it("cannot replace the page-held principal with a caller-supplied observation", async () => {
    const p = page({ account: true });
    const { witness } = await p.verify();
    if (witness.account?.state !== "observed")
      throw new Error("missing fixture observation");
    const changed = {
      ...witness,
      account: { ...witness.account, accountKey: "b".repeat(64) },
    };
    expect(await p.sendWitness(changed)).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_WITNESS_INVALID",
    });
    expect(p.effects.send).toBe(0);
    expect(p.account.requests()).toBe(1);
  });
  it("rechecks deadline after the account fetch before insertion", async () => {
    const p = page({ account: true });
    const { witness } = await p.verify();
    p.account.beforeFetch(() => p.account.advance(120_000));
    expect(await p.sendWitness(witness)).toMatchObject({
      state: "not-sent",
      code: "PHYSICAL_ACCOUNT_DEADLINE",
    });
    expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
  });
  it("rechecks controls after the final account fetch", async () => {
    const p = page({ account: true });
    const { witness } = await p.verify();
    p.account.beforeFetch(() => {
      p.model.innerText = "Different model";
    });
    expect(await p.sendWitness(witness)).toMatchObject({ state: "not-sent" });
    expect(Object.values(p.effects).every((n) => n === 0)).toBe(true);
  });
  it("records the snapshot limit when a synchronous input handler changes account", async () => {
    const p = page({ account: true });
    const { witness } = await p.verify();
    let acceptedAccount = "";
    p.onEvent(() => p.account.change("fixture-account-B"));
    p.onSend(() => {
      acceptedAccount = "fixture-account-B";
    });
    // This deliberately demonstrates the remaining provider-binding boundary.
    // A session snapshot is not proof of which account accepts the next Send.
    expect(await p.sendWitness(witness)).toMatchObject({ state: "submitted" });
    expect(acceptedAccount).toBe("fixture-account-B");
    expect(p.effects.send).toBe(1);
  });
});
