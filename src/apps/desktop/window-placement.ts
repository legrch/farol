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
    | "non-primary-internal"
    | "non-primary"
    | "internal-primary-fallback"
    | "primary-fallback";
  readonly bounds: PreviewRectangle;
}

const modePrefix = "--preview-window-mode=";

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
  const width = Math.min(Math.trunc(requested.width), workArea.width);
  const height = Math.min(Math.trunc(requested.height), workArea.height);
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
  const internal = ordered.find((display) => display.internal);
  const selected = nonPrimaryInternal ?? nonPrimary ?? internal ?? primary;
  const isPrimary = selected.id === primaryDisplayId;
  const selection = nonPrimaryInternal
    ? "non-primary-internal"
    : nonPrimary
      ? "non-primary"
      : internal
        ? "internal-primary-fallback"
        : "primary-fallback";

  return {
    displayId: selected.id,
    internal: selected.internal,
    primary: isPrimary,
    selection,
    bounds: centeredBounds(selected.workArea, requested),
  };
}
