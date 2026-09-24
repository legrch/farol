export const shortcutSections = [
  "browser",
  "computer",
  "activity",
  "settings",
] as const;

export type ShortcutSection = (typeof shortcutSections)[number];
export type SidebarShortcut = "s" | "b" | "off";
export type NavigationShortcuts = Record<ShortcutSection, number> & {
  sidebar: SidebarShortcut;
};

export const defaultNavigationShortcuts: NavigationShortcuts = {
  browser: 1,
  computer: 2,
  activity: 3,
  settings: 4,
  sidebar: "s",
};

export function parseNavigationShortcuts(
  input: unknown,
): NavigationShortcuts | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const values = input as Record<string, unknown>;
  if (
    (Object.keys(values).length !== shortcutSections.length &&
      Object.keys(values).length !== shortcutSections.length + 1) ||
    Object.keys(values).some(
      (key) =>
        key !== "sidebar" &&
        !shortcutSections.some((section) => section === key),
    ) ||
    (values.sidebar !== undefined &&
      values.sidebar !== "s" &&
      values.sidebar !== "b" &&
      values.sidebar !== "off") ||
    shortcutSections.some(
      (section) =>
        !Number.isInteger(values[section]) ||
        (values[section] as number) < 0 ||
        (values[section] as number) > 4,
    )
  )
    return null;
  const chosen = shortcutSections
    .map((section) => values[section] as number)
    .filter((digit) => digit !== 0);
  if (new Set(chosen).size !== chosen.length) return null;
  return {
    ...(Object.fromEntries(
      shortcutSections.map((section) => [section, values[section] as number]),
    ) as Record<ShortcutSection, number>),
    sidebar: (values.sidebar ?? "s") as SidebarShortcut,
  };
}

export function sidebarShortcutMatches(
  shortcuts: NavigationShortcuts,
  key: string,
): boolean {
  return shortcuts.sidebar !== "off" && key.toLowerCase() === shortcuts.sidebar;
}

export function sectionForShortcut(
  shortcuts: NavigationShortcuts,
  key: string,
): ShortcutSection | null {
  if (!/^[1-4]$/u.test(key)) return null;
  return (
    shortcutSections.find((section) => shortcuts[section] === Number(key)) ??
    null
  );
}
