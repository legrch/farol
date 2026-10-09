import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { onboardingHelpUrl } from "../../src/apps/desktop/onboarding-help";
import { presentationAction } from "../../src/apps/desktop/lifecycle-policy";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";

// Execute only the actual help case with native objects replaced by mocks.
// This is source routing evidence, not an Electron or packaged-app test.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(main, { sourceType: "module", plugins: ["typescript"] });
let helpCase;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.type === "StringLiteral" &&
    node.test.value === "onboarding.open-help"
  )
    helpCase = main.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach((child) => {
        if (child?.type) visit(child);
      });
    else if (value?.type) visit(value);
  }
}
visit(tree);
if (!helpCase) throw new Error("ONBOARDING_HELP_CASE_MISSING");
const compiled = `async function handle() { switch (command.kind) { ${helpCase} } } handle`;

function harness(
  mode = "default",
  destination = "setup-guide",
  failLoad = false,
) {
  const guides = [];
  const screen = new EventEmitter();
  const parent = new EventEmitter();
  parent.isDestroyed = vi.fn(() => false);
  const bounds = { x: -1400, y: 500, width: 800, height: 680 };
  class Guide extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = vi.fn();
      this.isDestroyed = vi.fn(() => false);
      this.destroy = vi.fn(() => {
        this.isDestroyed.mockReturnValue(true);
        this.emit("closed");
      });
      this.loadURL = vi.fn(async () => {
        if (failLoad) throw new Error("controlled load failure");
      });
      this.show = vi.fn();
      this.hide = vi.fn();
      this.showInactive = vi.fn();
      this.setBounds = vi.fn();
      guides.push(this);
    }
  }
  const snapshot = { status: "controlled-source-test" };
  const context = {
    command: { kind: "onboarding.open-help", destination },
    window: parent,
    screen,
    windowMode: mode,
    directory: "/controlled/Farol Dev.app/Contents/Resources/app",
    BrowserWindow: Guide,
    selectedVisibleTestPlacement: vi.fn(() => ({ bounds })),
    presentationAction,
    onboardingHelpUrl,
    shell: { openExternal: vi.fn(async () => {}) },
    configuration: { snapshot: () => snapshot },
    ProductConfigurationResultSchema: { parse: (value) => value },
    configurationFailure: (code) => ({ ok: false, code }),
  };
  return {
    handle: vm.runInNewContext(stripTypeScriptTypes(compiled), context),
    context,
    guides,
    parent,
    bounds,
    screen,
  };
}

describe("local guide host composition", () => {
  it.each(["default", "secondary-visible", "hidden"])(
    "uses controlled local bytes and existing %s presentation semantics",
    async (mode) => {
      const h = harness(mode);
      expect((await h.handle()).ok).toBe(true);
      expect(h.guides).toHaveLength(1);
      const guide = h.guides[0];
      expect(guide.options.webPreferences).toEqual({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "farol-connection-guide",
      });
      expect(guide.options.show).toBe(false);
      expect(guide.options.parent).toBe(h.parent);
      expect(guide.loadURL).toHaveBeenCalledExactlyOnceWith(
        onboardingHelpUrl("setup-guide", h.context.directory),
      );
      expect(h.context.shell.openExternal).not.toHaveBeenCalled();
      expect(guide.show).toHaveBeenCalledTimes(mode === "default" ? 1 : 0);
      expect(guide.showInactive).toHaveBeenCalledTimes(
        mode === "secondary-visible" ? 1 : 0,
      );
      if (mode === "secondary-visible") {
        expect(h.context.selectedVisibleTestPlacement).toHaveBeenCalledWith({
          width: 800,
          height: 680,
        });
        expect(guide.setBounds).toHaveBeenCalledWith(h.bounds);
      } else {
        expect(h.context.selectedVisibleTestPlacement).not.toHaveBeenCalled();
      }
      expect(guide.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual(
        { action: "deny" },
      );
      for (const eventName of ["will-navigate", "will-redirect"]) {
        const event = { preventDefault: vi.fn() };
        guide.webContents.emit(eventName, event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
      h.parent.emit("closed");
      expect(guide.destroy).toHaveBeenCalledOnce();
      expect(h.parent.listenerCount("closed")).toBe(0);
    },
  );

  it("cleans up a failed local load without opening an external fallback", async () => {
    const h = harness("default", "setup-guide", true);
    expect(await h.handle()).toEqual({
      ok: false,
      code: "ONBOARDING_HELP_OPEN_FAILED",
    });
    expect(h.guides[0].destroy).toHaveBeenCalledOnce();
    expect(h.parent.listenerCount("closed")).toBe(0);
    expect(h.context.shell.openExternal).not.toHaveBeenCalled();
    expect(h.guides[0].show).not.toHaveBeenCalled();
  });

  it("removes the parent listener when the owner closes the guide", async () => {
    const h = harness();
    await h.handle();
    h.guides[0].destroy();
    expect(h.parent.listenerCount("closed")).toBe(0);
    h.parent.emit("closed");
    expect(h.guides[0].destroy).toHaveBeenCalledOnce();
  });

  it("hides and requalifies every topology change, with no unavailable-display fallback", async () => {
    const h = harness("secondary-visible");
    await h.handle();
    const guide = h.guides[0];
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ]) {
      expect(h.screen.listenerCount(event)).toBe(1);
      guide.hide.mockClear();
      guide.showInactive.mockClear();
      const bounds = { x: -1000, y: 700, width: 800, height: 680 };
      h.context.selectedVisibleTestPlacement.mockReturnValue({ bounds });
      h.screen.emit(event);
      expect(guide.hide).toHaveBeenCalledOnce();
      expect(guide.setBounds).toHaveBeenLastCalledWith(bounds);
      expect(guide.showInactive).toHaveBeenCalledOnce();
      expect(guide.hide.mock.invocationCallOrder[0]).toBeLessThan(
        guide.showInactive.mock.invocationCallOrder[0],
      );
      guide.showInactive.mockClear();
      h.context.selectedVisibleTestPlacement.mockImplementation(() => {
        throw new Error("BUILT_IN_DISPLAY_UNAVAILABLE");
      });
      h.screen.emit(event);
      expect(guide.showInactive).not.toHaveBeenCalled();
      expect(guide.show).not.toHaveBeenCalled();
      expect(h.context.shell.openExternal).not.toHaveBeenCalled();
    }
    guide.destroy();
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ]) {
      expect(h.screen.listenerCount(event)).toBe(0);
      const calls = h.context.selectedVisibleTestPlacement.mock.calls.length;
      h.screen.emit(event);
      expect(h.context.selectedVisibleTestPlacement).toHaveBeenCalledTimes(
        calls,
      );
    }
  });

  it("does not reveal the guide before load completes during topology changes", async () => {
    const h = harness("secondary-visible");
    const pending = h.handle();
    const guide = h.guides[0];
    h.screen.emit("display-metrics-changed");
    expect(guide.hide).toHaveBeenCalledOnce();
    expect(guide.showInactive).not.toHaveBeenCalled();
    expect((await pending).ok).toBe(true);
    expect(guide.showInactive).toHaveBeenCalledOnce();
    guide.destroy();
    expect(h.screen.eventNames()).toEqual([]);
  });

  it("reports failure if the parent closes during the local load", async () => {
    const h = harness();
    const pending = h.handle();
    h.parent.isDestroyed.mockReturnValue(true);
    h.parent.emit("closed");
    expect(await pending).toEqual({
      ok: false,
      code: "ONBOARDING_HELP_OPEN_FAILED",
    });
    expect(h.guides[0].show).not.toHaveBeenCalled();
    expect(h.context.shell.openExternal).not.toHaveBeenCalled();
    expect(h.parent.listenerCount("closed")).toBe(0);
  });

  it("fails before creating a guide when display placement is unavailable", async () => {
    const h = harness("secondary-visible");
    h.context.selectedVisibleTestPlacement.mockImplementation(() => {
      throw new Error("BUILT_IN_DISPLAY_UNAVAILABLE");
    });
    expect((await h.handle()).ok).toBe(false);
    expect(h.guides).toHaveLength(0);
    expect(h.context.shell.openExternal).not.toHaveBeenCalled();
  });

  it("retains fixed external help and rejects untyped URL input", async () => {
    const external = harness("default", "tunnels");
    expect((await external.handle()).ok).toBe(true);
    expect(external.guides).toHaveLength(0);
    expect(external.context.shell.openExternal).toHaveBeenCalledExactlyOnceWith(
      onboardingHelpUrl("tunnels"),
    );
    const invalid = harness("default", "file:///arbitrary/document.html");
    expect((await invalid.handle()).ok).toBe(false);
    expect(invalid.guides).toHaveLength(0);
    expect(invalid.context.shell.openExternal).not.toHaveBeenCalled();
  });
});

it("targets resources already produced and registered for packaging", () => {
  const resource = path.basename(
    fileURLToPath(new URL(onboardingHelpUrl("setup-guide", "/controlled/app"))),
  );
  expect(BUILD_ENTRIES).toContain(resource);
  expect(BUILD_ENTRIES).toContain("shell.js");
  const build = fs.readFileSync("tooling/build.mjs", "utf8");
  expect(build).toContain('entryPoints: ["src/ui/renderer/entry.tsx"]');
  expect(build).toContain('outfile: "_output/build/app/shell.js"');
  expect(build).toContain('readBuildInput("src/ui/renderer/shell.html")');
  expect(build).toContain(
    'fs.writeFile("_output/build/app/shell.html", bytes)',
  );
  const html = fs.readFileSync("src/ui/renderer/shell.html", "utf8");
  expect(html).toContain('src="shell.js"');
  expect(html).toContain('href="shell.css"');
  expect(BUILD_ENTRIES).toContain("shell.css");
  const packager = fs.readFileSync("tooling/package.mjs", "utf8");
  expect(packager).toContain("for (const entry of entries)");
  expect(packager).toContain("path.join(appResources, entry)");
});
