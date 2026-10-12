import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { containWindowOpenFailure } from "../../src/apps/desktop/lifecycle-policy";

// Actual menu callbacks with controlled native ports; not packaged UI evidence.
async function host(
  options: {
    quit?: boolean;
    quitWhileOpening?: boolean;
    emptyImage?: boolean;
    fail?: boolean;
  } = {},
) {
  const source = await readFile(
    path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
    "utf8",
  );
  const callbacks = ["desktopBrandImage", "requestAbout"].map((name) => {
    const begin = source.indexOf(`function ${name}()`),
      end = source.indexOf("\nfunction ", begin + 1);
    return source
      .slice(begin, end)
      .replace("function requestAbout(): void", "function requestAbout()");
  });
  const open = vi.fn(async (_options: unknown) => {
    if (options.fail) throw Error("open failed");
  });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const context: Record<string, any> = {
    quitInProgress: options.quit ?? false,
    installedUpdateAdmission: false,
    directory: "/app",
    path,
    activeDesktopIdentity: { environment: "preview" },
    displayProductName: "Farol",
    displayEdition: "",
    windowMode: "hidden",
    buildIdentity: { version: "0.2.2", builtAt: "2026-10-12T17:00:00Z" },
    window: { isDestroyed: () => false },
    aboutPanel: null,
    ABOUT_PANEL_SIZE: { width: 340, height: 330 },
    selectedVisibleTestPlacement: vi.fn(),
    DesktopAboutPanel: class {
      open = open;
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => options.emptyImage ?? false,
        toDataURL: () => "data:image/png;base64,YQ==",
      }),
    },
    ensureWindow: async () => {
      if (options.quitWhileOpening) context.quitInProgress = true;
    },
    recoverWindowOpenFailure: vi.fn(),
    containWindowOpenFailure,
    console: { error: vi.fn() },
  };
  let aboutOpen = false;
  Object.defineProperty(context, "aboutOpen", {
    get: () => aboutOpen,
    set: (value) => {
      aboutOpen = value;
      if (!value) finish();
    },
  });
  const request = vm.runInNewContext(
    callbacks.join("\n") + "\nrequestAbout",
    context,
  ) as () => void;
  request();
  request();
  if (!options.quit) await done;
  return { open, context, source };
}
describe("About menu command", () => {
  it("opens one branded panel and leaves build/source details out", async () => {
    const f = await host();
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0]?.[0]).toMatchObject({
      name: "Farol",
      version: "0.2.2",
      builtAt: "2026-10-12T17:00:00Z",
      mode: "hidden",
    });
    expect(f.source).toContain("click: requestAbout");
  });
  it.each([{ quit: true }, { quitWhileOpening: true }, { emptyImage: true }])(
    "does not open after invalid admission %j",
    async (options) => {
      const f = await host(options);
      expect(f.open).not.toHaveBeenCalled();
    },
  );
  it("contains panel failure without tearing down the shell", async () => {
    const f = await host({ fail: true });
    expect(f.context.console.error).toHaveBeenCalledWith(
      "DESKTOP_ABOUT_PRESENTATION_FAILED",
    );
    expect(f.context.window).not.toBeNull();
    expect(f.context.aboutOpen).toBe(false);
  });
});
