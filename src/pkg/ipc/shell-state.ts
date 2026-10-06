import { z } from "zod";
import { shellGeometry } from "../shell-geometry";

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
  checkFeedbackVisible: z.boolean().default(false),
  sidebar: SidebarModeSchema,
  sidebarWidth: z
    .number()
    .int()
    .min(shellGeometry.pageListMin)
    .max(shellGeometry.pageListMax)
    .default(shellGeometry.pageListDefault),
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
 * `settings-command`, `quick-switcher-command`, `overlay-dismissed`,
 * `sign-in-return-command` and `section-shortcut-command` are owner actions.
 * `auth-window-closed` follows an auth window outcome, and
 * `verification-completed` follows a network
 * check; either may arrive after the owner has moved to another surface.
 */
export const ShellActionSourceSchema = z.enum([
  "settings-command",
  "sidebar-command",
  "section-shortcut-command",
  "update-command",
  "quick-switcher-command",
  "overlay-dismissed",
  "sign-in-return-command",
  "verification-completed",
  "auth-window-closed",
]);

export type ShellActionSource = z.infer<typeof ShellActionSourceSchema>;

const ShellActionEnvelope = {
  /** Unique per publish, so a recipient can tell a repeat from a duplicate. */
  eventId: z.string().uuid(),
  /**
   * The auth window whose recorded outcome produced this publish, or null
   * when no auth window was involved. A delayed close from an older window
   * carries that window's generation, not the current one.
   */
  authWindowGeneration: z.number().int().nonnegative().nullable(),
};

export const ShellActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...ShellActionEnvelope,
    action: z.enum([
      "toggle-sidebar",
      "open-quick-switcher",
      "open-settings",
      "open-updates",
      "sign-in-returned",
      "close-overlay",
    ]),
    source: ShellActionSourceSchema.exclude(["section-shortcut-command"]),
  }),
  z.strictObject({
    ...ShellActionEnvelope,
    action: z.literal("navigate-section"),
    source: z.literal("section-shortcut-command"),
    authWindowGeneration: z.null(),
    section: SurfaceSectionSchema,
    taskId: z.string(),
    /** Monotonic for the native publisher; old or reordered intent cannot replay. */
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);

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
