import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ BrowserWindow: class {}, session: {} }));
import { taskProbeScript } from "../../src/apps/desktop/chatgpt-route";
import { ChatGptPublicTurn } from "../../src/apps/desktop/chatgpt-public-turn";
import { publicMarkdownBlock } from "../../src/apps/desktop/chatgpt-public-markdown";
import { readPublicAssistantMessages } from "../../src/apps/desktop/chatgpt-public-turn";

// Synthetic DOM API fixture, deliberately not native Chromium/layout evidence.
class ElementFixture {
  readonly nodeType = 1;
  readonly tagName: string;
  parentElement: ElementFixture | null = null;
  readonly childNodes: (ElementFixture | { nodeType: 3; nodeValue: string })[];
  constructor(
    tag: string,
    readonly attributes: Record<string, string> = {},
    children: (ElementFixture | string)[] = [],
  ) {
    this.tagName = tag.toUpperCase();
    this.childNodes = children.map((child) => {
      if (typeof child === "string") return { nodeType: 3, nodeValue: child };
      child.parentElement = this;
      return child;
    });
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  get innerText(): string {
    return this.childNodes
      .map((child) =>
        child instanceof ElementFixture ? child.innerText : child.nodeValue,
      )
      .join("");
  }
  get textContent(): string {
    return this.innerText;
  }
  get hidden(): boolean {
    return this.getAttribute("hidden") !== null;
  }
  getBoundingClientRect() {
    return {
      width:
        this.tagName === "BR" || this.attributes.display === "contents"
          ? 0
          : 100,
      height: 20,
    };
  }
  matches(selector: string): boolean {
    if (selector.includes(","))
      return selector.split(",").some((part) => this.matches(part));
    if (selector.startsWith("."))
      return this.attributes.class === selector.slice(1);
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector);
    if (attribute)
      return (
        this.getAttribute(attribute[1]!) !== null &&
        (attribute[2] === undefined ||
          this.getAttribute(attribute[1]!) === attribute[2])
      );
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector: string): ElementFixture | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  querySelector(selector: string): ElementFixture | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.childNodes.flatMap((child) =>
      child instanceof ElementFixture
        ? [
            ...(child.matches(selector) ? [child] : []),
            ...child.querySelectorAll(selector),
          ]
        : [],
    );
  }
}
const el = (
  tag: string,
  attributes: Record<string, string> = {},
  children: (ElementFixture | string)[] = [],
) => new ElementFixture(tag, attributes, children);
const visible = (candidate: Element): boolean => {
  for (let current = candidate; current; current = current.parentElement!) {
    if (
      current.getAttribute("hidden") !== null ||
      current.getAttribute("aria-hidden") === "true"
    )
      return false;
  }
  return true;
};
const read = (assistants: ElementFixture[]) =>
  readPublicAssistantMessages(
    assistants as unknown as Element[],
    visible,
    publicMarkdownBlock,
  );
const message = (
  content: ElementFixture[],
  copy = true,
  attributes: Record<string, string> = {},
) => {
  const assistant = el(
    "div",
    {
      "data-message-id": "a",
      "data-message-author-role": "assistant",
      ...attributes,
    },
    [el("div", { class: "markdown" }, content)],
  );
  el("article", {}, [
    assistant,
    ...(copy
      ? [el("button", { "data-testid": "copy-turn-action-button" }, ["Copy"])]
      : []),
  ]);
  return assistant;
};

describe("candidate public assistant DOM profile", () => {
  it("buffers a mounting Markdown root and an unfinished table", () => {
    const mounting = el("div", {
      "data-message-id": "a",
      "data-message-author-role": "assistant",
    });
    expect(read([mounting])[0]).toMatchObject({ text: null, complete: false });
    expect(read([message([el("table")], false)])[0]).toMatchObject({
      text: null,
      complete: false,
    });
    expect(() => read([message([el("table")], true)])).toThrow(
      "CHATGPT_MARKDOWN_TABLE_UNSUPPORTED",
    );
  });
  it("executes the serialized production reader and Markdown renderer without ambient dependencies", () => {
    const assistant = message([
      el("p", {}, ["Hello 👋 ", el("strong", {}, ["world"])]),
    ]);
    const result = vm.runInNewContext(
      `(${readPublicAssistantMessages.toString()})(assistants, visible, ${publicMarkdownBlock.toString()})`,
      {
        assistants: [assistant],
        visible,
      },
    );
    expect(result).toEqual([
      {
        id: "a",
        parentId: null,
        channel: "answer",
        text: "Hello 👋 **world**",
        complete: true,
      },
    ]);
  });
  it("does not mistake an old global copy control for completion of this message", () => {
    expect(
      read([message([el("p", {}, ["partial"])], false)])[0]!.complete,
    ).toBe(false);
    expect(
      read([
        message([el("pre", {}, [el("code", {}, ["unfinished 👋"])])], true, {
          "data-is-streaming": "true",
        }),
      ])[0]!.complete,
    ).toBe(false);
  });
  it("waits for citation hydration and preserves a stable message ID on remount", () => {
    expect(
      read([message([el("p", {}, [el("a", {}, ["source"])])])])[0],
    ).toMatchObject({ id: "a", text: null, complete: false });
    expect(
      read([
        message([
          el("p", {}, [el("a", { href: "https://example.test" }, ["source"])]),
        ]),
      ])[0],
    ).toMatchObject({
      id: "a",
      text: "[source](<https://example.test>)",
      complete: true,
    });
  });
  it("never reads hidden/control descendants or an unsupported analysis channel", () => {
    const hidden = el("div", { hidden: "" });
    Object.defineProperty(hidden, "childNodes", {
      get() {
        throw new Error("HIDDEN_READ");
      },
    });
    // Visibility is tested by the converter before any hidden descendant walk.
    expect(
      publicMarkdownBlock(
        el("p", {}, [
          "public",
          hidden,
          el("button", {}, ["private control"]),
        ]) as unknown as Element,
        visible,
      ),
    ).toBe("public");
    const analysis = message([], true, { "data-message-channel": "analysis" });
    analysis.querySelectorAll = () => {
      throw new Error("ANALYSIS_READ");
    };
    expect(() => read([analysis])).toThrow(
      "CHATGPT_PUBLIC_CHANNEL_UNSUPPORTED",
    );
  });
  it("rejects missing anchors and ambiguous Markdown/action ownership", () => {
    const assistant = message([el("p", {}, ["text"])]);
    delete assistant.attributes["data-message-id"];
    expect(() => read([assistant])).toThrow("CHATGPT_PUBLIC_SOURCE_UNANCHORED");
    const first = message([el("p", {}, ["one"])]);
    const second = message([el("p", {}, ["two"])]);
    el("article", {}, [
      first,
      second,
      el("button", { "data-testid": "copy-turn-action-button" }),
    ]);
    expect(read([first, second]).every((item) => !item.complete)).toBe(true);
    first.childNodes.push(el("div", { class: "markdown" }, ["extra"]));
    expect(() => read([first])).toThrow("CHATGPT_PUBLIC_MARKDOWN_UNQUALIFIED");
  });
});

describe("complete serialized semantic probe (synthetic layout)", () => {
  const user = () =>
    el("div", { "data-message-id": "u", "data-message-author-role": "user" }, [
      "prompt",
    ]);
  const probe = (body: ElementFixture, assistantId: string | null = null) =>
    vm.runInNewContext(
      taskProbeScript("prompt", [], {
        semantic: true,
        userId: "u",
        assistantId,
      }),
      {
        document: body,
        HTMLElement: ElementFixture,
        URL,
        getComputedStyle: (element: ElementFixture) => ({
          display: element.attributes.display ?? "block",
          visibility: "visible",
          opacity: element.attributes.opacity ?? "1",
          contentVisibility: element.attributes.contentVisibility ?? "visible",
        }),
      },
    );
  it("preserves zero-width line breaks and display-contents descendants through the actual probe and reducer", () => {
    const assistant = message([
      el("p", {}, [
        "first",
        el("br"),
        "second",
        el("span", { display: "contents" }, [" visible"]),
      ]),
    ]);
    const body = el("body", {}, [
      user(),
      assistant.parentElement!,
      el("button", { "data-testid": "send-button" }),
    ]);
    const frame = probe(body).publicFrame;
    expect(new ChatGptPublicTurn("u", "a", 0).observe(frame, 0).answer).toBe(
      "first  \nsecond visible",
    );
  });
  it.each([
    ["opacity", "0", false],
    ["opacity", "0", true],
    ["contentVisibility", "hidden", false],
    ["contentVisibility", "hidden", true],
  ] as const)(
    "waits for Copy visibility: %s=%s on ancestor=%s",
    (key, value, ancestor) => {
      const assistant = message([el("p", {}, ["partial"])], false);
      const copy = el("button", { "data-testid": "copy-turn-action-button" });
      const action = ancestor ? el("span", {}, [copy]) : copy;
      action.attributes[key] = value;
      action.parentElement = assistant.parentElement;
      assistant.parentElement!.childNodes.push(action);
      const body = el("body", {}, [
        user(),
        assistant.parentElement!,
        el("button", { "data-testid": "send-button" }),
      ]);
      const pending = probe(body).publicFrame;
      expect(pending.messages[0].complete).toBe(false);
      expect(pending.terminal).toBe(false);
      delete action.attributes[key];
      const completed = probe(body).publicFrame;
      expect(completed.messages[0].complete).toBe(true);
      expect(completed.terminal).toBe(true);
    },
  );
  it("retains parent ancestry across disappearance of a delivered prefix", () => {
    const a = message([el("p", {}, ["A"])], true, {
      "data-parent-message-id": "u",
    });
    const b = message([el("p", {}, ["B"])], false, {
      "data-message-id": "b",
      "data-parent-message-id": "a",
    });
    const source = new ChatGptPublicTurn("u", "a", 0);
    const firstBody = el("body", {}, [
      user(),
      a.parentElement!,
      b.parentElement!,
      el("button", { "data-testid": "stop-button" }),
    ]);
    expect(
      source
        .observe(probe(firstBody).publicFrame, 0)
        .items.map((item) => item.text),
    ).toEqual(["A"]);
    const remounted = message([el("p", {}, ["B"])], true, {
      "data-message-id": "b",
      "data-parent-message-id": "a",
    });
    const secondBody = el("body", {}, [
      user(),
      remounted.parentElement!,
      el("button", { "data-testid": "send-button" }),
    ]);
    const result = source.observe(probe(secondBody, "a").publicFrame, 1);
    expect(result.items.map((item) => item.text)).toEqual(["B"]);
    expect(result.answer).toBe("A\n\nB");
    expect(result.completed).toBe(true);
  });
});
