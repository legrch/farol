// @vitest-environment jsdom
import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
  systemPreferences: {},
}));
import {
  connectionCheckDocumentProbe,
  prepareTaskScript,
  activateTaskScript,
} from "../../src/apps/desktop/chatgpt/scripts.ts";

// Execute the REAL injected scripts against a closed DOM fixture. This is not
// a witness of current ChatGPT markup, Electron navigation or a provider Send.
const appName = "Farol Dev";
const originalHref = "https://chatgpt.com/c/original";
const temporaryHref = "https://chatgpt.com/?temporary-chat=true";
const prompt =
  'Call computer_connection_status ONCE with checkId "49a0cb44-5c67-4aae-9b56-41db024507d3".';
let sends = 0;
const innerText = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "innerText",
);
beforeEach(() => {
  sends = 0;
  document.body.innerHTML = `
    <button type="button" aria-label="Turn off temporary chat">Temporary</button>
    <button type="button">Personalized</button>
    <button type="button" aria-label="Select ChatGPT model">Instant</button>
    <form id="composer-form">
      <span data-testid="composer-app-chip" data-app-name="Farol Dev" data-app-id="plugin_asdk_app_fixture">Farol Dev</span>
      <textarea id="prompt-textarea"></textarea>
      <input type="file" />
      <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
    </form>`;
  const rect = {
    width: 100,
    height: 24,
    x: 0,
    y: 0,
    top: 0,
    bottom: 24,
    left: 0,
    right: 100,
    toJSON: () => ({}),
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect,
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
    Object.assign([rect], { item: () => rect }) as unknown as DOMRectList,
  );
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
  });
  document
    .querySelector<HTMLButtonElement>('[data-testid="send-button"]')!
    .addEventListener("click", () => {
      sends++;
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  if (innerText)
    Object.defineProperty(HTMLElement.prototype, "innerText", innerText);
  else Reflect.deleteProperty(HTMLElement.prototype, "innerText");
});
function execute(script: string, href = temporaryHref): unknown {
  return vm.runInNewContext(script, {
    document,
    location: { href },
    URL,
    Date,
    Set,
    HTMLElement,
    HTMLTextAreaElement,
    HTMLInputElement,
    HTMLButtonElement,
    HTMLFormElement,
    InputEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
}
const composer = () =>
  document.querySelector<HTMLTextAreaElement>("#prompt-textarea")!;
const originalProbe = () =>
  execute(connectionCheckDocumentProbe(appName, originalHref), originalHref);
const activate = () =>
  execute(
    activateTaskScript(temporaryHref, appName, true, false, prompt, true),
  );

it("observes an empty original document twice without modifying it or activating Send", () => {
  const before = document.body.innerHTML;
  expect(originalProbe()).toBe(true);
  expect(originalProbe()).toBe(true);
  expect(document.body.innerHTML).toBe(before);
  expect(sends).toBe(0);
});
it.each([
  "text",
  "whitespace",
  "selected-file",
  "attachment-chip",
  "unknown-image",
  "unknown-control",
  "two-composers",
  "active-generation",
  "no-file-input",
])("original %s is preserved and refuses navigation admission", (kind) => {
  const form = document.querySelector("form")!;
  if (kind === "text") composer().value = "owner's unfinished message";
  if (kind === "whitespace") composer().value = "  ";
  if (kind === "selected-file")
    Object.defineProperty(
      document.querySelector('input[type="file"]')!,
      "files",
      { value: { length: 1 } },
    );
  if (kind === "attachment-chip")
    form.insertAdjacentHTML(
      "beforeend",
      '<span data-testid="attachment-preview">owner.pdf</span>',
    );
  if (kind === "unknown-image")
    form.insertAdjacentHTML(
      "beforeend",
      '<img src="about:blank" alt="staged" />',
    );
  if (kind === "unknown-control")
    form.insertAdjacentHTML(
      "beforeend",
      '<button type="button" aria-label="Unrecognized attachment control">X</button>',
    );
  if (kind === "two-composers")
    form.insertAdjacentHTML(
      "beforeend",
      '<textarea data-testid="prompt-textarea"></textarea>',
    );
  if (kind === "active-generation")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button data-testid="stop-button">Stop</button>',
    );
  if (kind === "no-file-input")
    document.querySelector('input[type="file"]')!.remove();
  const before = document.body.innerHTML,
    draft = composer().value;
  expect(originalProbe()).toBe(false);
  expect(composer().value).toBe(draft);
  expect(document.body.innerHTML).toBe(before);
  expect(sends).toBe(0);
});
it("a navigation between host observation and page script refuses without touching the composer", () => {
  composer().value = "keep";
  expect(
    execute(
      connectionCheckDocumentProbe(appName, originalHref),
      "https://chatgpt.com/c/replaced",
    ),
  ).toBe(false);
  expect(composer().value).toBe("keep");
  expect(sends).toBe(0);
});
it("prepares the exact Go prompt and activates only the exact temporary/app/model/composer document", () => {
  const prepared = execute(
    prepareTaskScript(prompt, temporaryHref, appName, undefined, true),
  );
  expect(prepared).toMatchObject({ ready: true, preparedComposerText: prompt });
  expect(composer().value).toBe(prompt);
  expect(sends).toBe(0);
  expect(activate()).toEqual({ activated: true });
  expect(sends).toBe(1);
});
it.each([
  "text-changed",
  "app-changed",
  "second-app",
  "model-changed",
  "second-model",
  "temporary-lost",
  "personalization-lost",
  "staged-file",
  "active-generation",
  "send-other-form",
])("final %s fence prevents the sole Send activation", (kind) => {
  composer().value = prompt;
  const form = document.querySelector("form")!;
  if (kind === "text-changed") composer().value += " owner edit";
  if (kind === "app-changed")
    document
      .querySelector('[data-testid="composer-app-chip"]')!
      .setAttribute("data-app-name", "Different app");
  if (kind === "second-app")
    form.insertAdjacentHTML(
      "beforeend",
      '<span data-testid="composer-app-chip" data-app-name="Other" data-app-id="plugin_asdk_app_other">Other</span>',
    );
  if (kind === "model-changed")
    document.querySelector('[aria-label="Select ChatGPT model"]')!.textContent =
      "Pro";
  if (kind === "second-model")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button aria-label="Select ChatGPT model">Instant</button>',
    );
  if (kind === "temporary-lost")
    document.querySelector('[aria-label="Turn off temporary chat"]')!.remove();
  if (kind === "personalization-lost")
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent === "Personalized")!
      .remove();
  if (kind === "staged-file")
    Object.defineProperty(
      document.querySelector('input[type="file"]')!,
      "files",
      { value: { length: 1 } },
    );
  if (kind === "active-generation")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button data-testid="stop-button">Stop</button>',
    );
  if (kind === "send-other-form") {
    document.body.insertAdjacentHTML("beforeend", '<form id="other"></form>');
    document
      .querySelector('[data-testid="send-button"]')!
      .setAttribute("form", "other");
  }
  const draft = composer().value;
  expect(activate()).not.toEqual({ activated: true });
  expect(sends).toBe(0);
  expect(composer().value).toBe(draft);
});
