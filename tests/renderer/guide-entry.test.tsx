import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controller: vi.fn(() => {
    throw new Error("GUIDE_TOUCHED_CONTROLLER");
  }),
  shell: vi.fn(() => {
    throw new Error("GUIDE_TOUCHED_SHELL");
  }),
}));
vi.mock("../../src/ui/renderer/controller", () => ({
  WindowController: mocks.controller,
}));
vi.mock("../../src/ui/renderer/shell", () => ({ Shell: mocks.shell }));

const browserWindow = window;

afterEach(async () => {
  await act(async () => browserWindow.dispatchEvent(new Event("pagehide")));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function enter(url: string) {
  vi.resetModules();
  const bridge = vi.fn(() => {
    throw new Error("GUIDE_TOUCHED_BRIDGE");
  });
  const storage = vi.spyOn(Storage.prototype, "getItem");
  const writes = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    new Proxy(browserWindow, {
      get(target, key) {
        if (key === "location") return new URL(url);
        if (key === "farol") return bridge();
        if (key === "addEventListener")
          return target.addEventListener.bind(target);
        return Reflect.get(target, key, target);
      },
    }),
  );
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("../../src/ui/renderer/entry");
  });
  return { bridge, storage, writes };
}

it("renders the existing guide open without a preload bridge, controller or stored state", async () => {
  const { bridge, storage, writes } = await enter(
    "file:///controlled/Farol%20Dev.app/Contents/Resources/app/shell.html#farol-connection-guide",
  );
  expect(document.title).toBe("Farol connection guide");
  const guide =
    document.querySelector<HTMLDetailsElement>(".connection-guide")!;
  expect(guide.open).toBe(true);
  expect(guide.querySelectorAll("li")).toHaveLength(5);
  expect(guide.textContent).toContain("Sign in.");
  expect(guide.textContent).toContain("inspect it before trying again");
  expect(document.querySelectorAll("button, input, a")).toHaveLength(0);
  expect(bridge).not.toHaveBeenCalled();
  expect(mocks.controller).not.toHaveBeenCalled();
  expect(mocks.shell).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});

it.each([
  "https://example.invalid/shell.html#farol-connection-guide",
  "file://remote-host/app/shell.html#farol-connection-guide",
  "file:///controlled/other.html#farol-connection-guide",
  "file:///controlled/shell.html?provider=anything#farol-connection-guide",
  "file:///controlled/shell.html#unsupported-guide",
])("refuses unsupported guide document mode: %s", async (url) => {
  await expect(enter(url)).rejects.toThrow("GUIDE_DOCUMENT_MODE_INVALID");
  expect(document.getElementById("root")?.childElementCount).toBe(0);
  expect(mocks.controller).not.toHaveBeenCalled();
  expect(mocks.shell).not.toHaveBeenCalled();
});
