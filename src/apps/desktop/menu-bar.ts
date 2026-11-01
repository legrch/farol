import { Menu, Tray, nativeImage } from "electron";
import {
  menuBarTemplate1x,
  menuBarTemplate2x,
  menuBarHollowTemplate1x,
  menuBarHollowTemplate2x,
  menuBarAttentionTemplate1x,
  menuBarAttentionTemplate2x,
} from "./menu-bar-assets";
import type { ConnectionStatusView } from "../../../apps/desktop/renderer/connection-status";

type IconState = "filled" | "hollow" | "attention";
export function menuBarIconState(
  state: ConnectionStatusView["state"],
  attached: boolean,
): IconState {
  if (state === "checking" || state === "reconnecting") return "hollow";
  if (state === "recent_transport") return attached ? "filled" : "hollow";
  return "attention";
}

type MenuBarStatus = Readonly<{
  label: string;
  current: string | null;
  icon?: IconState;
}>;

/** Native lifetime owned by the host. Commands use the same app routing. */
export function createMenuBar(
  actions: Readonly<{
    open: () => void;
    current?: () => void;
    updates?: () => void;
    quit: () => void;
  }>,
  status: () => MenuBarStatus,
): () => void {
  const makeImage = (one: string, two: string) => {
    const image = nativeImage.createFromBuffer(Buffer.from(one, "base64"));
    image.addRepresentation({
      scaleFactor: 2,
      buffer: Buffer.from(two, "base64"),
    });
    if (image.isEmpty()) throw new Error("MENU_BAR_TEMPLATE_INVALID");
    image.setTemplateImage(true);
    return image;
  };
  const images = {
    filled: makeImage(menuBarTemplate1x, menuBarTemplate2x),
    hollow: makeImage(menuBarHollowTemplate1x, menuBarHollowTemplate2x),
    attention: makeImage(
      menuBarAttentionTemplate1x,
      menuBarAttentionTemplate2x,
    ),
  };
  const tray = new Tray(images.attention);
  let currentIcon: IconState = "attention";
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const readStatus = (): MenuBarStatus => {
    try {
      return status();
    } catch {
      return {
        label: "Farol · Status unavailable",
        current: null,
        icon: "attention",
      };
    }
  };
  const openMenu = () => {
    if (disposed) return;
    const value = readStatus();
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: value.label, enabled: false },
        { type: "separator" },
        { label: "Open Farol", click: actions.open },
        ...(value.current && actions.current
          ? [{ label: value.current, click: actions.current }]
          : []),
        ...(actions.updates
          ? [{ label: "Check for Updates…", click: actions.updates }]
          : []),
        { type: "separator" },
        { label: "Quit Farol", click: actions.quit },
      ]),
    );
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    tray.removeListener("click", openMenu);
    tray.removeListener("right-click", openMenu);
    tray.destroy();
  };
  const refresh = () => {
    if (disposed) return;
    const value = readStatus();
    tray.setToolTip(value.label);
    const icon = value.icon ?? "attention";
    if (icon !== currentIcon) {
      tray.setImage(images[icon]);
      currentIcon = icon;
    }
  };
  try {
    tray.setIgnoreDoubleClickEvents(true);
    tray.on("click", openMenu);
    tray.on("right-click", openMenu);
    refresh();
    // Observe only the supplied projection; no health, permission or recovery
    // command is dispatched by a status-item refresh.
    timer = setInterval(() => {
      try {
        refresh();
      } catch {
        try {
          dispose();
        } catch {
          // Cleanup was attempted once; do not retry a native status lifetime.
        }
        console.warn("FAROL_MENU_BAR_UNAVAILABLE");
      }
    }, 1_000);
    timer.unref();
  } catch (error) {
    try {
      dispose();
    } catch {
      console.warn("FAROL_MENU_BAR_UNAVAILABLE");
    }
    throw error;
  }
  return dispose;
}
