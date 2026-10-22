import { productName } from "../../../tooling/harness-identity.ts";
import { desktopIdentity as harnessDesktopIdentity } from "../../../tooling/harness-identity.ts";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptPublicTurn } from "../../../src/apps/desktop/chatgpt-public-turn";
import {
  savedChatFollowUpScript,
  SavedChatFollowUpResultSchema,
  type SavedChatFollowUpRequest,
} from "../../../src/apps/desktop/saved-chat-page-scripts";

// Execute the unmodified controlled page client against a synthetic DOM API,
// then its DOM through the real serialized saved observation script/reducer.
// Barriers and public state come from the owned HTTP fixture. Event delivery,
// layout and DOM APIs are synthetic; this is not Chromium/live-provider proof.
class TextNode {
  readonly nodeType = 3;
  readonly nodeName = "#text";
  constructor(public nodeValue: string) {}
  get textContent(): string {
    return this.nodeValue;
  }
}
class SyntheticElement {
  readonly nodeType = 1;
  readonly attributes: Record<string, string> = {};
  parentElement: SyntheticElement | null = null;
  childNodes: (SyntheticElement | TextNode)[] = [];
  hidden = false;
  disabled = false;
  private readonly listeners = new Map<
    string,
    ((event: unknown) => unknown)[]
  >();
  readonly dataset = new Proxy({} as Record<string, string>, {
    get: (_target, key: string | symbol) =>
      typeof key === "string"
        ? this.getAttribute(dataAttribute(key))
        : undefined,
    set: (_target, key: string, value: string) => {
      this.attributes[dataAttribute(key)] = value;
      return true;
    },
  });
  constructor(readonly tagName: string) {}
  get nodeName(): string {
    return this.tagName;
  }
  get firstChild(): SyntheticElement | TextNode | null {
    return this.childNodes[0] ?? null;
  }
  get children(): SyntheticElement[] {
    return this.childNodes.filter(
      (node): node is SyntheticElement => node instanceof SyntheticElement,
    );
  }
  get innerText(): string {
    return this.childNodes
      .map((node) =>
        node instanceof SyntheticElement ? node.innerText : node.nodeValue,
      )
      .join("");
  }
  get textContent(): string {
    return this.innerText;
  }
  set textContent(value: string) {
    this.replaceChildren();
    if (value) this.childNodes.push(new TextNode(value));
  }
  set className(value: string) {
    this.attributes.class = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  getBoundingClientRect() {
    return { width: this.hidden ? 0 : 100, height: 20 };
  }
  append(...children: SyntheticElement[]) {
    for (const child of children) {
      child.parentElement = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...children: SyntheticElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.childNodes = [];
    this.append(...children);
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
  querySelector(selector: string): SyntheticElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type: string, listener: (event: unknown) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async dispatch(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? [])
      await listener(event);
  }
}
function dataAttribute(key: string) {
  return `data-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}
type Fixture = {
  url: string;
  origin: string;
  driver: {
    releaseGeneration(replyId: string, count: number): void;
    releaseRender(replyId: string, count: number): void;
    releaseTerminal(replyId: string): void;
    snapshot(): { attemptedSends: number; acceptedSends: number };
  };
};
const { startChatGptFixture, stopChatGptFixture } = await import(
  new URL("./chatgpt-site.mjs", import.meta.url).href
);
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(
    sites.splice(0).map((fixture) => stopChatGptFixture(fixture)),
  );
});
async function controlledPage() {
  const selection = {
    model: "Test model",
    effort: "Light",
    connector: { id: "plugin_asdk_app_TEST", label: `${productName} DEV` },
  };
  const fixture: Fixture = await startChatGptFixture({
    controlledScenario: {
      conversationId: "controlled-prefix",
      selection,
      turns: [
        {
          userId: "user-1",
          replyId: "reply-1",
          prompt: "Return useful text.",
          segments: [
            { id: "segment-1", text: "Useful partial 😺" },
            { id: "segment-2", text: "Useful partial 😺" },
            { id: "segment-3", text: "FUTURE_FINAL_CANARY" },
          ],
        },
      ],
    },
  });
  sites.push(fixture);
  const html = await (await fetch(fixture.url)).text();
  const body = new SyntheticElement("BODY");
  for (const name of [
    "document-id",
    "document-generation",
    "conversation-id",
  ]) {
    body.attributes[`data-${name}`] = new RegExp(
      `data-${name}="([^"]+)"`,
      "u",
    ).exec(html)![1]!;
  }
  const add = (tag: string, attributes: Record<string, string>) => {
    const element = new SyntheticElement(tag);
    Object.assign(element.attributes, attributes);
    body.append(element);
    return element;
  };
  const composer = add("DIV", { id: "prompt-textarea" });
  const send = add("BUTTON", { "data-testid": "send-button" });
  const stop = add("BUTTON", { "data-testid": "stop-button" });
  add("DIV", { "data-testid": "network-error" });
  const output = add("DIV", { id: "conversation" });
  add("BUTTON", { "aria-label": "Select ChatGPT model" });
  add("BUTTON", { "aria-haspopup": "menu", "data-tone": "neutral" });
  add("SPAN", { "data-testid": "composer-app-chip" });
  let onState: ((event: { data: string }) => void) | null = null;
  class SyntheticEventSource {
    addEventListener(
      type: string,
      listener: (event: { data: string }) => void,
    ) {
      if (type === "state") onState = listener;
    }
    close() {}
  }
  const pending = new Set<Promise<unknown>>();
  const location = { href: fixture.url };
  const context = vm.createContext({
    document: {
      body,
      querySelector: (selector: string) => body.querySelector(selector),
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
      createElement: (tag: string) => new SyntheticElement(tag.toUpperCase()),
    },
    location,
    history: {
      replaceState: (_state: unknown, _title: string, path: string) => {
        location.href = new URL(path, fixture.origin).href;
      },
    },
    window: { addEventListener() {} },
    EventSource: SyntheticEventSource,
    URLSearchParams,
    URL,
    TextEncoder,
    crypto: webcrypto,
    HTMLElement: SyntheticElement,
    fetch: (path: string, init: RequestInit) => {
      const request = fetch(new URL(path, fixture.origin), {
        ...init,
        headers: { ...init.headers, origin: fixture.origin },
      });
      pending.add(request);
      void request.finally(() => pending.delete(request));
      return request;
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      contentVisibility: "visible",
    }),
  });
  const client = await (
    await fetch(`${fixture.origin}/fixtures/chatgpt/client.mjs`)
  ).text();
  expect(client).not.toContain("FUTURE_FINAL_CANARY");
  vm.runInContext(client, context);
  const query = new URLSearchParams({
    documentId: body.dataset.documentId!,
    documentGeneration: body.dataset.documentGeneration!,
    conversationId: body.dataset.conversationId!,
  });
  const render = async () => {
    const response = await fetch(
      `${fixture.origin}/fixtures/chatgpt/state?${query}`,
    );
    expect(response.status).toBe(200);
    const projection = await response.text();
    if (!onState) throw new Error("Missing ordinary page state listener");
    onState({ data: projection });
    await Promise.all([...pending]);
    return JSON.parse(projection);
  };
  await render();
  composer.textContent = "Return useful text.";
  await composer.dispatch("input");
  expect(send.disabled).toBe(false);
  await send.dispatch("click");
  await render();
  const request: SavedChatFollowUpRequest = {
    binding: {
      conversationId: "controlled-prefix",
      conversationUrl: location.href,
      viewId: "42",
      viewGeneration: 1,
      documentGeneration: 1,
      partition: harnessDesktopIdentity("preview", "/").chatGptPartition,
    },
    selection,
    previous: { userId: "previous-user", assistantId: "previous-reply" },
    operation: { id: "operation-1", state: "submitted" },
    message: "Return useful text.",
    digest: createHash("sha256").update("Return useful text.").digest("hex"),
    evidenceId: null,
    correlation: { userId: "user-1", assistantId: "reply-1" },
  };
  const observe = async () => {
    const result = SavedChatFollowUpResultSchema.parse(
      await vm.runInContext(
        savedChatFollowUpScript(request, "observe"),
        context,
      ),
    );
    if (result.state !== "observed")
      throw new Error(
        "code" in result ? result.code : "CONTROLLED_OBSERVATION_NOT_OBSERVED",
      );
    expect(result.assistantId).toBe("reply-1");
    return result.frame;
  };
  return { fixture, render, observe, output, stop, body, context, request };
}

describe("production saved DOM observation on the controlled page client", () => {
  it("delivers a DOM-read prefix before terminal, deduplicates remounts and appends distinct equal-text segments", async () => {
    const page = await controlledPage();
    const turn = new ChatGptPublicTurn("user-1", "reply-1", 0);
    expect(turn.observe(await page.observe(), 0).items).toEqual([]);
    page.fixture.driver.releaseGeneration("reply-1", 1);
    page.fixture.driver.releaseRender("reply-1", 1);
    const partial = await page.render();
    expect(partial.turns[0].providerTerminal).toBe(false);
    expect(page.output.innerText).not.toContain("FUTURE_FINAL_CANARY");
    expect(turn.observe(await page.observe(), 1)).toMatchObject({
      answer: "Useful partial 😺",
      completed: false,
      items: [{ id: "segment-1" }],
    });
    const previousNode = page.output.querySelector(
      '[data-segment-id="segment-1"]',
    );
    await page.render();
    expect(page.output.querySelector('[data-segment-id="segment-1"]')).not.toBe(
      previousNode,
    );
    expect(turn.observe(await page.observe(), 2).items).toEqual([]);

    page.fixture.driver.releaseGeneration("reply-1", 3);
    page.fixture.driver.releaseTerminal("reply-1");
    const held = await page.render();
    expect(held.turns[0]).toMatchObject({
      providerTerminal: true,
      renderedTerminal: false,
    });
    expect(turn.observe(await page.observe(), 3).items).toEqual([]);
    expect(page.output.innerText).not.toContain("FUTURE_FINAL_CANARY");
    page.fixture.driver.releaseRender("reply-1", 2);
    await page.render();
    expect(turn.observe(await page.observe(), 4)).toMatchObject({
      completed: false,
      items: [{ id: "segment-2", text: "Useful partial 😺" }],
    });
    page.fixture.driver.releaseRender("reply-1", 3);
    await page.render();
    expect(turn.observe(await page.observe(), 5)).toMatchObject({
      completed: true,
      items: [{ id: "segment-3" }],
      answer:
        "Useful partial 😺\n\nUseful partial 😺\n\nFUTURE\\_FINAL\\_CANARY",
    });
    expect(page.fixture.driver.snapshot()).toMatchObject({
      attemptedSends: 1,
      acceptedSends: 1,
    });
  });

  it("refuses a changed committed DOM segment and remains failed after the page redraws", async () => {
    const page = await controlledPage();
    page.fixture.driver.releaseGeneration("reply-1", 1);
    page.fixture.driver.releaseRender("reply-1", 1);
    await page.render();
    const turn = new ChatGptPublicTurn("user-1", "reply-1", 0);
    turn.observe(await page.observe(), 0);
    page.output.querySelector('[data-segment-id="segment-1"]')!.textContent =
      "Mutated committed text";
    const changed = await page.observe();
    expect(() => turn.observe(changed, 1)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED",
    );
    await page.render();
    const restored = await page.observe();
    expect(() => turn.observe(restored, 2)).toThrow(
      "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED",
    );
    expect(page.fixture.driver.snapshot()).toMatchObject({
      attemptedSends: 1,
      acceptedSends: 1,
    });
  });

  it("buffers unqualified actual-profile shapes and refuses unknown or ambiguous settlement evidence", async () => {
    const page = await controlledPage();
    page.fixture.driver.releaseGeneration("reply-1", 2);
    page.fixture.driver.releaseRender("reply-1", 2);
    await page.render();
    const markdown = page.output.querySelector(".markdown")!;
    delete markdown.attributes["data-farol-source-profile"];
    const frame = await page.observe();
    expect(frame.messages[0]).not.toHaveProperty("segments");
    const turn = new ChatGptPublicTurn("user-1", "reply-1", 0);
    expect(turn.observe(frame, 0).items).toEqual([]);
    expect(turn.observe(frame, 100_000).items).toEqual([]);
    markdown.attributes["data-farol-source-profile"] = "unknown-profile";
    expect(
      await vm.runInContext(
        savedChatFollowUpScript(page.request, "observe"),
        page.context,
      ),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
    markdown.attributes["data-farol-source-profile"] =
      "farol-controlled-settled-segments-v1";
    markdown.children[1]!.dataset.segmentId = "segment-1";
    expect(
      await vm.runInContext(
        savedChatFollowUpScript(page.request, "observe"),
        page.context,
      ),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
  });
});
