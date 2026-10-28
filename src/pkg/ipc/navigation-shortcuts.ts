export const shortcutSections = [
  "home",
  "browser",
  "activity",
  "setup",
] as const;

export type ShortcutSection = (typeof shortcutSections)[number];
export type SidebarShortcut = "s" | "b" | "off";
export type NavigationShortcuts = Record<ShortcutSection, number> & {
  sidebar: SidebarShortcut;
};

export const defaultNavigationShortcuts: NavigationShortcuts = {
  home: 1,
  browser: 2,
  activity: 3,
  setup: 4,
  sidebar: "s",
};

export function parseNavigationShortcuts(
  input: unknown,
): NavigationShortcuts | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null;
  const values = input as Record<string, unknown>;
  const legacySections = ["browser", "computer", "activity", "settings"];
  if (
    legacySections.every((section) => Object.hasOwn(values, section)) &&
    Object.keys(values).every(
      (key) => key === "sidebar" || legacySections.includes(key),
    )
  ) {
    const digits = legacySections.map((section) => values[section]);
    if (
      digits.some(
        (digit) =>
          !Number.isInteger(digit) || Number(digit) < 0 || Number(digit) > 4,
      ) ||
      new Set(digits.filter((digit) => digit !== 0)).size !==
        digits.filter((digit) => digit !== 0).length
    )
      return null;
    const wasDefault = digits.every((digit, index) => digit === index + 1);
    return parseNavigationShortcuts({
      ...(wasDefault
        ? defaultNavigationShortcuts
        : {
            home: 0,
            browser: values.browser,
            activity: values.activity,
            setup: values.computer,
          }),
      sidebar: values.sidebar === undefined ? "s" : values.sidebar,
    });
  }
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
