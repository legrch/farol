import { afterEach, expect, it, vi } from "vitest";
import {
  activateTaskScript,
  bindChatGptAppScript,
  prepareTaskScript,
} from "../../src/apps/desktop/chatgpt-route";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function composer() {
  document.body.innerHTML = `<form><span data-testid="composer-app-chip" aria-label="Farol"></span><textarea id="prompt-textarea"></textarea><input type="file"><button type="button" data-testid="send-button">Send</button></form>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
  const text = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const send = document.querySelector<HTMLButtonElement>("button")!;
  const click = vi.spyOn(send, "click");
  return { text, file, send, click };
}

it("does not prepare a manual test over a selected file", () => {
  const { text, file, click } = composer();
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(text.value).toBe("");
  expect(click).not.toHaveBeenCalled();
});

it("does not touch a draft attachment while binding the app", async () => {
  const { text, file, click } = composer();
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  await expect(
    window.eval(bindChatGptAppScript("Farol", location.href, true)),
  ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
  expect(text.value).toBe("");
  expect(click).not.toHaveBeenCalled();
});

it("does not send if an attachment appears after preparation", () => {
  const { text, file, click } = composer();
  text.value = "check";
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("does not send a changed composer or visible attachment preview", () => {
  const { text, click } = composer();
  text.value = "other draft";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  text.value = "check";
  const preview = document.createElement("div");
  preview.dataset.testid = "attachment-preview";
  document.querySelector("form")!.append(preview);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("sends only the unchanged manual prompt with a recognized empty composer", () => {
  const { text, click } = composer();
  text.value = "check";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it("refuses an unrecognized composer or an unknown visible control", () => {
  const { text, file, click } = composer();
  text.value = "check";
  file.remove();
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  document.querySelector("form")!.append(file);
  const control = document.createElement("button");
  control.setAttribute("aria-label", "Unknown control");
  document.querySelector("form")!.append(control);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("refuses an ambiguous composer or a Send button owned by another form", () => {
  const { text, send, click } = composer();
  text.value = "check";
  const second = document.createElement("textarea");
  second.dataset.testid = "prompt-textarea";
  document.body.append(second);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  second.remove();
  const other = document.createElement("form");
  document.body.append(other);
  other.append(send);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("accepts the exact prompt beside the selected inline app link", () => {
  document.body.innerHTML = `<form><div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true"><a href="/plugins/plugin_asdk_app_abcdef">Farol</a>check</div><input type="file"><button type="button" data-testid="send-button">Send</button></form>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
  const click = vi.spyOn(
    document.querySelector<HTMLButtonElement>("button")!,
    "click",
  );
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it("refuses changed whitespace in a prepared prompt", () => {
  const { text, click } = composer();
  text.value = " check";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});
