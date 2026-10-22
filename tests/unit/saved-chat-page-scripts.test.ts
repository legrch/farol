import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  savedChatFollowUpScript,
  type SavedChatFollowUpRequest,
  type SavedChatFollowUpResult,
  savedChatInsertScript,
  savedChatProofScript,
  savedChatReadinessScript,
  savedChatSubmitScript,
} from "../../src/apps/desktop/saved-chat-page-scripts";

import { ChatGptPublicTurn } from "../../src/apps/desktop/chatgpt-public-turn";

const home = "https://chatgpt.com/";
const conversation =
  "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function page() {
  class Element {
    innerText = "";
    textContent = "";
    href = "";
    disabled = false;
    visible = true;
    focus() {}
    dispatchEvent() {}
    querySelectorAll(_selector: string): Element[] {
      return [];
    }
    getBoundingClientRect() {
      return this.visible
        ? { width: 200, height: 40 }
        : { width: 0, height: 0 };
    }
    getAttribute(_name: string) {
      return null;
    }
  }
  class TextArea extends Element {
    private content = "";
    get value() {
      return this.content;
    }
    set value(value: string) {
      this.content = value;
    }
  }
  let clicks = 0;
  const location = { href: home };
  const messages: Element[] = [];
  const links: Element[] = [];
  const unrelatedLinks: Element[] = [];
  const historyRoot = new Element();
  historyRoot.querySelectorAll = () => links;
  const composer = new TextArea();
  class Button extends Element {
    click() {
      clicks += 1;
      location.href = conversation;
      const user = new Element();
      user.innerText = composer.value;
      messages.push(user);
    }
  }
  const send = new Button();
  const document = {
    querySelector(selector: string) {
      if (selector === "#prompt-textarea") return composer;
      if (selector === '[data-testid="send-button"]') return send;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") return [send];
      if (selector.startsWith('[data-testid="history"]')) return [historyRoot];
      if (selector === "a[href]") return [...links, ...unrelatedLinks];
      if (selector.includes("data-message-author-role")) return messages;
      return [];
    },
    createTextNode(text: string) {
      return { textContent: text };
    },
  };
  const context = {
    location,
    document,
    URL,
    TextEncoder,
    crypto: webcrypto,
    HTMLElement: Element,
    HTMLTextAreaElement: TextArea,
    HTMLButtonElement: Button,
    InputEvent: class {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  return {
    context,
    location,
    composer,
    messages,
    links,
    unrelatedLinks,
    historyRoot,
    clicks: () => clicks,
    addHistory(title: string, href = conversation, inHistory = true) {
      const link = new Element();
      link.href = href;
      link.innerText = title;
      (inHistory ? links : unrelatedLinks).push(link);
    },
    run: async (script: string) =>
      vm.runInNewContext(script, context) as Promise<unknown>,
  };
}

describe("saved ChatGPT page scripts on a synthetic normal surface", () => {
  it("inserts exact text, hashes the draft and clicks Send only once", async () => {
    const fixture = page();
    expect(await fixture.run(savedChatReadinessScript(home))).toEqual({
      ready: true,
    });
    expect(
      await fixture.run(savedChatInsertScript(home, "Hello\nworld")),
    ).toEqual({
      inserted: true,
    });
    expect(fixture.composer.value).toBe("Hello\nworld");
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Hello\nworld"))),
    ).toEqual({
      clicked: true,
    });
    expect(fixture.clicks()).toBe(1);
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Hello\nworld"))),
    ).toEqual({
      clicked: false,
    });
    expect(fixture.clicks()).toBe(1);
  });

  it("requires the original user message and one exact history link after reopen", async () => {
    const fixture = page();
    await fixture.run(savedChatInsertScript(home, "First"));
    await fixture.run(savedChatSubmitScript(home, digest("First")));
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.addHistory(
      "Title",
      "https://other.example/c/12345678-1234-4123-8123-123456789abc",
    );
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.links.length = 0;
    fixture.addHistory("Title", conversation, false);
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.addHistory("Different title");
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: true, titleVerified: false });
    fixture.links.length = 0;
    fixture.addHistory("Title");
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: true, titleVerified: true });
    fixture.messages[0]!.innerText = "Changed";
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
  });

  it("refuses a changed draft, temporary URL, or navigation before the click", async () => {
    const fixture = page();
    await fixture.run(savedChatInsertScript(home, "First"));
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Other"))),
    ).toEqual({
      clicked: false,
    });
    fixture.location.href = `${home}?temporary-chat=true`;
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("First"))),
    ).toEqual({
      clicked: false,
    });
    fixture.location.href = conversation;
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("First"))),
    ).toEqual({
      clicked: false,
    });
    expect(fixture.clicks()).toBe(0);
  });
});

// Synthetic DOM API conformance only; no Chromium, account or provider proof.
class FollowUpElement {
  readonly nodeType = 1;
  parentElement: FollowUpElement | null = null;
  hidden = false;
  disabled = false;
  children: FollowUpElement[] = [];
  childNodes: (FollowUpElement | { nodeType: number; nodeValue: string })[] =
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
    return this.text + this.children.map((child) => child.innerText).join("");
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
  append(...children: FollowUpElement[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
      this.childNodes.push(child);
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
          if (value === null) return false;
          return (
            match[2] === undefined ||
            (match[2] === "="
              ? value === match[3]
              : match[2] === "^="
                ? value.startsWith(match[3]!)
                : value.includes(match[3]!))
          );
        })
      );
    });
  }
  closest(selector: string): FollowUpElement | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  querySelectorAll(selector: string): FollowUpElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  contains(element: FollowUpElement): boolean {
    return (
      element === this || this.children.some((child) => child.contains(element))
    );
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
      this.parentElement.childNodes = this.parentElement.childNodes.filter(
        (child) => child !== this,
      );
    }
  }
  cloneNode(): FollowUpElement {
    const clone = new FollowUpElement(
      this.tagName,
      { ...this.attributes },
      this.text,
    );
    clone.append(...this.children.map((child) => child.cloneNode()));
    return clone;
  }
  focus() {}
  dispatchEvent() {}
}

function followUpPage(editable = false) {
  class TextArea extends FollowUpElement {
    private draft = "";
    get value() {
      return this.draft;
    }
    set value(text: string) {
      this.draft = text;
    }
  }
  let clicks = 0;
  let onClick = () => {};
  class Button extends FollowUpElement {
    click() {
      clicks += 1;
      onClick();
    }
  }
  const root = new FollowUpElement("MAIN");
  const form = new FollowUpElement("FORM");
  const location = { href: conversation };
  const composer = editable
    ? new FollowUpElement("DIV", {
        id: "prompt-textarea",
        contenteditable: "true",
      })
    : new TextArea("TEXTAREA", { id: "prompt-textarea" });
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
  const connector = new FollowUpElement(
    "SPAN",
    {
      "data-testid": "composer-app-chip",
      "data-plugin-id": "plugin_asdk_app_TEST",
      "data-app-name": "Farol DEV",
    },
    "Farol DEV",
  );
  const send = new Button("BUTTON", { "data-testid": "send-button" });
  form.append(composer, effort, connector, send);
  root.append(model, form);
  const addMessage = (
    id: string,
    role: string,
    text: string,
    parentId: string | null = null,
  ) => {
    const element = new FollowUpElement(
      "DIV",
      {
        "data-message-id": id,
        "data-message-author-role": role,
        ...(parentId ? { "data-parent-message-id": parentId } : {}),
        ...(role === "assistant" ? { "data-message-channel": "final" } : {}),
      },
      role === "user" ? text : "",
    );
    const article = new FollowUpElement("ARTICLE");
    article.append(element);
    if (role === "assistant") {
      const markdown = new FollowUpElement("DIV", { class: "markdown" });
      markdown.append(new FollowUpElement("P", {}, text));
      element.append(markdown);
      article.append(
        new Button("BUTTON", { "data-testid": "copy-turn-action-button" }),
      );
    }
    root.append(article);
    return element;
  };
  addMessage("u1", "user", "Earlier");
  addMessage("a1", "assistant", "same answer", "u1");
  const document = {
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    execCommand: (_command: string, _ui: boolean, text: string) => {
      composer.innerText = text;
      return true;
    },
  };
  const context = vm.createContext({
    document,
    location,
    URL,
    TextEncoder,
    crypto: webcrypto,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    HTMLElement: FollowUpElement,
    HTMLTextAreaElement: TextArea,
    HTMLButtonElement: Button,
    InputEvent: class {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  const request: SavedChatFollowUpRequest = {
    binding: {
      conversationId: conversation.split("/").at(-1)!,
      conversationUrl: conversation,
      viewId: "42",
      viewGeneration: 1,
      documentGeneration: 7,
      partition: "persist:farol-app-chatgpt",
    },
    selection: {
      model: "Test model",
      effort: "Light",
      connector: {
        id: "plugin_asdk_app_TEST",
        label: "Farol DEV",
      },
    },
    previous: { userId: "u1", assistantId: "a1" },
    operation: { id: "op2", state: "not-sent" },
    message: "Next",
    digest: digest("Next"),
    evidenceId: null,
    correlation: null,
  };
  let evidenceId: string | null = null;
  return {
    root,
    form,
    composer,
    model,
    effort,
    connector,
    send,
    location,
    request,
    addMessage,
    clicks: () => clicks,
    onClick: (callback: () => void) => {
      onClick = callback;
    },
    run: async (action: "prepare" | "submit" | "observe", input = request) => {
      const result = await (vm.runInContext(
        savedChatFollowUpScript(
          { ...input, evidenceId: input.evidenceId ?? evidenceId },
          action,
        ),
        context,
      ) as Promise<SavedChatFollowUpResult>);
      if (result.state === "prepared") evidenceId = result.evidenceId;
      return result;
    },
  };
}

describe("saved conversation follow-up physical conformance", () => {
  it("checks every Send and correlates the next exact user and assistant in the same chat", async () => {
    const fixture = followUpPage();
    expect(await fixture.run("prepare")).toMatchObject({ state: "prepared" });
    fixture.onClick(() => {
      fixture.composer instanceof FollowUpElement &&
        (fixture.composer.innerText = "");
      fixture.addMessage("u2", "user", "Next");
      fixture.addMessage("a2", "assistant", "same answer", "u2");
    });
    expect(await fixture.run("submit")).toMatchObject({ state: "submitted" });
    expect(fixture.clicks()).toBe(1);
    const result = await fixture.run("observe");
    expect(result).toMatchObject({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: {
        userId: "u2",
        terminal: true,
        messages: [{ id: "a2", text: "same answer" }],
      },
    });
    expect(fixture.location.href).toBe(conversation);
    expect((await fixture.run("submit")).state).not.toBe("submitted");
    expect(fixture.clicks()).toBe(1);
  });

  it.each(["model", "effort", "connector"] as const)(
    "refuses lost %s after preparation with no click",
    async (control) => {
      const fixture = followUpPage();
      expect((await fixture.run("prepare")).state).toBe("prepared");
      fixture[control].hidden = true;
      expect(await fixture.run("submit")).toMatchObject({
        state: "not-sent",
        code: "SAVED_CHAT_SELECTION_UNSUPPORTED",
      });
      expect(fixture.clicks()).toBe(0);
    },
  );

  it.each(["model", "effort"] as const)(
    "refuses a changed %s, duplicate controls and wrong plugin identity",
    async (control) => {
      const fixture = followUpPage();
      await fixture.run("prepare");
      fixture[control].innerText = "Other";
      expect(await fixture.run("submit")).toMatchObject({
        state: "not-sent",
        code: "SAVED_CHAT_SELECTION_MISMATCH",
      });
      fixture[control].innerText = fixture.request.selection[control];
      fixture.connector.attributes["data-plugin-id"] = "plugin_asdk_app_OTHER";
      expect(await fixture.run("submit")).toMatchObject({
        state: "not-sent",
        code: "SAVED_CHAT_SELECTION_MISMATCH",
      });
      fixture.connector.attributes["data-plugin-id"] =
        fixture.request.selection.connector.id;
      fixture.form.append(
        new FollowUpElement(
          "BUTTON",
          { "aria-haspopup": "menu", "data-tone": "neutral" },
          "Light",
        ),
      );
      expect(await fixture.run("submit")).toMatchObject({
        state: "not-sent",
        code: "SAVED_CHAT_SELECTION_AMBIGUOUS",
      });
      expect(fixture.clicks()).toBe(0);
    },
  );

  it("requires the exact settled pair and refuses a busy, temporary or different conversation", async () => {
    const fixture = followUpPage();
    const changed = {
      ...fixture.request,
      previous: { userId: "u1", assistantId: "other" },
    };
    expect(await fixture.run("prepare", changed)).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_TURN_UNSETTLED",
    });
    const stop = new FollowUpElement("BUTTON", {
      "data-testid": "stop-button",
    });
    fixture.form.append(stop);
    expect(await fixture.run("prepare")).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_TURN_UNSETTLED",
    });
    stop.hidden = true;
    fixture.location.href = `${conversation}?temporary-chat=true`;
    expect((await fixture.run("prepare")).state).toBe("not-sent");
    fixture.location.href = conversation.replace("12345678", "87654321");
    expect((await fixture.run("prepare")).state).toBe("not-sent");
    expect(fixture.clicks()).toBe(0);
  });

  it.each(["unknown", "submitted"] as const)(
    "never inserts or clicks for original operation state %s",
    async (state) => {
      const fixture = followUpPage();
      const request = { ...fixture.request, operation: { id: "op2", state } };
      expect((await fixture.run("prepare", request)).state).not.toBe(
        "prepared",
      );
      expect((await fixture.run("submit", request)).state).not.toBe(
        "submitted",
      );
      expect(fixture.clicks()).toBe(0);
    },
  );

  it("latches before clicking even when the acknowledgement is lost, with no retry or replacement operation", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    fixture.onClick(() => {
      throw new Error("Synthetic acknowledgement loss");
    });
    expect(await fixture.run("submit")).toMatchObject({ state: "unknown" });
    expect((await fixture.run("submit")).state).not.toBe("submitted");
    const replacement = {
      ...fixture.request,
      operation: { id: "replacement", state: "not-sent" as const },
    };
    expect((await fixture.run("prepare", replacement)).state).not.toBe(
      "prepared",
    );
    expect(fixture.clicks()).toBe(1);
  });

  it("checks selection again after the asynchronous preparation digest", async () => {
    const fixture = followUpPage();
    const pending = fixture.run("prepare");
    fixture.connector.hidden = true;
    expect(await pending).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_SELECTION_UNSUPPORTED",
    });
    expect(fixture.clicks()).toBe(0);
  });

  it("preserves an editable app chip and refuses a draft or remounted composer", async () => {
    const fixture = followUpPage(true);
    expect((await fixture.run("prepare")).state).toBe("prepared");
    expect(fixture.connector.parentElement).toBe(fixture.form);
    const replacement = new FollowUpElement(
      "DIV",
      { id: "prompt-textarea", contenteditable: "true" },
      "Next",
    );
    fixture.composer.attributes.id = "old-composer";
    fixture.form.append(replacement);
    expect(await fixture.run("submit")).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_DRAFT_CHANGED",
    });
    expect(fixture.clicks()).toBe(0);
    const draft = followUpPage(true);
    draft.composer.innerText = "Owner draft";
    expect(await draft.run("prepare")).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_DRAFT_PRESENT",
    });
    expect(draft.composer.innerText).toBe("Owner draft");
  });

  it("keeps logical identities and emits repeated equal output once through the existing reader after remount", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    await fixture.run("submit");
    fixture.addMessage("u2", "user", "Next");
    fixture.addMessage("a2", "assistant", "same answer", "u2");
    fixture.addMessage("a3", "assistant", "same answer", "a2");
    const stop = new FollowUpElement("BUTTON", {
      "data-testid": "stop-button",
    });
    fixture.form.append(stop);
    const turn = new ChatGptPublicTurn("u2", "a2", 0);
    const first = await fixture.run("observe");
    if (first.state !== "observed")
      throw new Error("Expected correlated frame");
    expect(turn.observe(first.frame, 1).items.map((item) => item.id)).toEqual([
      "a2",
      "a3",
    ]);
    fixture.root.children = fixture.root.children.filter(
      (element) =>
        !element.querySelector('[data-message-id="a2"]') &&
        !element.querySelector('[data-message-id="a3"]'),
    );
    fixture.addMessage("a2", "assistant", "same answer", "u2");
    fixture.addMessage("a3", "assistant", "same answer", "a2");
    const next = await fixture.run("observe", {
      ...fixture.request,
      correlation: { userId: "u2", assistantId: "a2" },
    });
    if (next.state !== "observed") throw new Error("Expected retained frame");
    expect(turn.observe(next.frame, 2).items).toEqual([]);
    stop.hidden = true;
    const final = await fixture.run("observe", {
      ...fixture.request,
      correlation: { userId: "u2", assistantId: "a2" },
    });
    if (final.state !== "observed") throw new Error("Expected terminal frame");
    expect(turn.observe(final.frame, 3)).toMatchObject({
      completed: true,
      items: [],
    });
    expect(fixture.clicks()).toBe(1);
  });

  it("does not infer a missing retained user from another equal prompt, and refuses duplicate IDs or wrong parents", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    await fixture.run("submit");
    fixture.addMessage("u3", "user", "Next");
    fixture.addMessage("a3", "assistant", "same answer", "u3");
    expect(
      await fixture.run("observe", {
        ...fixture.request,
        correlation: { userId: "u2", assistantId: "a2" },
      }),
    ).toMatchObject({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
    fixture.addMessage("u4", "user", "Next");
    expect(await fixture.run("observe")).toMatchObject({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_AMBIGUOUS",
    });
    fixture.addMessage("u4", "user", "Next");
    expect(await fixture.run("observe")).toMatchObject({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_AMBIGUOUS",
    });
  });
});

describe("saved follow-up refused and uncertain boundaries", () => {
  it("refuses a changed prompt under the original digest and verifies the digest before insertion", async () => {
    const fixture = followUpPage();
    expect(
      (
        await fixture.run("prepare", {
          ...fixture.request,
          digest: digest("Other"),
        })
      ).state,
    ).not.toBe("prepared");
    expect(fixture.composer.innerText).toBe("");
    await fixture.run("prepare");
    Reflect.set(fixture.composer, "value", "Other");
    expect(
      await fixture.run("submit", { ...fixture.request, message: "Other" }),
    ).toMatchObject({ state: "not-sent", code: "SAVED_CHAT_DRAFT_CHANGED" });
    expect(fixture.clicks()).toBe(0);
  });

  it("checks inline plugin markup without replacing it and rejects hidden owner drafts", async () => {
    const fixture = followUpPage(true);
    const chip = new FollowUpElement(
      "SPAN",
      {
        "data-prompt-link-href": "app://asdk_app_TEST",
        "data-app-name": "Farol DEV",
      },
      "Farol DEV",
    );
    fixture.connector.hidden = true;
    fixture.composer.append(chip);
    expect((await fixture.run("prepare")).state).toBe("prepared");
    expect(fixture.composer.children).toContain(chip);
    expect((await fixture.run("submit")).state).toBe("submitted");
    expect(fixture.composer.children).toContain(chip);
  });

  it("does not call a current final message settled when its parent belongs to another user", async () => {
    const fixture = followUpPage();
    const assistant = fixture.root.querySelector('[data-message-id="a1"]')!;
    assistant.attributes["data-parent-message-id"] = "other-user";
    expect(await fixture.run("prepare")).toMatchObject({
      state: "not-sent",
      code: "SAVED_CHAT_TURN_UNSETTLED",
    });
    expect(fixture.clicks()).toBe(0);
  });

  it("rejects a foreign observed parent and correlates an exact app-prefixed next user", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    await fixture.run("submit");
    fixture.addMessage("u2", "user", "Farol DEV\nNext");
    const assistant = fixture.addMessage(
      "a2",
      "assistant",
      "Answer",
      "foreign",
    );
    expect(await fixture.run("observe")).toMatchObject({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
    assistant.attributes["data-parent-message-id"] = "u2";
    expect(await fixture.run("observe")).toMatchObject({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
    });
  });

  it("does not reuse a preparation selection or settled pair when the caller changes its intent", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    fixture.model.innerText = "Another model";
    expect(
      (
        await fixture.run("submit", {
          ...fixture.request,
          selection: {
            ...fixture.request.selection,
            model: "Another model",
          },
        })
      ).state,
    ).not.toBe("submitted");
    expect(fixture.clicks()).toBe(0);
  });

  it("retains the one-shot fuse across plugin loss/remount and allows a third operation only after the exact new settled pair", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    await fixture.run("submit");
    fixture.addMessage("u2", "user", "Next");
    fixture.addMessage("a2", "assistant", "Answer", "u2");
    Reflect.set(fixture.composer, "value", "");
    fixture.connector.hidden = true;
    const third = {
      ...fixture.request,
      operation: { id: "op3", state: "not-sent" as const },
      previous: { userId: "u2", assistantId: "a2" },
      message: "Third",
      digest: digest("Third"),
    };
    expect((await fixture.run("prepare", third)).state).not.toBe("prepared");
    fixture.connector.hidden = false;
    expect((await fixture.run("prepare", third)).state).toBe("prepared");
    expect((await fixture.run("submit", third)).state).toBe("submitted");
    expect(fixture.clicks()).toBe(2);
  });
});

describe("Chat consumer mapping witness and next identities", () => {
  it("requires the fresh EvidenceID and never returns previous IDs as the next turn", async () => {
    const fixture = followUpPage();
    const witness = await fixture.run("prepare");
    if (witness.state !== "prepared")
      throw new Error("Expected fresh verification");
    expect(witness.evidenceId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(
      await fixture.run("submit", {
        ...fixture.request,
        evidenceId: "old-witness",
      }),
    ).toMatchObject({ state: "not-sent", code: "SAVED_CHAT_DRAFT_CHANGED" });
    expect(fixture.clicks()).toBe(0);
    expect(
      (
        await fixture.run("submit", {
          ...fixture.request,
          evidenceId: witness.evidenceId,
        })
      ).state,
    ).toBe("submitted");
    expect(
      await fixture.run("observe", {
        ...fixture.request,
        correlation: { userId: "u1", assistantId: "a1" },
      }),
    ).toMatchObject({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
    expect(fixture.clicks()).toBe(1);
  });

  it("uses the first assistant as ReplyID across several stable segments and the next Send", async () => {
    const fixture = followUpPage();
    await fixture.run("prepare");
    await fixture.run("submit");
    fixture.addMessage("u2", "user", "Next");
    fixture.addMessage("a2", "assistant", "First", "u2");
    fixture.addMessage("a3", "assistant", "Second", "a2");
    expect(await fixture.run("observe")).toMatchObject({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: { messages: [{ id: "a2" }, { id: "a3" }], terminal: true },
    });
    Reflect.set(fixture.composer, "value", "");
    const third = {
      ...fixture.request,
      previous: { userId: "u2", assistantId: "a2" },
      operation: { id: "op3", state: "not-sent" as const },
      message: "Third",
      digest: digest("Third"),
    };
    const fresh = await fixture.run("prepare", third);
    expect(fresh.state).toBe("prepared");
    expect((await fixture.run("submit", third)).state).toBe("submitted");
  });
});

it("observes settled segments without permitting terminal or another Send", async () => {
  const fixture = followUpPage();
  const assistant = fixture.root.querySelector('[data-message-id="a1"]')!;
  assistant.attributes["data-is-streaming"] = "true";
  const markdown = assistant.querySelector(".markdown")!;
  markdown.attributes["data-farol-source-profile"] =
    "farol-controlled-settled-segments-v1";
  markdown.children[0]!.attributes["data-segment-id"] = "s1";
  markdown.children[0]!.attributes["data-segment-state"] = "settled";
  expect(await fixture.run("prepare")).toEqual({
    state: "not-sent",
    code: "SAVED_CHAT_TURN_UNSETTLED",
  });
  expect(fixture.clicks()).toBe(0);

  fixture.addMessage("u2", "user", "Next");
  const current = fixture.addMessage("a2", "assistant", "Useful prefix", "u2");
  current.attributes["data-is-streaming"] = "true";
  const root = current.querySelector(".markdown")!;
  root.attributes["data-farol-source-profile"] =
    "farol-controlled-settled-segments-v1";
  root.children[0]!.attributes["data-segment-id"] = "s2";
  root.children[0]!.attributes["data-segment-state"] = "settled";
  const result = await fixture.run("observe", {
    ...fixture.request,
    operation: { id: "op2", state: "submitted" },
    correlation: { userId: "u2", assistantId: "a2" },
  });
  expect(result).toMatchObject({
    state: "observed",
    assistantId: "a2",
    frame: {
      terminal: false,
      messages: [
        { id: "a2", complete: false, segments: [{ id: "s2", complete: true }] },
      ],
    },
  });
  if (result.state !== "observed") throw new Error("Expected observation");
  expect(
    new ChatGptPublicTurn("u2", "a2", 0).observe(result.frame, 0).answer,
  ).toBe("Useful prefix");
  expect(fixture.clicks()).toBe(0);
});
