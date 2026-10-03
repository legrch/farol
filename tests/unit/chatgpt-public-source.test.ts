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
      "data-message-channel": "final",
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
  it("keeps committed code fingerprints stable across localized toolbar removal", () => {
    const code = "  line one\n\tline two\n";
    const wrapper = (label: string | null) =>
      el("div", { "data-markdown-copy": "code-block" }, [
        ...(label === null
          ? []
          : [
              el("div", {}, [
                el("span", {}, ["Python"]),
                el("button", {}, [label]),
              ]),
            ]),
        el("div", {}, [el("code", { class: "language-python" }, [code])]),
      ]);
    const turn = new ChatGptPublicTurn("u", "a", 0);
    for (const [index, label] of [
      "Copy code",
      "Копировать код",
      "Copiar código",
      null,
    ].entries()) {
      const assistants = [message([wrapper(label)])];
      const frame = {
        userId: "u",
        messages: read(assistants),
        terminal: index === 3,
      };
      const result = turn.observe(frame, index);
      expect(result.answer).toBe("```python\n" + code + "```");
      expect(result.items).toHaveLength(index === 0 ? 1 : 0);
      const serialized = vm.runInNewContext(
        `(${readPublicAssistantMessages.toString()})(assistants, visible, ${publicMarkdownBlock.toString()})`,
        { assistants, visible },
      );
      expect(serialized).toEqual(frame.messages);
    }
  });
  it("buffers mounting code and refuses a complete ambiguous code wrapper", () => {
    const marked = (children: ElementFixture[]) =>
      el("div", { "data-markdown-copy": "code-block" }, children);
    expect(read([message([marked([])], false)])[0]).toMatchObject({
      text: null,
      complete: false,
    });
    expect(() =>
      read([message([marked([el("code", {}, ["a"]), el("code", {}, ["b"])])])]),
    ).toThrow("CHATGPT_MARKDOWN_CODE_WRAPPER_UNSUPPORTED");
  });
  it("refuses a real code mutation after committing the normalized wrapper", () => {
    const messages = (code: string) =>
      read([
        message([
          el("div", { "data-markdown-copy": "code-block" }, [
            el("code", {}, [code]),
          ]),
        ]),
      ]);
    const turn = new ChatGptPublicTurn("u", "a", 0);
    expect(
      turn.observe(
        { userId: "u", messages: messages("original\ncode"), terminal: false },
        0,
      ).items,
    ).toHaveLength(1);
    expect(() =>
      turn.observe(
        { userId: "u", messages: messages("changed\ncode"), terminal: true },
        1,
      ),
    ).toThrow("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
  });
  it("buffers a mounting Markdown root and an unfinished table", () => {
    const mounting = el("div", {
      "data-message-id": "a",
      "data-message-author-role": "assistant",
      "data-message-channel": "final",
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
  it("rejects assistant messages without an explicit public channel", () => {
    const unclassified = message([el("p", {}, ["unclassified content"])]);
    delete unclassified.attributes["data-message-channel"];
    expect(() => read([unclassified])).toThrow(
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
  it("preserves equal code blocks and two horizontal rules through the serialized probe", () => {
    const marked = () =>
      el("div", { "data-markdown-copy": "code-block" }, [
        el("code", {}, ["same\ncode"]),
      ]);
    const assistant = message([marked(), marked(), el("hr"), el("hr")]);
    const body = el("body", {}, [
      user(),
      assistant.parentElement!,
      el("button", { "data-testid": "send-button" }),
    ]);
    const source = new ChatGptPublicTurn("u", "a", 0);
    const initial = probe(body).publicFrame;
    const result = source.observe({ ...initial, terminal: false }, 0);
    expect(result.answer).toBe(
      "```\nsame\ncode\n```\n\n```\nsame\ncode\n```\n\n---\n\n---",
    );
    expect(source.observe(probe(body).publicFrame, 1).items).toEqual([]);
  });
  it("does not identify equal-text messages by their text after prefix virtualization", () => {
    const source = new ChatGptPublicTurn("u", "a", 0);
    const first = message([el("hr")], true, { "data-parent-message-id": "u" });
    const second = message([el("hr")], false, {
      "data-message-id": "b",
      "data-parent-message-id": "a",
    });
    const frame = (assistants: ElementFixture[], terminal: boolean) => ({
      userId: "u",
      messages: read(assistants),
      terminal,
    });
    expect(
      source
        .observe(frame([first, second], false), 0)
        .items.map((item) => item.id),
    ).toEqual(["a"]);
    const final = message([el("hr")], true, {
      "data-message-id": "b",
      "data-parent-message-id": "a",
    });
    const result = source.observe(frame([final], true), 1);
    expect(result.items.map((item) => item.id)).toEqual(["b"]);
    expect(result.answer).toBe("---\n\n---");
    expect(result.completed).toBe(true);
  });
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

describe("explicit synthetic settled-segment DOM profile", () => {
  const segmented = (
    settled = true,
    profile = "farol-controlled-settled-segments-v1",
  ) => {
    const assistant = message(
      [
        el(
          "p",
          {
            "data-segment-id": "s1",
            "data-segment-state": settled ? "settled" : "pending",
          },
          ["Useful prefix"],
        ),
        el("p", { "data-segment-id": "s2", "data-segment-state": "pending" }, [
          "Growing tail",
        ]),
      ],
      false,
      { "data-is-streaming": "true" },
    );
    assistant.querySelector(".markdown")!.attributes[
      "data-farol-source-profile"
    ] = profile;
    return assistant;
  };
  const decode = (assistant: ElementFixture, enabled = true) =>
    vm.runInNewContext(
      `(${readPublicAssistantMessages.toString()})(assistants, visible, ${publicMarkdownBlock.toString()}, visible, enabled)`,
      { assistants: [assistant], visible, enabled },
    );
  it("reads only explicitly settled blocks while whole-reply completion stays false", () => {
    const messages = decode(segmented());
    expect(messages[0]).toMatchObject({
      id: "a",
      complete: false,
      segments: [
        { id: "s1", text: "Useful prefix", complete: true },
        { id: "s2", text: "Growing tail", complete: false },
      ],
    });
    const turn = new ChatGptPublicTurn("u", "a", 0);
    expect(
      turn.observe({ userId: "u", messages, terminal: false }, 0),
    ).toMatchObject({
      answer: "Useful prefix",
      completed: false,
      items: [{ id: "s1" }],
    });
  });
  it("does not enable segmentation for ordinary or unselected source profiles", () => {
    const assistant = segmented();
    expect(decode(assistant, false)[0]).not.toHaveProperty("segments");
    delete assistant.querySelector(".markdown")!.attributes[
      "data-farol-source-profile"
    ];
    const turn = new ChatGptPublicTurn("u", "a", 0);
    const messages = decode(assistant);
    expect(messages[0]).not.toHaveProperty("segments");
    expect(
      turn.observe({ userId: "u", messages, terminal: false }, 100_000).items,
    ).toEqual([]);
  });
  it("refuses unknown profiles, duplicate/nested IDs and unanchored public content", () => {
    expect(() => decode(segmented(true, "unknown-profile"))).toThrow(
      "CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED",
    );
    for (const variant of [
      "duplicate",
      "nested",
      "unanchored",
      "unknown-state",
    ]) {
      const assistant = segmented();
      const markdown = assistant.querySelector(".markdown")!;
      const second = markdown.querySelectorAll("p")[1]!;
      if (variant === "duplicate") second.attributes["data-segment-id"] = "s1";
      if (variant === "nested")
        second.childNodes.push(el("span", { "data-segment-id": "nested" }));
      if (variant === "unanchored") delete second.attributes["data-segment-id"];
      if (variant === "unknown-state")
        second.attributes["data-segment-state"] = "stable-for-500ms";
      expect(() => decode(assistant)).toThrow(
        "CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED",
      );
    }
  });
  it("never upgrades a pending segment because the turn copy control is present", () => {
    const assistant = segmented(false);
    assistant.attributes["data-is-streaming"] = "false";
    assistant
      .closest("article")!
      .childNodes.push(
        el("button", { "data-testid": "copy-turn-action-button" }),
      );
    expect(decode(assistant)[0].complete).toBe(false);
  });
});

it("validates later committed DOM text even when an earlier Markdown root disappears", () => {
  const segmented = (id: string, segmentId: string, text: string) => {
    const assistant = message(
      [
        el(
          "p",
          { "data-segment-id": segmentId, "data-segment-state": "settled" },
          [text],
        ),
      ],
      true,
      { "data-message-id": id },
    );
    assistant.querySelector(".markdown")!.attributes[
      "data-farol-source-profile"
    ] = "farol-controlled-settled-segments-v1";
    return assistant;
  };
  const decode = (assistants: ElementFixture[]) =>
    vm.runInNewContext(
      `(${readPublicAssistantMessages.toString()})(assistants, visible, ${publicMarkdownBlock.toString()}, visible, true)`,
      { assistants, visible },
    );
  const turn = new ChatGptPublicTurn("u", "a", 0);
  const original = decode([
    segmented("a", "s1", "one"),
    segmented("b", "s2", "two"),
  ]);
  expect(
    turn.observe({ userId: "u", messages: original, terminal: false }, 0).items,
  ).toHaveLength(2);
  const missing = message([], false);
  missing.childNodes.splice(0);
  const changed = decode([missing, segmented("b", "s2", "MUTATED")]);
  expect(() =>
    turn.observe({ userId: "u", messages: changed, terminal: false }, 1),
  ).toThrow("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
  expect(() =>
    turn.observe({ userId: "u", messages: original, terminal: false }, 2),
  ).toThrow("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
});
