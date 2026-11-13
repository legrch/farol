import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarShortcut } from "../../../src/pkg/ipc/navigation-shortcuts";
import {
  aboutCommand,
  applicationMenu,
  type AboutCommandPorts,
  type ApplicationMenuActions,
} from "./menu";

// The template as plain data: each `click` becomes the name of the action it
// invokes, found by clicking it. No Electron menu is built.
function template(
  platform: NodeJS.Platform,
  productName: string,
  sidebarShortcut: SidebarShortcut,
) {
  const fired: string[] = [];
  const action = (name: keyof ApplicationMenuActions) => () => {
    fired.push(name);
  };
  const actions: ApplicationMenuActions = {
    about: action("about"),
    updates: action("updates"),
    settings: action("settings"),
    toggleSidebar: action("toggleSidebar"),
    quickSwitcher: action("quickSwitcher"),
  };
  const plain = (item: MenuItemConstructorOptions): unknown => {
    const { click, submenu, ...rest } = item;
    const out: Record<string, unknown> = { ...rest };
    if (click) {
      fired.length = 0;
      (click as () => void)();
      expect(fired).toHaveLength(1);
      out.click = fired[0];
    }
    if (submenu)
      out.submenu = (submenu as MenuItemConstructorOptions[]).map(plain);
    return out;
  };
  return applicationMenu({
    platform,
    productName,
    sidebarShortcut,
    actions,
  }).map(plain);
}

const edit = {
  label: "Edit",
  submenu: [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ],
};

function view(accelerator: string | null) {
  return {
    label: "View",
    submenu: [
      {
        id: "view.toggle-sidebar",
        label: "Show/Hide Sidebar",
        ...(accelerator === null ? {} : { accelerator }),
        click: "toggleSidebar",
      },
      {
        id: "view.quick-switcher",
        label: "Quick Switcher",
        accelerator: "CommandOrControl+K",
        click: "quickSwitcher",
      },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

function macApp(name: string) {
  return {
    label: name,
    submenu: [
      { id: "app.about", label: `About ${name}`, click: "about" },
      { id: "app.updates", label: "Check for Updates…", click: "updates" },
      { type: "separator" },
      {
        id: "app.settings",
        label: "Settings…",
        accelerator: "CommandOrControl+,",
        click: "settings",
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

const file = {
  label: "File",
  submenu: [
    {
      id: "app.settings",
      label: "Settings",
      accelerator: "CommandOrControl+,",
      click: "settings",
    },
    { type: "separator" },
    { role: "quit" },
  ],
};

// Display names of the production, Dev and Owner Preview identities.
const identities = ["Farol", "Farol Dev", "Farol Preview"] as const;
const shortcuts = [
  { sidebar: "s", accelerator: "Control+Command+S" },
  { sidebar: "b", accelerator: "Control+Command+B" },
  { sidebar: "off", accelerator: null },
] as const;

describe("applicationMenu", () => {
  for (const name of identities)
    for (const { sidebar, accelerator } of shortcuts) {
      it(`pins the macOS template for ${name}, sidebar ${sidebar}`, () => {
        expect(template("darwin", name, sidebar)).toEqual([
          macApp(name),
          edit,
          view(accelerator),
          { role: "windowMenu" },
        ]);
      });
      for (const platform of ["linux", "win32"] as const)
        it(`pins the ${platform} template for ${name}, sidebar ${sidebar}`, () => {
          expect(template(platform, name, sidebar)).toEqual([
            file,
            edit,
            view(accelerator),
            { role: "windowMenu" },
          ]);
        });
    }
});

// The About command with controlled native ports; not packaged UI evidence.
function about(
  options: {
    quit?: boolean;
    quitWhileOpening?: boolean;
    openFailed?: boolean;
    destroyed?: boolean;
    noWindow?: boolean;
    emptyImage?: boolean;
    fail?: boolean;
  } = {},
) {
  let quitting = options.quit ?? false;
  const open = vi.fn(async (_options: unknown) => {
    if (options.fail) throw Error("open failed");
  });
  const panel = vi.fn(() => ({ open }));
  const owner = {
    isDestroyed: () => options.destroyed ?? false,
  } as unknown as BrowserWindow;
  const place = vi.fn(() => ({ x: 0, y: 0, width: 340, height: 330 }));
  const openWindow = vi.fn(async () => {
    if (options.quitWhileOpening) quitting = true;
    return options.openFailed ? ("failed" as const) : ("opened" as const);
  });
  const ports: AboutCommandPorts = {
    closed: () => quitting,
    openWindow,
    window: () => (options.noWindow ? null : owner),
    panel,
    name: "Farol",
    version: "0.2.2",
    builtAt: "2026-10-12T17:00:00Z",
    mode: "hidden",
    icon: () => {
      if (options.emptyImage) throw new Error("DESKTOP_BRAND_IMAGE_INVALID");
      return "data:image/png;base64,YQ==";
    },
    place,
  };
  const request = aboutCommand(ports);
  return { request, open, panel, openWindow, owner, place };
}

describe("aboutCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens one branded panel and leaves build/source details out", async () => {
    const f = about();
    f.request();
    f.request();
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    expect(f.openWindow).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0]?.[0]).toEqual({
      owner: f.owner,
      name: "Farol",
      version: "0.2.2",
      builtAt: "2026-10-12T17:00:00Z",
      icon: "data:image/png;base64,YQ==",
      mode: "hidden",
      place: f.place,
    });
  });

  it("refuses a second request while one is open and admits one after it", async () => {
    let release!: () => void;
    const f = about();
    f.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    f.request();
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.request();
    expect(f.openWindow).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(async () => {
      f.request();
      expect(f.openWindow).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    { quit: true },
    { quitWhileOpening: true },
    { openFailed: true },
    { destroyed: true },
    { noWindow: true },
  ])("does not open after invalid admission %j", async (options) => {
    const f = about(options);
    f.request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.panel).not.toHaveBeenCalled();
    if (options.quit) expect(f.openWindow).not.toHaveBeenCalled();
  });

  it.each([{ emptyImage: true }, { fail: true }])(
    "contains panel failure %j without tearing down the shell",
    async (options) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = about(options);
      f.request();
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith("DESKTOP_ABOUT_PRESENTATION_FAILED"),
      );
      // An invalid brand image fails before the panel is asked to open.
      expect(f.open).toHaveBeenCalledTimes(options.emptyImage ? 0 : 1);
      // The command is released: a later request reaches the window again.
      await vi.waitFor(() => {
        f.request();
        expect(f.openWindow).toHaveBeenCalledTimes(2);
      });
    },
  );
});
