import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { containWindowOpenFailure } from "../../src/apps/desktop/lifecycle-policy";

// Execute the actual native callbacks with controlled Electron ports. These
// regressions do not prove the native image, window, or focus on the Mac.
async function host({
  environment = "dev",
  quitting = false,
  applying = false,
  quitWhileOpening = false,
  applyWhileOpening = false,
  emptyImage = false,
  holdDialog = false,
  openFails = false,
  dialogFails = false,
} = {}) {
  const source = await readFile(
    path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
    "utf8",
  );
  const callbacks = ["desktopBrandImage", "requestAbout"].map((name) => {
    const begin = source.indexOf(`function ${name}()`);
    const end = source.indexOf("\nfunction ", begin + 1);
    if (begin < 0 || end < 0) throw Error(`ABOUT_CALLBACK_MISSING:${name}`);
    return source
      .slice(begin, end)
      .replace("function requestAbout(): void", "function requestAbout()");
  });
  const effects: string[] = [];
  const dialogs: { parent: unknown; options: Record<string, unknown> }[] = [];
  let finishDialog!: () => void;
  const dialog = new Promise<void>((resolve) => {
    finishDialog = resolve;
  });
  let reportDialog!: () => void;
  const dialogShown = new Promise<void>((resolve) => {
    reportDialog = resolve;
  });
  let pending: Promise<void> | undefined;
  let finishRequest: (() => void) | undefined;
  let aboutOpen = false;
  const parent = { isDestroyed: () => false };
  const image = { isEmpty: () => emptyImage };
  const context: Record<string, unknown> = {
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
    directory: "/controlled-app",
    activeDesktopIdentity: { environment },
    displayProductName: environment === "dev" ? "Farol Dev" : "Farol",
    displayEdition: environment === "dev" ? "Development" : null,
    buildIdentity: {
      version: "0.2.0-owner.beta.5",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    },
    path,
    window: parent,
    console: {
      error: (code: string) => effects.push(code),
    },
    nativeImage: {
      createFromPath: (file: string) => {
        effects.push(file);
        return image;
      },
    },
    ensureWindow: async () => {
      effects.push("open");
      if (openFails) throw Error("controlled open failure");
      if (quitWhileOpening) context.quitInProgress = true;
      if (applyWhileOpening) context.installedUpdateAdmission = true;
    },
    recoverWindowOpenFailure: () => {
      effects.push("recover");
      context.window = null;
    },
    containWindowOpenFailure,
    dialog: {
      showMessageBox: async (
        selected: unknown,
        options: Record<string, unknown>,
      ) => {
        dialogs.push({ parent: selected, options });
        reportDialog();
        if (dialogFails) throw Error("controlled dialog failure");
        if (holdDialog) await dialog;
      },
    },
  };
  Object.defineProperty(context, "aboutOpen", {
    get: () => aboutOpen,
    set: (open: boolean) => {
      aboutOpen = open;
      if (open)
        pending = new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
      else finishRequest?.();
    },
  });
  const request = vm.runInNewContext(
    `${callbacks.join("\n")}\nrequestAbout`,
    context,
  ) as () => void;
  return {
    request,
    source,
    effects,
    dialogs,
    context,
    parent,
    image,
    finishDialog,
    dialogShown,
    async settle() {
      await pending;
    },
  };
}

describe("native About uses the selected Farol artwork", () => {
  it.each([
    ["dev", "Farol Dev", "farol-dev-mark.png", " (Development)"],
    ["preview", "Farol", "farol-mark.png", ""],
  ])(
    "selects %s branding without the stock About action",
    async (environment, name, file, edition) => {
      const f = await host({ environment });
      f.request();
      await f.settle();
      expect(f.effects).toEqual(["open", `/controlled-app/${file}`]);
      expect(f.dialogs).toHaveLength(1);
      expect(f.dialogs[0]?.parent).toBe(f.parent);
      expect(f.dialogs[0]?.options).toMatchObject({
        title: `About ${name}`,
        message: name,
        detail: `Version 0.2.0-owner.beta.5${edition}\nSource 0123456789ab`,
        icon: f.image,
        buttons: ["OK"],
        cancelId: 0,
      });
      expect(f.context.aboutOpen).toBe(false);
      expect(f.source).toContain('id: "app.about"');
      expect(f.source).toContain("click: requestAbout");
      expect(f.source).not.toContain('role: "about"');
    },
  );

  it("coalesces clicks while the original native sheet is open", async () => {
    const f = await host({ holdDialog: true });
    f.request();
    f.request();
    await f.dialogShown;
    f.request();
    expect(f.dialogs).toHaveLength(1);
    expect(f.effects).toHaveLength(2);
    expect(f.context.aboutOpen).toBe(true);
    f.finishDialog();
    await f.settle();
    expect(f.context.aboutOpen).toBe(false);
    f.request();
    await f.settle();
    expect(f.dialogs).toHaveLength(2);
  });

  it.each([{ quitting: true }, { applying: true }])(
    "does not open a native window during an admitted transition %j",
    async (options) => {
      const f = await host(options);
      f.request();
      await f.settle();
      expect(f.effects).toEqual([]);
      expect(f.dialogs).toEqual([]);
      expect(f.context.aboutOpen).toBe(false);
    },
  );

  it.each([{ quitWhileOpening: true }, { applyWhileOpening: true }])(
    "rechecks presentation admission after opening %j",
    async (options) => {
      const f = await host(options);
      f.request();
      await f.settle();
      expect(f.effects).toEqual(["open"]);
      expect(f.dialogs).toEqual([]);
      expect(f.context.aboutOpen).toBe(false);
    },
  );

  it("contains an invalid brand image without tearing down the main window", async () => {
    const f = await host({ emptyImage: true });
    f.request();
    await f.settle();
    expect(f.effects).toEqual([
      "open",
      "/controlled-app/farol-dev-mark.png",
      "DESKTOP_ABOUT_PRESENTATION_FAILED",
    ]);
    expect(f.dialogs).toEqual([]);
    expect(f.context.window).toBe(f.parent);
    expect(f.context.aboutOpen).toBe(false);
  });

  it("contains a rejected About sheet without tearing down the main window", async () => {
    const f = await host({ dialogFails: true });
    f.request();
    await f.settle();
    expect(f.effects).toEqual([
      "open",
      "/controlled-app/farol-dev-mark.png",
      "DESKTOP_ABOUT_PRESENTATION_FAILED",
    ]);
    expect(f.context.window).toBe(f.parent);
    expect(f.context.aboutOpen).toBe(false);
  });

  it("retains window recovery when the window itself cannot open", async () => {
    const f = await host({ openFails: true });
    f.request();
    await f.settle();
    expect(f.effects).toEqual(["open", "recover"]);
    expect(f.dialogs).toEqual([]);
    expect(f.context.window).toBeNull();
    expect(f.context.aboutOpen).toBe(false);
  });
});
