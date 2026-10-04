import { Menu, Tray, nativeImage } from "electron";
import { menuBarTemplate1x, menuBarTemplate2x } from "./menu-bar-assets";
/** Native lifetime owned by the host. Commands use the same app routing. */
export function createMenuBar(
  actions: Readonly<{
    open: () => void;
    current: () => void;
    updates: () => void;
    quit: () => void;
  }>,
  status: () => Readonly<{ label: string; current: string | null }>,
): () => void {
  const image = nativeImage.createFromBuffer(
    Buffer.from(menuBarTemplate1x, "base64"),
  );
  image.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(menuBarTemplate2x, "base64"),
  });
  if (image.isEmpty()) throw new Error("MENU_BAR_TEMPLATE_INVALID");
  image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip("Farol");
  let disposed = false;
  const openMenu = () => {
    if (disposed) return;
    const value = status();
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: value.label, enabled: false },
        { type: "separator" },
        { label: "Open Farol", click: actions.open },
        ...(value.current
          ? [{ label: value.current, click: actions.current }]
          : []),
        { label: "Check for Updates…", click: actions.updates },
        { type: "separator" },
        { label: "Quit Farol", click: actions.quit },
      ]),
    );
  };
  // Attaching a startup context menu lets native presentation outlive its
  // status snapshot. Read current host state before each explicit opening.
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", openMenu);
  tray.on("right-click", openMenu);
  return () => {
    if (disposed) return;
    disposed = true;
    tray.removeListener("click", openMenu);
    tray.removeListener("right-click", openMenu);
    tray.destroy();
  };
}
