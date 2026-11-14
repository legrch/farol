import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: {},
  systemPreferences: {},
}));
import {
  openInstantPowerPickerScript,
  temporaryInstantProfileProbe,
  lowerInstantPowerSliderScript,
  dismissInstantPowerPickerScript,
  openTemporaryPersonalizationScript,
  selectTemporaryPersonalizationScript,
} from "../../src/apps/desktop/chatgpt/scripts";

// DOM event contract only; real provider handling is a separate Dev witness.
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function slider() {
  const element = document.createElement("span");
  element.setAttribute("role", "slider");
  element.tabIndex = 0;
  element.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
  document.body.append(element);
  return element;
}
it("opens only a single enabled model control", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Select ChatGPT model");
  button.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
  button.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  const clicked = vi.fn();
  button.addEventListener("click", clicked);
  document.body.append(button);
  button.disabled = true;
  expect(window.eval(openInstantPowerPickerScript)).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
  button.disabled = false;
  button.setAttribute("aria-disabled", "true");
  expect(window.eval(openInstantPowerPickerScript)).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
  button.removeAttribute("aria-disabled");
  const duplicate = button.cloneNode() as HTMLButtonElement;
  duplicate.getClientRects = button.getClientRects;
  duplicate.getBoundingClientRect = button.getBoundingClientRect;
  document.body.append(duplicate);
  expect(window.eval(openInstantPowerPickerScript)).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
  duplicate.style.visibility = "hidden";
  expect(window.eval(openInstantPowerPickerScript)).toBe(true);
  expect(clicked).toHaveBeenCalledTimes(1);
  duplicate.remove();
  expect(window.eval(openInstantPowerPickerScript)).toBe(true);
  expect(clicked).toHaveBeenCalledTimes(2);
});
it("does not mark a disabled or ambiguous model control ready", () => {
  const composer = document.createElement("textarea");
  composer.id = "prompt-textarea";
  composer.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Select ChatGPT model");
  button.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  document.body.append(composer, button);
  button.disabled = true;
  expect(window.eval(temporaryInstantProfileProbe).modelReady).toBe(false);
  button.disabled = false;
  expect(window.eval(temporaryInstantProfileProbe).modelReady).toBe(true);
  button.setAttribute("aria-disabled", "true");
  expect(window.eval(temporaryInstantProfileProbe).modelReady).toBe(false);
  button.removeAttribute("aria-disabled");
  const duplicate = button.cloneNode() as HTMLButtonElement;
  duplicate.getBoundingClientRect = button.getBoundingClientRect;
  document.body.append(duplicate);
  expect(window.eval(temporaryInstantProfileProbe).modelReady).toBe(false);
});
it("selects Russian personalization controls only when each target is unique", () => {
  const button = document.createElement("button");
  button.textContent = "Без персонализации";
  button.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
  const opened = vi.fn();
  button.addEventListener("click", opened);
  const option = document.createElement("div");
  option.setAttribute("role", "menuitemradio");
  option.textContent =
    "Персонализированный Этот чат может использовать память, плагины и пользовательские инструкции";
  option.getClientRects = button.getClientRects;
  const selected = vi.fn();
  option.addEventListener("click", selected);
  document.body.append(button, option);
  expect(window.eval(openTemporaryPersonalizationScript)).toBe(true);
  expect(window.eval(selectTemporaryPersonalizationScript)).toBe(true);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledTimes(1);
  const duplicateButton = button.cloneNode(true) as HTMLButtonElement;
  const duplicateOption = option.cloneNode(true) as HTMLElement;
  duplicateButton.getClientRects = button.getClientRects;
  duplicateOption.getClientRects = option.getClientRects;
  document.body.append(duplicateButton, duplicateOption);
  expect(window.eval(openTemporaryPersonalizationScript)).toBe(false);
  expect(window.eval(selectTemporaryPersonalizationScript)).toBe(false);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledTimes(1);
});
it("addresses the visible page control without native window keyboard input", () => {
  const control = slider();
  const keys: string[] = [];
  control.addEventListener("keydown", (event) =>
    keys.push((event as KeyboardEvent).key),
  );
  control.addEventListener("keyup", (event) =>
    keys.push((event as KeyboardEvent).key),
  );
  expect(window.eval(lowerInstantPowerSliderScript)).toBe(true);
  expect(document.activeElement).toBe(control);
  expect(keys).toEqual(["ArrowLeft", "ArrowLeft"]);
});
it("refuses an ambiguous visible slider set without touching either control", () => {
  const first = slider();
  const second = slider();
  const changed = vi.fn();
  first.addEventListener("keydown", changed);
  second.addEventListener("keydown", changed);
  expect(window.eval(lowerInstantPowerSliderScript)).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});
it("refuses a missing control instead of falling back to global keyboard input", () => {
  expect(window.eval(lowerInstantPowerSliderScript)).toBe(false);
});
it("dismisses the opened picker through the page Escape handler", () => {
  const escaped = vi.fn();
  document.addEventListener("keydown", escaped, { once: true });
  expect(window.eval(dismissInstantPowerPickerScript)).toBe(true);
  expect(escaped).toHaveBeenCalledWith(
    expect.objectContaining({ key: "Escape", bubbles: true }),
  );
});
