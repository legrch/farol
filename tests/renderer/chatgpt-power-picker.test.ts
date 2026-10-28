import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: {},
  systemPreferences: {},
}));
import {
  lowerInstantPowerSliderScript,
  dismissInstantPowerPickerScript,
} from "../../src/apps/desktop/chatgpt-route";

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
