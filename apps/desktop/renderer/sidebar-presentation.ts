/** The label preference survives automatic compact-window collapse. */
export const sidebarPreferenceKey = "farol.sidebar.v2";
export const sidebarWidth = (expanded: boolean): number =>
  expanded ? 208 : 56;
