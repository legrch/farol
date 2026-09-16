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
]);

export const ShellLayoutSchema = z.strictObject({
  section: SurfaceSectionSchema,
  taskId: z.string(),
  setupOpen: z.boolean(),
  sidebar: SidebarModeSchema,
  overlay: ShellOverlaySchema,
});

export const ShellActionSchema = z.strictObject({
  action: z.enum(["toggle-sidebar", "open-quick-switcher", "close-overlay"]),
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
