"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, screen } = require("electron");

const argumentsList = process.argv.slice(2);
const readOption = (name, fallback) => {
  const prefix = `--${name}=`;
  const option = argumentsList.find((candidate) =>
    candidate.startsWith(prefix),
  );
  return option ? option.slice(prefix.length) : fallback;
};
const toPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const showWindow = argumentsList.includes("--show");
const showGallery = argumentsList.includes("--gallery");
const width = toPositiveNumber(
  readOption("width", process.env.FAROL_LAB_WIDTH),
  1180,
);
const height = toPositiveNumber(
  readOption("height", process.env.FAROL_LAB_HEIGHT),
  760,
);
const scaleFactor = toPositiveNumber(
  readOption("scale-factor", process.env.FAROL_LAB_SCALE_FACTOR),
  2,
);
const query = readOption("query", process.env.FAROL_LAB_QUERY ?? "");

app.commandLine.appendSwitch("force-device-scale-factor", String(scaleFactor));

function selectDisplay(displays, primaryDisplay, requested) {
  if (displays.length === 0) throw new Error("LAB_DISPLAY_UNAVAILABLE");
  const ordered = [...displays].sort((left, right) => left.id - right.id);
  const nonPrimaryInternal = ordered.find(
    (display) => display.id !== primaryDisplay.id && display.internal,
  );
  const nonPrimary = ordered.find(
    (display) => display.id !== primaryDisplay.id,
  );
  const internal = ordered.find((display) => display.internal);
  const selected =
    nonPrimaryInternal ?? nonPrimary ?? internal ?? primaryDisplay;
  const selection = nonPrimaryInternal
    ? "non-primary-internal"
    : nonPrimary
      ? "non-primary"
      : internal
        ? "internal-primary-fallback"
        : "primary-fallback";
  const bounds = selected.workArea;
  const selectedWidth = Math.min(Math.trunc(requested.width), bounds.width);
  const selectedHeight = Math.min(Math.trunc(requested.height), bounds.height);
  return {
    display: selected,
    selection,
    bounds: {
      x: Math.floor(bounds.x + (bounds.width - selectedWidth) / 2),
      y: Math.floor(bounds.y + (bounds.height - selectedHeight) / 2),
      width: selectedWidth,
      height: selectedHeight,
    },
  };
}

function normalizedPageUrl(targetUrl) {
  try {
    const normalized = new URL(targetUrl);
    normalized.search = "";
    normalized.hash = "";
    return normalized.toString();
  } catch {
    return null;
  }
}

async function createLabWindow() {
  const labRoot = path.resolve(__dirname, "..");
  const pagePath = path.join(
    labRoot,
    showGallery ? "gallery.html" : "prototype.html",
  );
  const pageUrl = pathToFileURL(pagePath);
  if (query && !showGallery) pageUrl.search = query;

  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const placement = selectDisplay(displays, primaryDisplay, { width, height });
  const window = new BrowserWindow({
    ...placement.bounds,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: "#071311",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  const allowedPages = new Set(
    ["prototype.html", "gallery.html"].map((page) =>
      pathToFileURL(path.join(labRoot, page)).toString(),
    ),
  );
  window.farolLabPlacement = {
    displayId: placement.display.id,
    internal: placement.display.internal,
    primary: placement.display.id === primaryDisplay.id,
    selection: placement.selection,
    bounds: placement.bounds,
  };
  window.farolLabNavigationGuard = { blocked: [] };
  const blockUnapprovedNavigation = (event, targetUrl) => {
    if (allowedPages.has(normalizedPageUrl(targetUrl))) return;
    let kind = "invalid";
    try {
      kind = new URL(targetUrl).protocol === "file:" ? "file" : "external";
    } catch {
      // Keep the privacy-safe invalid classification.
    }
    window.farolLabNavigationGuard.blocked.push(kind);
    event.preventDefault();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", blockUnapprovedNavigation);
  window.webContents.on("will-frame-navigate", blockUnapprovedNavigation);
  await window.loadURL(pageUrl.toString());
  if (showWindow) window.showInactive();
  return window;
}

app
  .whenReady()
  .then(createLabWindow)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
