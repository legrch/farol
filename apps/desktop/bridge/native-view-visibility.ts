import type { Rectangle, WebContents, WebContentsView } from "electron";

type FocusableContents = Pick<
  WebContents,
  "isDestroyed" | "isFocused" | "focus"
>;

export type NativeBrowserView = Pick<
  WebContentsView,
  "getVisible" | "setVisible" | "setBounds"
> & { readonly webContents: FocusableContents };

export interface NativeViewHost<V extends NativeBrowserView> {
  isDestroyed(): boolean;
  isFocused(): boolean;
  readonly webContents: FocusableContents;
  readonly contentView: {
    readonly children: readonly unknown[];
    addChildView(view: V): void;
    removeChildView(view: V): void;
  };
}

// Attachment bookkeeping only. Layout policy and WebContents lifetime belong
// to the caller. Drawing visibility alone does not remove a native AX subtree.
export class NativeViewVisibility<V extends NativeBrowserView> {
  private readonly owners = new Map<V, NativeViewHost<V>>();

  show(host: NativeViewHost<V>, view: V, bounds: Rectangle): void {
    if (host.isDestroyed() || view.webContents.isDestroyed()) return;
    const previous = this.owners.get(view);
    if (previous && previous !== host) this.hide(view, false);
    // Each host owns one browser lane. This also detaches a replaced view that
    // is no longer in the caller's task map before attaching its replacement.
    for (const [other, owner] of this.owners) {
      if (owner === host && other !== view) this.hide(other);
    }
    view.setBounds(bounds);
    // Electron reorders an existing child when addChildView is repeated.
    if (!host.contentView.children.includes(view)) {
      host.contentView.addChildView(view);
    }
    this.owners.set(view, host);
    if (!view.getVisible()) view.setVisible(true);
  }

  hide(view: V, transferFocus = true): void {
    const host = this.owners.get(view);
    const attached =
      host !== undefined &&
      !host.isDestroyed() &&
      host.contentView.children.includes(view);
    const live = !view.webContents.isDestroyed();
    const returnFocus =
      transferFocus &&
      attached &&
      live &&
      host.isFocused() &&
      view.webContents.isFocused();
    if (live && view.getVisible()) view.setVisible(false);
    // Remove before the caller closes WebContents; also remove a view whose
    // WebContents was destroyed independently. Never access a destroyed host.
    if (attached) host.contentView.removeChildView(view);
    this.owners.delete(view);
    if (
      returnFocus &&
      !host.isDestroyed() &&
      host.isFocused() &&
      !host.webContents.isDestroyed()
    ) {
      host.webContents.focus();
    }
  }

  detachHost(host: NativeViewHost<V>): void {
    for (const [view, owner] of this.owners) {
      if (owner === host) this.hide(view, false);
    }
  }

  focus(host: NativeViewHost<V>, view: V): boolean {
    if (
      host.isDestroyed() ||
      !host.isFocused() ||
      view.webContents.isDestroyed() ||
      this.owners.get(view) !== host ||
      !host.contentView.children.includes(view) ||
      !view.getVisible()
    ) {
      return false;
    }
    view.webContents.focus();
    return true;
  }
}
