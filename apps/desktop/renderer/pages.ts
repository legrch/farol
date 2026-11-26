import type { SettingsPage } from "../../../src/ui/renderer/contract";

/** Settings pages in rail order, with their headings. */
export const pages: readonly [SettingsPage, string][] = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["shortcuts", "Keyboard shortcuts"],
];
