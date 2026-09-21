/**
 * Which parts of a layout pushed by the main process the renderer adopts.
 *
 * Main keeps a copy of the layout so it can size and place the native task
 * surfaces, and `publishLayout` sends that copy back. Every field in it
 * originates in the renderer: main learns them from `notifyHost` and mirrors
 * them. Sending a mirror back is a write in the wrong direction, and for one
 * field it is a destructive one.
 *
 * `overlay` is that field. The renderer is the only place that knows whether
 * an overlay is open, because the renderer is what opens it. A push carrying
 * the mirror from before the renderer opened its task menu used to close that
 * menu — `shellOverlay` was assigned straight from the payload and the dialog
 * follows it — which takes the Agent editor away mid-keystroke with no owner
 * action and no shell action anywhere in the trace.
 *
 * So the renderer adopts what main genuinely coordinates (which section, task
 * and sidebar the surfaces are laid out for) and keeps its own answer for
 * whether an overlay is open.
 */
export type HostLayout = Readonly<{
  section: string;
  taskId: string;
  setupOpen: boolean;
  sidebar: string;
  overlay: string;
}>;

export type HostLayoutUpdate<Layout extends HostLayout> = Readonly<{
  section: Layout["section"];
  taskId: Layout["taskId"];
  setupOpen: boolean;
  /** Null when the push carries no sidebar preference to adopt. */
  sidebarPreference: "full" | "rail" | null;
  sidebarOverlayOpen: boolean;
}>;

// Generic so the caller's own narrow section and task types survive the
// round trip; widening them here would only move a cast to the call site.
export function hostLayoutUpdate<Layout extends HostLayout>(
  layout: Layout,
): HostLayoutUpdate<Layout> {
  return {
    section: layout.section,
    taskId: layout.taskId,
    setupOpen: layout.setupOpen,
    sidebarPreference:
      layout.sidebar === "full" || layout.sidebar === "rail"
        ? layout.sidebar
        : null,
    sidebarOverlayOpen: layout.sidebar === "overlay",
  };
}

/** What the renderer currently holds, for comparison with a push. */
export type RendererLayout = Readonly<{
  section: string;
  taskId: string;
  setupOpen: boolean;
  sidebarPreference: "full" | "rail";
  sidebarOverlayOpen: boolean;
}>;

/**
 * Whether a push actually moves anything the renderer holds.
 *
 * Measured: a layout arrived 1.76 s after a sign-in outcome, carrying the
 * section and task the renderer already had, and the renderer re-rendered
 * for it anyway. That landed mid-word inside the field being typed — the
 * owner's "notes" was cut to "no" — because a rebuild between two keystrokes
 * replaces the element the rest of the word was going to.
 *
 * A push that says nothing new is not a reason to rebuild anything. Restoring
 * a value into a fresh node is not the same as never having replaced it: the
 * caret, the selection and the node the next keystroke is addressed to all
 * belong to the element that was there.
 */
export function hostLayoutChanged<Layout extends HostLayout>(
  update: HostLayoutUpdate<Layout>,
  current: RendererLayout,
): boolean {
  return (
    update.section !== current.section ||
    update.taskId !== current.taskId ||
    update.setupOpen !== current.setupOpen ||
    update.sidebarOverlayOpen !== current.sidebarOverlayOpen ||
    (update.sidebarPreference !== null &&
      update.sidebarPreference !== current.sidebarPreference)
  );
}
