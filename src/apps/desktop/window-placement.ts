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
  readonly label?: string;
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
    | "owner-allowed-primary"
    | "sidecar";
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

// A sole display is automatic; tests can explicitly allow primary otherwise.
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

export function parseSidecarDisplayOnly(
  arguments_: readonly string[],
): boolean {
  return arguments_.includes("--sidecar-display-only");
}

export function parsePreviewWindowSize(
  arguments_: readonly string[],
  mode: PreviewWindowMode,
): Readonly<{ width: number; height: number }> {
  const prefix = "--preview-window-size=";
  const values = arguments_.filter((value) => value.startsWith(prefix));
  if (values.length === 0) return { width: 1180, height: 760 };
  const match =
    values.length === 1
      ? /^([0-9]{3,4})x([0-9]{3,4})$/u.exec(values[0]!.slice(prefix.length))
      : null;
  if (mode === "default" || !match)
    throw new Error("PREVIEW_WINDOW_SIZE_INVALID");
  const width = Number(match[1]),
    height = Number(match[2]);
  if (width < 640 || height < 520 || width > 3840 || height > 2160)
    throw new Error("PREVIEW_WINDOW_SIZE_INVALID");
  return { width, height };
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
  sidecarDisplayOnly = false,
): PreviewWindowPlacement {
  if (displays.length === 0) {
    throw new Error("WINDOW_DISPLAY_UNAVAILABLE");
  }
  const ordered = [...displays].sort((left, right) => left.id - right.id);
  const primary = ordered.find((display) => display.id === primaryDisplayId);
  if (!primary) throw new Error("WINDOW_PRIMARY_DISPLAY_MISSING");

  if (sidecarDisplayOnly && builtInDisplayOnly)
    throw new Error("VISIBLE_TEST_DISPLAY_CONFLICT");
  const secondary = ordered.filter((d) => d.id !== primaryDisplayId);
  const sidecar = (d: PreviewDisplay) =>
    !d.internal && /\b(?:sidecar|ipad)\b/iu.test(d.label ?? "");
  const preferred = sidecarDisplayOnly
    ? secondary.filter(sidecar)
    : builtInDisplayOnly
      ? secondary.filter((d) => d.internal)
      : [
          ...secondary.filter((d) => d.internal),
          ...secondary.filter((d) => !d.internal),
        ];
  // A sole display never blocks startup. With other displays connected, preserve
  // the requested test surface instead of silently taking the owner’s primary.
  const selected =
    preferred.find(
      (d) =>
        d.workArea.width >= requested.width &&
        d.workArea.height >= requested.height,
    ) ?? (secondary.length === 0 || allowPrimaryDisplay ? primary : undefined);
  if (!selected) throw new Error("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  const isPrimary = selected.id === primaryDisplayId;
  const selection = isPrimary
    ? "owner-allowed-primary"
    : sidecarDisplayOnly
      ? "sidecar"
      : selected.internal
        ? "non-primary-internal"
        : "non-primary";

  return {
    displayId: selected.id,
    internal: selected.internal,
    primary: isPrimary,
    selection,
    bounds: centeredBounds(
      selected.workArea,
      isPrimary
        ? {
            width: Math.min(requested.width, selected.workArea.width),
            height: Math.min(requested.height, selected.workArea.height),
          }
        : requested,
    ),
  };
}

// Ordinary Dev fits Electron DIP work areas, preferring a secondary when usable.
export function parseDevDisplay(arguments_: readonly string[]): boolean {
  const flags = arguments_.filter((value) => value.startsWith("--display"));
  if (flags.length === 0) return false;
  if (flags.length !== 1 || flags[0] !== "--display=secondary")
    throw new Error("DEV_DISPLAY_ARGUMENT_INVALID");
  if (
    arguments_.some(
      (value) =>
        value.startsWith("--preview-window-mode=") ||
        [
          "--secondary-display",
          "--built-in-display-only",
          "--sidecar-display-only",
          "--allow-primary-display",
        ].includes(value),
    )
  )
    throw new Error("DEV_DISPLAY_ARGUMENT_CONFLICT");
  return true;
}

export function selectDevWindowPlacement(
  displays: readonly PreviewDisplay[],
  primaryDisplayId: number,
  requested: Readonly<{ width: number; height: number }>,
): PreviewWindowPlacement {
  if (!displays.some((display) => display.id === primaryDisplayId))
    throw new Error("WINDOW_PRIMARY_DISPLAY_MISSING");
  const secondary = displays
    .filter((display) => display.id !== primaryDisplayId)
    .sort((left, right) => left.id - right.id);
  const selected =
    secondary.find(
      (display) =>
        !display.internal && /\b(?:sidecar|ipad)\b/iu.test(display.label ?? ""),
    ) ??
    secondary[0] ??
    displays.find((d) => d.id === primaryDisplayId)!;
  const area = selected.workArea;
  if (
    ![
      area.x,
      area.y,
      area.width,
      area.height,
      requested.width,
      requested.height,
    ].every(Number.isFinite) ||
    area.width <= 0 ||
    area.height <= 0 ||
    requested.width <= 0 ||
    requested.height <= 0
  )
    throw new Error("WINDOW_DISPLAY_GEOMETRY_INVALID");
  if (area.width < 640 || area.height < 520)
    throw new Error("VISIBLE_TEST_VIEWPORT_UNAVAILABLE");
  return {
    displayId: selected.id,
    internal: selected.internal,
    primary: selected.id === primaryDisplayId,
    selection:
      selected.id === primaryDisplayId
        ? "owner-allowed-primary"
        : /\b(?:sidecar|ipad)\b/iu.test(selected.label ?? "")
          ? "sidecar"
          : "non-primary",
    bounds: centeredBounds(area, {
      width: Math.min(requested.width, area.width),
      height: Math.min(requested.height, area.height),
    }),
  };
}
