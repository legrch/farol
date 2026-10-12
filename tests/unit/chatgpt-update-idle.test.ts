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
  disabledByFieldset = false;
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
  matches(selector: string): boolean {
    if (selector !== ":disabled")
      throw new Error("Unsupported fixture selector");
    return this.disabled || this.disabledByFieldset;
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
  get type() {
    const value = this.getAttribute("type");
    return ["button", "reset", "submit"].includes(value ?? "")
      ? value
      : "submit";
  }
}
function matches(node: ElementFixture, selectors: string): boolean {
  return selectors.split(",").some((selector) => {
    const id = selector.match(/^#([a-z-]+)$/u);
    if (id) return node.getAttribute("id") === id[1];
    const tag = selector.match(/^([a-z]+)/u)?.[1];
    if (tag && node.tag !== tag) return false;
    return [...selector.matchAll(/\[([a-z-]+)([~*]?=)"([^"]+)"\]/gu)].every(
      ([, name, operator, value]) =>
        operator === "*="
          ? node.getAttribute(name!)?.includes(value!) === true
          : operator === "~="
            ? node.getAttribute(name!)?.split(/\s+/u).includes(value!) === true
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
    type: "button",
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
  const structuralLabels = [
    "Add files",
    "Add files and more",
    "Select ChatGPT model",
    "Dictate",
  ];
  const addStructuralControl = (
    f: ReturnType<typeof fixture>,
    label: string,
  ) => {
    const control = new ButtonFixture({ type: "button", "aria-label": label });
    control.form = f.form;
    f.form.children.push(control);
    return control;
  };
  it.each(structuralLabels)(
    "allows the exact non-submit %s control while retaining positive idle proof",
    (label) => {
      const f = fixture();
      addStructuralControl(f, label);
      expect(f.run()).toEqual({ state: "idle" });
    },
  );
  it("allows all three ordinary structural controls together", () => {
    const f = fixture();
    structuralLabels
      .filter((label) => label !== "Add files")
      .forEach((label) => addStructuralControl(f, label));
    expect(f.run()).toEqual({ state: "idle" });
  });
  it("refuses simultaneous old and new attachment entry identities", () => {
    const f = fixture();
    addStructuralControl(f, "Add files");
    const renamed = addStructuralControl(f, "Add files and more");
    expect(f.run()).toEqual({ state: "unknown" });
    renamed.disabled = true;
    expect(f.run()).toEqual({ state: "unknown" });
    renamed.visible = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
  describe.each(structuralLabels)("exact %s structural identity", (label) => {
    it.each(["absent", "submit", "reset", "invalid"])(
      "refuses a %s native button type",
      (type) => {
        const f = fixture();
        const control = addStructuralControl(f, label);
        if (type === "absent") delete control.attributes.type;
        else control.attributes.type = type;
        expect(f.run()).toEqual({ state: "unknown" });
      },
    );
    it.each(["div", "span", "input"])(
      "refuses a %s with the same label",
      (tag) => {
        const f = fixture();
        f.form.children.push(
          new ElementFixture(tag, {
            type: "button",
            role: "button",
            "aria-label": label,
          }),
        );
        expect(f.run()).toEqual({ state: "unknown" });
      },
    );
    it.each([`${label} now`, label.toLowerCase(), ` ${label} `])(
      "refuses the nonexact label %s",
      (otherLabel) => {
        const f = fixture();
        addStructuralControl(f, otherLabel);
        expect(f.run()).toEqual({ state: "unknown" });
      },
    );
    it("refuses duplicate visible identities, including a disabled duplicate", () => {
      const f = fixture();
      addStructuralControl(f, label);
      const duplicate = addStructuralControl(f, label);
      expect(f.run()).toEqual({ state: "unknown" });
      duplicate.disabled = true;
      expect(f.run()).toEqual({ state: "unknown" });
      duplicate.visible = false;
      expect(f.run()).toEqual({ state: "idle" });
    });
    it.each(["aria-expanded", "aria-pressed"])(
      "refuses an active or ambiguous %s state",
      (attribute) => {
        const f = fixture();
        const control = addStructuralControl(f, label);
        for (const value of ["true", "mixed", "unrecognized", ""]) {
          control.attributes[attribute] = value;
          expect(f.run()).toEqual({ state: "unknown" });
        }
        control.attributes[attribute] = "false";
        expect(f.run()).toEqual({ state: "idle" });
      },
    );
    it("refuses external form-owned and differently owned descendant controls", () => {
      const f = fixture();
      const control = addStructuralControl(f, label);
      control.form = new ElementFixture("form");
      expect(f.run()).toEqual({ state: "unknown" });
      control.form = null;
      expect(f.run()).toEqual({ state: "unknown" });
      control.form = f.form;
      f.form.children.pop();
      f.nodes.push(control);
      expect(f.run()).toEqual({ state: "unknown" });
    });
  });
  it.each([
    "draft",
    "files",
    "attachment",
    "stream",
    "voice",
    "dictation",
    "unknown-action",
    "ambiguous-composer",
    "missing-composer-form",
    "missing-voice",
    "occluded-voice",
    "enabled-send",
  ])("retains the %s refusal with all structural controls present", (state) => {
    const f = fixture();
    structuralLabels
      .filter((label) => label !== "Add files")
      .forEach((label) => addStructuralControl(f, label));
    let expected = "unknown";
    if (state === "draft") {
      f.composer.value = "opaque fixture draft";
      expected = "draft";
    }
    if (state === "files") {
      const input = new ElementFixture("input", { type: "file" });
      input.files = ["opaque fixture file"];
      f.form.children.push(input);
      expected = "draft";
    }
    if (state === "attachment") {
      f.form.children.push(
        new ElementFixture("div", { "data-testid": "composer-attachment" }),
      );
      expected = "draft";
    }
    if (state === "stream" || state === "voice" || state === "dictation") {
      f.nodes.push(
        state === "stream"
          ? new ElementFixture("div", { "data-is-streaming": "true" })
          : new ButtonFixture({
              "aria-label":
                state === "voice" ? "End voice chat" : "Stop dictation",
            }),
      );
      expected = "running";
    }
    if (state === "unknown-action") addStructuralControl(f, "Other action");
    if (state === "ambiguous-composer") f.nodes.push(new TextAreaFixture());
    if (state === "missing-composer-form") f.composer.form = null;
    if (state === "missing-voice") f.voice.visible = false;
    if (state === "occluded-voice") f.paint.hit = f.form;
    if (state === "enabled-send") f.send.disabled = false;
    expect(f.run()).toEqual({ state: expected });
  });
  it.each(["div", "span"])(
    "refuses a custom %s button even when it claims to be disabled",
    (tag) => {
      const f = fixture();
      const control = new ElementFixture(tag, {
        role: "button",
        "aria-label": "Send",
      });
      f.form.children.push(control);
      expect(f.run()).toEqual({ state: "unknown" });
      control.attributes.role = "unknown button";
      expect(f.run()).toEqual({ state: "unknown" });
      control.attributes["aria-disabled"] = "true";
      expect(f.run()).toEqual({ state: "unknown" });
      control.disabled = true;
      expect(f.run()).toEqual({ state: "unknown" });
      control.visible = false;
      expect(f.run()).toEqual({ state: "idle" });
    },
  );
  it("requires a voice entry that is not disabled by an ancestor fieldset", () => {
    const f = fixture();
    f.voice.disabledByFieldset = true;
    expect(f.voice.disabled).toBe(false);
    expect(f.run()).toEqual({ state: "unknown" });
    f.voice.disabledByFieldset = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
  it("refuses a composer disabled by an ancestor fieldset", () => {
    const f = fixture();
    f.composer.disabledByFieldset = true;
    expect(f.composer.disabled).toBe(false);
    expect(f.run()).toEqual({ state: "unknown" });
    f.composer.disabledByFieldset = false;
    expect(f.run()).toEqual({ state: "idle" });
  });
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
  it.each([
    "explicit",
    "implicit",
    "invalid",
    "button",
    "reset",
    "input",
    "image",
    "input-button",
    "input-reset",
  ])("refuses an unrecognized enabled %s action control", (kind) => {
    const f = fixture();
    f.voice.attributes["aria-label"] = "Start Voice";
    f.send.visible = false;
    const control =
      kind === "input" ||
      kind === "image" ||
      kind === "input-button" ||
      kind === "input-reset"
        ? new ElementFixture("input", {
            type: kind.startsWith("input-")
              ? kind.slice(6)
              : kind === "image"
                ? "image"
                : "submit",
          })
        : new ButtonFixture({
            "aria-label": "Unrecognized action",
            ...(kind === "implicit"
              ? {}
              : {
                  type:
                    kind === "invalid"
                      ? "unrecognized"
                      : kind === "button" || kind === "reset"
                        ? kind
                        : "submit",
                }),
          });
    f.form.children.push(control);
    expect(f.run()).toEqual({ state: "unknown" });
    control.disabled = true;
    expect(f.run()).toEqual({ state: "idle" });
  });
  it.each([
    "button",
    "custom-button",
    "reset",
    "submit",
    "image",
    "input-button",
    "input-reset",
    "recognized-send",
  ])(
    "refuses an external enabled %s control owned by the composer form",
    (kind) => {
      const f = fixture();
      f.send.visible = false;
      const control =
        kind === "submit" || kind === "image" || kind.startsWith("input-")
          ? new ElementFixture("input", {
              type: kind.startsWith("input-") ? kind.slice(6) : kind,
            })
          : new ButtonFixture({
              type:
                kind === "custom-button"
                  ? "button"
                  : kind === "reset"
                    ? "reset"
                    : "submit",
              ...(kind === "recognized-send"
                ? { "data-testid": "send-button" }
                : { "aria-label": "Continue" }),
            });
      control.form = f.form;
      f.nodes.push(control);
      expect(f.form.contains(control)).toBe(false);
      expect(f.run()).toEqual({ state: "unknown" });
      control.disabled = true;
      expect(f.run()).toEqual({ state: "idle" });
      control.disabled = false;
      control.form = new ElementFixture("form");
      expect(f.run()).toEqual({ state: "idle" });
    },
  );
  it("preserves a file selected in an external input owned by the composer form", () => {
    const f = fixture();
    const input = new ElementFixture("input", { type: "file" });
    input.form = f.form;
    input.files = ["opaque fixture file"];
    f.nodes.push(input);
    expect(f.form.contains(input)).toBe(false);
    expect(f.run()).toEqual({ state: "draft" });
    input.files = [];
    expect(f.run()).toEqual({ state: "idle" });
    input.files = ["opaque fixture file"];
    input.form = new ElementFixture("form");
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
