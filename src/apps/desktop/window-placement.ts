export type PreviewWindowMode = "default" | "secondary-visible" | "hidden";

export interface PreviewRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewDisplay {
  readonly id: number;
  readonly internal: boolean;
  readonly bounds: PreviewRectangle;
  readonly workArea: PreviewRectangle;
}

export interface PreviewWindowPlacement {
  readonly displayId: number;
  readonly internal: boolean;
  readonly primary: boolean;
  readonly selection:
    "non-primary-internal" | "non-primary" | "owner-allowed-primary";
  readonly bounds: PreviewRectangle;
}

const modePrefix = "--preview-window-mode=";
const allowPrimaryDisplayFlag = "--allow-primary-display";
const builtInDisplayOnlyFlag = "--built-in-display-only";

export function parsePreviewWindowMode(
  arguments_: readonly string[],
): PreviewWindowMode {
  const values = arguments_
    .filter((argument) => argument.startsWith(modePrefix))
    .map((argument) => argument.slice(modePrefix.length));
  if (values.length === 0) return "default";
  if (
    values.length !== 1 ||
    (values[0] !== "secondary-visible" && values[0] !== "hidden")
  ) {
    throw new Error("PREVIEW_WINDOW_MODE_INVALID");
  }
  return values[0];
}

// Owner-handed overnight runs with no second display pass this flag
// explicitly; its absence keeps today's behavior unchanged (no primary-display
// fallback). AGENTS.md (commit 6cbe53fd) is the accepted policy this encodes.
export function parseAllowPrimaryDisplay(
  arguments_: readonly string[],
): boolean {
  return arguments_.includes(allowPrimaryDisplayFlag);
}

export function parseBuiltInDisplayOnly(
  arguments_: readonly string[],
): boolean {
  return arguments_.includes(builtInDisplayOnlyFlag);
}

function centeredBounds(
  workArea: PreviewRectangle,
  requested: Readonly<{ width: number; height: number }>,
): PreviewRectangle {
  const values = [
    workArea.x,
    workArea.y,
    workArea.width,
    workArea.height,
    requested.width,
    requested.height,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    workArea.width <= 0 ||
    workArea.height <= 0 ||
    requested.width <= 0 ||
    requested.height <= 0
  ) {
    throw new Error("WINDOW_DISPLAY_GEOMETRY_INVALID");
  }
  if (requested.width > workArea.width || requested.height > workArea.height) {
    throw new Error("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  }
  const width = Math.trunc(requested.width);
  const height = Math.trunc(requested.height);
  return {
    x: Math.floor(workArea.x + (workArea.width - width) / 2),
    y: Math.floor(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

export function selectPreviewWindowPlacement(
  displays: readonly PreviewDisplay[],
  primaryDisplayId: number,
  requested: Readonly<{ width: number; height: number }>,
  allowPrimaryDisplay = false,
  builtInDisplayOnly = false,
): PreviewWindowPlacement {
  if (displays.length === 0) {
    throw new Error("WINDOW_DISPLAY_UNAVAILABLE");
  }
  const ordered = [...displays].sort((left, right) => left.id - right.id);
  const primary = ordered.find((display) => display.id === primaryDisplayId);
  if (!primary) throw new Error("WINDOW_PRIMARY_DISPLAY_MISSING");

  const nonPrimaryInternal = ordered.find(
    (display) => display.id !== primaryDisplayId && display.internal,
  );
  const nonPrimary = ordered.find((display) => display.id !== primaryDisplayId);
  // The built-in-only option is a separate, explicit owner-away constraint:
  // an external monitor must never receive one of these test-owned windows.
  const ownerAllowedPrimary =
    allowPrimaryDisplay &&
    primary.internal &&
    (builtInDisplayOnly || !nonPrimary)
      ? primary
      : undefined;
  const selected = builtInDisplayOnly
    ? (nonPrimaryInternal ?? ownerAllowedPrimary)
    : (nonPrimaryInternal ?? nonPrimary ?? ownerAllowedPrimary);
  if (!selected) {
    throw new Error(
      builtInDisplayOnly
        ? "BUILT_IN_DISPLAY_UNAVAILABLE"
        : "SECONDARY_DISPLAY_UNAVAILABLE",
    );
  }
  const isPrimary = selected.id === primaryDisplayId;
  const selection = isPrimary
    ? "owner-allowed-primary"
    : selected.internal
      ? "non-primary-internal"
      : "non-primary";

  return {
    displayId: selected.id,
    internal: selected.internal,
    primary: isPrimary,
    selection,
    bounds: centeredBounds(selected.workArea, requested),
  };
}
