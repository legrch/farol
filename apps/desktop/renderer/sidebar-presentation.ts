import { shellGeometry } from "../../../src/pkg/shell-layout/geometry";

/** The label preference survives compact collapse; geometry matches the native host. */
export const sidebarPreferenceKey = "farol.sidebar.v2";
export const sidebarWidth = (expanded: boolean, compact: boolean): number =>
  compact
    ? shellGeometry.compactRail
    : shellGeometry.sidebarRail + (expanded ? shellGeometry.pageListMin : 0);

export const defaultSidebarPreference = "full" as const;
