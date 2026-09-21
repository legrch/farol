import { z } from "zod";

export const SurfaceSectionSchema = z.enum([
  "browser",
  "computer",
  "activity",
  "settings",
]);

export const SidebarModeSchema = z.enum(["full", "rail", "overlay"]);

export const ShellOverlaySchema = z.enum([
  "none",
  "sidebar",
  "task-menu",
  "quick-switcher",
  "context-preview",
]);

export const ShellLayoutSchema = z.strictObject({
  section: SurfaceSectionSchema,
  taskId: z.string(),
  setupOpen: z.boolean(),
  sidebar: SidebarModeSchema,
  overlay: ShellOverlaySchema,
});

/**
 * Who published a shell action. A closed set naming the PUBLISHER, not the
 * input device: `requestSettings` and `requestQuickSwitcher` are each
 * reached from both an app-menu item and a keyboard shortcut, so naming the
 * device would need a second argument threaded through two call paths to
 * describe one owner intent.
 *
 * The distinction this exists for is whether an owner asked for it.
 * `settings-command`, `quick-switcher-command` and `overlay-dismissed` are
 * owner actions; `auth-window-closed` is not — it is published after a
 * ChatGPT auth window's outcome is recorded, and that window can close
 * without the owner touching anything.
 */
export const ShellActionSourceSchema = z.enum([
  "settings-command",
  "quick-switcher-command",
  "overlay-dismissed",
  "auth-window-closed",
]);

export type ShellActionSource = z.infer<typeof ShellActionSourceSchema>;

export const ShellActionSchema = z.strictObject({
  action: z.enum([
    "toggle-sidebar",
    "open-quick-switcher",
    "open-settings",
    "sign-in-returned",
    "close-overlay",
  ]),
  /** Unique per publish, so a recipient can tell a repeat from a duplicate. */
  eventId: z.string().uuid(),
  source: ShellActionSourceSchema,
  /**
   * The auth window whose recorded outcome produced this publish, or null
   * when no auth window was involved. A delayed close from an older window
   * carries that window's generation, not the current one — which is what
   * makes a late event distinguishable from a current one.
   */
  authWindowGeneration: z.number().int().nonnegative().nullable(),
});

export const WindowStateSchema = z.strictObject({
  focused: z.boolean(),
  fullScreen: z.boolean(),
  trafficLightPosition: z
    .strictObject({ x: z.number(), y: z.number() })
    .nullable(),
});

export type SurfaceSection = z.infer<typeof SurfaceSectionSchema>;
export type SidebarMode = z.infer<typeof SidebarModeSchema>;
export type ShellOverlay = z.infer<typeof ShellOverlaySchema>;
export type ShellLayout = z.infer<typeof ShellLayoutSchema>;
export type ShellAction = z.infer<typeof ShellActionSchema>;
export type WindowState = z.infer<typeof WindowStateSchema>;
