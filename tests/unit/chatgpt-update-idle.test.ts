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
  cssVisible = true;
  ancestorOpacity = "1";
  styles = { display: "block", visibility: "visible", opacity: "1" };
  rectangle = {
    width: 200,
    height: 40,
    left: 0,
    top: 0,
    right: 200,
    bottom: 40,
  };
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
    return this.visible
      ? this.rectangle
      : { ...this.rectangle, width: 0, height: 0 };
  }
  checkVisibility(options: { opacityProperty?: boolean } = {}) {
    // Native CSSOM checkVisibility defaults to layout visibility. Opting into
    // opacity also checks ancestors, whose opacity is not inherited by a child.
    return (
      this.cssVisible &&
      (!options.opacityProperty ||
        (this.styles.opacity !== "0" && this.ancestorOpacity !== "0"))
    );
  }
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
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
  const voice = new ButtonFixture({
    "data-testid": "voice-mode-button",
    "aria-label": "Start voice mode",
  });
  form.children = [composer, send, voice];
  const nodes = [form, composer, send, voice];
  const paint = { hit: voice as ElementFixture | null };
  const run = () =>
    ChatGptUpdateIdleSchema.parse(
      runInNewContext(chatGptUpdateIdleProbe, {
        HTMLElement: ElementFixture,
        HTMLTextAreaElement: TextAreaFixture,
        HTMLButtonElement: ButtonFixture,
        getComputedStyle: (node: ElementFixture) => node.styles,
        innerWidth: 1000,
        innerHeight: 700,
        document: {
          querySelectorAll: (selector: string) =>
            nodes.filter((node) => matches(node, selector)),
          elementFromPoint: () => paint.hit,
        },
      }),
    );
  return { run, form, composer, send, voice, nodes, paint };
}

describe("update idle observation on synthetic public DOM", () => {
  it("recognizes the current Start Voice entry without weakening activity checks", () => {
    const f = fixture();
    f.voice.attributes["aria-label"] = "Start Voice";
    expect(f.run()).toEqual({ state: "idle" });
    f.voice.disabled = true;
    expect(f.run()).toEqual({ state: "unknown" });
    f.voice.disabled = false;
    f.composer.value = "unsent fixture draft";
    expect(f.run()).toEqual({ state: "draft" });
    f.composer.value = "";
    f.nodes.push(new ButtonFixture({ "aria-label": "Stop generating" }));
    expect(f.run()).toEqual({ state: "running" });
  });
  it("requires an empty usable composer, voice readiness and no enabled Send control", () => {
    const f = fixture();
    expect(f.run()).toEqual({ state: "idle" });
    f.send.disabled = false;
    expect(f.run()).toEqual({ state: "unknown" });
    f.send.visible = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
  it.each(["absent", "hidden", "disabled", "aria-disabled", "renamed"])(
    "does not treat disabled Send as idle when voice readiness is %s",
    (state) => {
      const f = fixture();
      if (state === "absent") f.form.children = [f.composer, f.send];
      if (state === "hidden") f.voice.visible = false;
      if (state === "disabled") f.voice.disabled = true;
      if (state === "aria-disabled") {
        f.voice.attributes["aria-disabled"] = "true";
      }
      if (state === "renamed") {
        f.voice.attributes["aria-label"] = "Finish speaking";
      }
      expect(f.run()).toEqual({ state: "unknown" });
    },
  );
  it("does not borrow voice readiness from outside the composer form", () => {
    const f = fixture();
    f.form.children = [f.composer, f.send];
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it.each([
    "transparent",
    "concealed-ancestor",
    "off-viewport",
    "clipped",
    "covered",
  ])("refuses a %s voice entry despite its positive layout box", (state) => {
    const f = fixture();
    if (state === "transparent") f.voice.styles.opacity = "0";
    if (state === "concealed-ancestor") {
      f.voice.ancestorOpacity = "0";
      expect(f.voice.styles.opacity).toBe("1");
      expect(f.voice.checkVisibility()).toBe(true);
      expect(f.voice.checkVisibility({ opacityProperty: true })).toBe(false);
      expect(f.paint.hit).toBe(f.voice);
    }
    if (state === "off-viewport") {
      f.voice.rectangle = { ...f.voice.rectangle, left: 1500, right: 1700 };
    }
    if (state === "clipped") f.paint.hit = null;
    if (state === "covered") f.paint.hit = f.form;
    expect(f.voice.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it("refuses voice readiness when native CSS visibility is unavailable", () => {
    const f = fixture();
    Object.defineProperty(f.voice, "checkVisibility", { value: undefined });
    expect(f.run()).toEqual({ state: "unknown" });
  });
  it.each(["Start voice mode", "Start Voice"])(
    "rejects disabled or ambiguous voice readiness with a second %s control",
    (label) => {
      const f = fixture();
      f.send.visible = false;
      const voice = f.voice;
      expect(f.run()).toEqual({ state: "idle" });
      voice.disabled = true;
      expect(f.run()).toEqual({ state: "unknown" });
      voice.disabled = false;
      f.form.children.push(new ButtonFixture({ "aria-label": label }));
      expect(f.run()).toEqual({ state: "unknown" });
    },
  );
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
