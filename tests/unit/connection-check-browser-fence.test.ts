// @vitest-environment jsdom
import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
  systemPreferences: {},
}));
import {
  prepareTaskScript,
  activateTaskScript,
} from "../../src/apps/desktop/chatgpt/scripts.ts";

// Execute the REAL injected scripts against a closed DOM fixture. This is not
// a witness of current ChatGPT markup, Electron navigation or a provider Send.
const appName = "Farol Dev";
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
const activate = () =>
  execute(
    activateTaskScript(temporaryHref, appName, true, false, prompt, true),
  );

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
// The badge and the personalization control are decorations the page may
// rename, move or drop. The address decides a Temporary chat, and
// personalization is optional, so neither one's absence stops the Send.
it("still sends when the temporary badge and the personalization control are gone", () => {
  composer().value = prompt;
  document.querySelector('[aria-label="Turn off temporary chat"]')!.remove();
  [...document.querySelectorAll("button")]
    .find((x) => x.textContent === "Personalized")!
    .remove();
  expect(activate()).toEqual({ activated: true });
  expect(sends).toBe(1);
});
it("does not send when the address is no longer a temporary chat", () => {
  composer().value = prompt;
  expect(
    execute(
      activateTaskScript("https://chatgpt.com/", appName, true, false),
      "https://chatgpt.com/",
    ),
  ).not.toEqual({ activated: true });
  expect(sends).toBe(0);
});
