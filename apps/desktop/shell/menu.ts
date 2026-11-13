import type {
  BrowserWindow,
  MenuItemConstructorOptions,
  Rectangle,
} from "electron";
import type { WindowOpenOutcome } from "../../../src/apps/desktop/lifecycle-policy";
import type { SidebarShortcut } from "../../../src/pkg/ipc/navigation-shortcuts";
import type { AboutPanelOptions } from "../about-panel";

/** The owner commands the application menu invokes. Each one decides on its
 * own whether Quit or an installed-update admission refuses it. */
export type ApplicationMenuActions = Readonly<{
  about: () => void;
  updates: () => void;
  settings: () => void;
  toggleSidebar: () => void;
  quickSwitcher: () => void;
}>;

/** Everything the application menu template is decided from. */
export type ApplicationMenuInput = Readonly<{
  /** `process.platform`: macOS gets the app menu, others a File menu. */
  platform: NodeJS.Platform;
  /** The identity's display name: Farol, Farol Dev or Farol Preview. */
  productName: string;
  /** The owner's Show/Hide Sidebar letter, or "off" for no accelerator. */
  sidebarShortcut: SidebarShortcut;
  actions: ApplicationMenuActions;
}>;

/** The native application menu template; no Electron call is made here. */
export function applicationMenu(
  input: ApplicationMenuInput,
): MenuItemConstructorOptions[] {
  const { actions, productName, sidebarShortcut } = input;
  return [
    ...(input.platform === "darwin"
      ? ([
          {
            label: productName,
            submenu: [
              {
                id: "app.about",
                label: `About ${productName}`,
                click: actions.about,
              },
              {
                id: "app.updates",
                label: "Check for Updates…",
                click: () => {
                  actions.updates();
                },
              },
              { type: "separator" },
              {
                id: "app.settings",
                label: "Settings…",
                accelerator: "CommandOrControl+,",
                click: actions.settings,
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
          },
        ] satisfies MenuItemConstructorOptions[])
      : ([
          {
            label: "File",
            submenu: [
              {
                id: "app.settings",
                label: "Settings",
                accelerator: "CommandOrControl+,",
                click: actions.settings,
              },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])),
    {
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
    },
    {
      label: "View",
      submenu: [
        {
          id: "view.toggle-sidebar",
          label: "Show/Hide Sidebar",
          ...(sidebarShortcut === "off"
            ? {}
            : {
                accelerator: `Control+Command+${sidebarShortcut.toUpperCase()}`,
              }),
          click: actions.toggleSidebar,
        },
        {
          id: "view.quick-switcher",
          label: "Quick Switcher",
          accelerator: "CommandOrControl+K",
          click: actions.quickSwitcher,
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}

/** Live main-process state and native ports the About command reads. */
export type AboutCommandPorts = Readonly<{
  /** True while Quit or an installed-update admission owns the shell. */
  closed: () => boolean;
  /** Opens or reveals the main window, containing an open failure. */
  openWindow: () => Promise<WindowOpenOutcome>;
  window: () => BrowserWindow | null;
  /** The About panel, created on first use. */
  panel: () => { open(options: AboutPanelOptions): Promise<void> };
  name: string;
  version: string;
  builtAt: string;
  mode: AboutPanelOptions["mode"];
  /** The verified brand artwork as a data URL; throws when it is invalid. */
  icon: () => string;
  place: () => Rectangle;
}>;

/** The About menu command: one branded panel at a time, refused during Quit
 * and installed-update admission, with presentation failures contained. */
export function aboutCommand(ports: AboutCommandPorts): () => void {
  let open = false;
  return () => {
    if (ports.closed() || open) return;
    open = true;
    // A dedicated panel uses the verified Farol artwork without inheriting the
    // vendor runtime icon or exposing technical release identity in the UI.
    void ports
      .openWindow()
      .then(async (outcome) => {
        if (outcome !== "opened") return;
        try {
          const owner = ports.window();
          if (ports.closed() || !owner || owner.isDestroyed()) return;
          await ports.panel().open({
            owner,
            name: ports.name,
            version: ports.version,
            builtAt: ports.builtAt,
            icon: ports.icon(),
            mode: ports.mode,
            place: ports.place,
          });
        } catch {
          console.error("DESKTOP_ABOUT_PRESENTATION_FAILED");
        }
      })
      .finally(() => {
        open = false;
      });
  };
}
