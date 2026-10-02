import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ChatGptUpdateIdleSchema,
  chatGptUpdateIdleProbe,
} from "../../src/apps/desktop/chatgpt-update-idle";

// Structural public-DOM fixtures. This proves classification and content
// minimization, not current ChatGPT selectors, native input or live idle state.
class ElementFixture {
  visible = true;
  disabled = false;
  textContent = "";
  value = "";
  files: unknown[] = [];
  children: ElementFixture[] = [];
  form: ElementFixture | null = null;
  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
  ) {}
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  getBoundingClientRect() {
    return this.visible ? { width: 200, height: 40 } : { width: 0, height: 0 };
  }
  closest(selector: string) {
    return selector === "form" ? this.form : null;
  }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.children.filter((node) => matches(node, selector));
  }
}
class TextAreaFixture extends ElementFixture {
  constructor() {
    super("textarea", { id: "prompt-textarea" });
  }
}
class ButtonFixture extends ElementFixture {
  constructor(attributes: Record<string, string>) {
    super("button", attributes);
  }
}
function matches(node: ElementFixture, selectors: string): boolean {
  return selectors.split(",").some((selector) => {
    const id = selector.match(/^#([a-z-]+)$/u);
    if (id) return node.getAttribute("id") === id[1];
    const tag = selector.match(/^([a-z]+)/u)?.[1];
    if (tag && node.tag !== tag) return false;
    return [...selector.matchAll(/\[([a-z-]+)(\*?=)"([^"]+)"\]/gu)].every(
      ([, name, operator, value]) =>
        operator === "*="
          ? node.getAttribute(name!)?.includes(value!) === true
          : node.getAttribute(name!) === value,
    );
  });
}
function fixture() {
  const form = new ElementFixture("form");
  const composer = new TextAreaFixture();
  composer.form = form;
  const send = new ButtonFixture({ "data-testid": "send-button" });
  send.disabled = true;
  form.children = [composer, send];
  const nodes = [form, composer, send];
  const run = () =>
    ChatGptUpdateIdleSchema.parse(
      runInNewContext(chatGptUpdateIdleProbe, {
        HTMLElement: ElementFixture,
        HTMLTextAreaElement: TextAreaFixture,
        HTMLButtonElement: ButtonFixture,
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        document: {
          querySelectorAll: (selector: string) =>
            nodes.filter((node) => matches(node, selector)),
        },
      }),
    );
  return { run, form, composer, send, nodes };
}

describe("update idle observation on synthetic public DOM", () => {
  it("requires an empty usable composer with a disabled Send control", () => {
    const f = fixture();
    expect(f.run()).toEqual({ state: "idle" });
    f.send.disabled = false;
    expect(f.run()).toEqual({ state: "unknown" });
    f.send.visible = false;
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it("recognizes an empty voice-ready composer, not a disabled or ambiguous voice control", () => {
    const f = fixture();
    f.send.visible = false;
    const voice = new ButtonFixture({ "data-testid": "voice-mode-button" });
    f.form.children.push(voice);
    f.nodes.push(voice);
    expect(f.run()).toEqual({ state: "idle" });
    voice.disabled = true;
    expect(f.run()).toEqual({ state: "unknown" });
    voice.disabled = false;
    f.form.children.push(
      new ButtonFixture({ "aria-label": "Start voice mode" }),
    );
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it.each([
    "Stop generating",
    "Stop recording",
    "Stop dictation",
    "End voice chat",
    "End conversation",
  ])("refuses a visible %s control even with an empty composer", (label) => {
    const f = fixture();
    const stop = new ButtonFixture({ "aria-label": label });
    f.nodes.push(stop);
    expect(f.run()).toEqual({ state: "running" });
    stop.visible = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
  it.each(["aria-busy", "data-is-streaming"])(
    "refuses visible %s activity",
    (attribute) => {
      const f = fixture();
      f.nodes.push(new ElementFixture("div", { [attribute]: "true" }));
      expect(f.run()).toEqual({ state: "running" });
    },
  );
  it.each(["unfinished private draft", " ", "\n"])(
    "preserves an unsent draft without returning its content",
    (draft) => {
      const f = fixture();
      f.composer.value = draft;
      expect(f.run()).toEqual({ state: "draft" });
    },
  );
  it("refuses selected files and visible attachment previews", () => {
    const f = fixture();
    const input = new ElementFixture("input", { type: "file" });
    input.files = ["opaque fixture file"];
    f.form.children.push(input);
    expect(f.run()).toEqual({ state: "draft" });
    input.files = [];
    const attachment = new ElementFixture("div", {
      "data-testid": "composer-attachment",
    });
    f.form.children.push(attachment);
    expect(f.run()).toEqual({ state: "draft" });
    attachment.visible = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
  it("rejects missing, disabled and ambiguous composers", () => {
    const f = fixture();
    f.composer.form = null;
    expect(f.run()).toEqual({ state: "unknown" });
    f.composer.form = f.form;
    f.composer.disabled = true;
    expect(f.run()).toEqual({ state: "unknown" });
    f.composer.disabled = false;
    f.nodes.push(new TextAreaFixture());
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it("classifies an editable composer and refuses a noneditable replacement", () => {
    const f = fixture();
    f.composer.visible = false;
    const editable = new ElementFixture("div", {
      id: "prompt-textarea",
      contenteditable: "true",
    });
    editable.form = f.form;
    f.nodes.push(editable);
    expect(f.run()).toEqual({ state: "idle" });
    editable.textContent = "private draft";
    expect(f.run()).toEqual({ state: "draft" });
    editable.attributes.contenteditable = "false";
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it("rejects additional data and unrecognized observation states", () => {
    expect(
      ChatGptUpdateIdleSchema.safeParse({ state: "idle", text: "private" })
        .success,
    ).toBe(false);
    expect(ChatGptUpdateIdleSchema.safeParse({ state: "absent" }).success).toBe(
      false,
    );
  });
});
