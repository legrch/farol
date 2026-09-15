import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(testRoot, "..");
const nextRoot = path.resolve(labRoot, "..");
const repositoryRoot = path.resolve(nextRoot, "..");
const galleryRoot = path.join(labRoot, "gallery");
const runnerPath = path.join(labRoot, "tooling/lab-main.cjs");
const playwrightPath =
  process.env.PLAYWRIGHT_CORE_PATH ??
  path.join(nextRoot, "node_modules/playwright-core/index.mjs");
const electronExecutable =
  process.env.ELECTRON_EXECUTABLE ??
  path.join(
    nextRoot,
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );

await fs.access(playwrightPath);
await fs.access(electronExecutable);
const { _electron: electron } = await import(
  pathToFileURL(playwrightPath).href
);

const cases = [];
const screenshots = [];
const externalRequests = [];
const consoleErrors = [];
const pageErrors = [];
let visibleWindow = null;

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(candidate)));
    else files.push(candidate);
  }
  return files.sort();
}

async function digestFiles(files) {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(labRoot, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertSourceBoundary() {
  const productionFiles = await listFiles(path.join(nextRoot, "src"));
  for (const file of productionFiles) {
    const source = await fs.readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /design-lab/u,
      path.relative(repositoryRoot, file),
    );
  }

  const localSources = [
    "prototype.html",
    "prototype.css",
    "prototype.js",
    "gallery.html",
    "gallery.css",
    "gallery.js",
    "tooling/lab-main.cjs",
  ].map((file) => path.join(labRoot, file));
  const joined = (
    await Promise.all(localSources.map((file) => fs.readFile(file, "utf8")))
  ).join("\n");
  assert.doesNotMatch(joined, /https?:\/\//u, "LAB_EXTERNAL_URL_PRESENT");
  assert.match(joined, /connect-src 'none'/u);
  assert.match(joined, /nodeIntegration:\s*false/u);
  assert.match(joined, /contextIsolation:\s*true/u);
  assert.match(joined, /sandbox:\s*true/u);
  assert.match(joined, /webSecurity:\s*true/u);
  cases.push("nonshipping-source-boundary");
}

function pngDimensions(buffer) {
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function setContentSize(application, width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      const target = BrowserWindow.getAllWindows()[0];
      if (!target) throw new Error("LAB_WINDOW_MISSING");
      target.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

async function setScene(page, scene) {
  await page.evaluate((nextScene) => {
    window.farolLab.setTask(nextScene.task);
    window.farolLab.setDirection(nextScene.direction);
    window.farolLab.setState(nextScene.state);
    window.farolLab.setSection(nextScene.section);
  }, scene);
  await page.waitForTimeout(80);
}

async function capture(application, page, definition) {
  await setContentSize(application, definition.width, definition.height);
  await setScene(page, definition);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.deepEqual(
    { width: viewport.width, height: viewport.height },
    { width: definition.width, height: definition.height },
  );
  assert.equal(viewport.dpr, 2);
  assert.ok(
    viewport.scrollWidth <= viewport.width,
    `${definition.file}:horizontal-overflow`,
  );
  assert.ok(
    viewport.scrollHeight <= viewport.height,
    `${definition.file}:vertical-overflow`,
  );

  const target = path.join(galleryRoot, definition.file);
  await page.screenshot({ path: target, animations: "disabled" });
  const dimensions = pngDimensions(await fs.readFile(target));
  assert.deepEqual(dimensions, {
    width: definition.width * 2,
    height: definition.height * 2,
  });
  screenshots.push({
    file: definition.file,
    direction: definition.direction,
    section: definition.section,
    state: definition.state,
    viewport: `${definition.width}x${definition.height}`,
    pixels: `${dimensions.width}x${dimensions.height}`,
  });
}

async function launchPrototype({ show = false } = {}) {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-design-lab-"),
  );
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [
      runnerPath,
      ...(show ? ["--show"] : []),
      `--user-data-dir=${path.join(isolatedHome, "user-data")}`,
    ],
    env: {
      HOME: isolatedHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
      FAROL_LAB_WIDTH: "1180",
      FAROL_LAB_HEIGHT: "760",
      FAROL_LAB_SCALE_FACTOR: "2",
      FAROL_LAB_QUERY:
        "direction=beacon&section=browser&task=atlantic&state=waiting",
    },
    timeout: 15_000,
  });
  const page = await application.firstWindow({ timeout: 15_000 });
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
      undefined,
      { timeout: 10_000 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        url: page.url(),
        ready: await page.locator("html").getAttribute("data-ready"),
        consoleErrors,
        pageErrors,
      }),
    );
    throw error;
  }
  return { application, page, isolatedHome };
}

async function launchGallery() {
  const isolatedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-design-gallery-"),
  );
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [
      runnerPath,
      "--gallery",
      "--width=1440",
      "--height=1000",
      `--user-data-dir=${path.join(isolatedHome, "user-data")}`,
    ],
    env: {
      HOME: isolatedHome,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: os.tmpdir(),
      FAROL_LAB_SCALE_FACTOR: "2",
    },
    timeout: 15_000,
  });
  const page = await application.firstWindow({ timeout: 15_000 });
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("iframe").length === 6,
  );
  const prototypeFrames = page
    .frames()
    .filter((frame) => frame.url().includes("prototype.html"));
  assert.equal(prototypeFrames.length, 6);
  await Promise.all(
    prototypeFrames.map((frame) =>
      frame.waitForFunction(
        () => document.documentElement.dataset.ready === "true",
        undefined,
        { timeout: 10_000 },
      ),
    ),
  );
  return { application, page, isolatedHome };
}

async function close(instance) {
  await instance.application.close();
  const resolved = path.resolve(instance.isolatedHome);
  assert.ok(
    resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}farol-design-`),
  );
  await fs.rm(resolved, { recursive: true, force: true });
}

await fs.rm(galleryRoot, { recursive: true, force: true });
await fs.mkdir(galleryRoot, { recursive: true });
await assertSourceBoundary();

const prototype = await launchPrototype();
try {
  const { application, page } = prototype;
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("LAB_WINDOW_MISSING");
    const settings = target.webContents.getLastWebPreferences();
    return {
      contextIsolation: settings.contextIsolation,
      nodeIntegration: settings.nodeIntegration,
      sandbox: settings.sandbox,
      webSecurity: settings.webSecurity,
    };
  });
  assert.deepEqual(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  cases.push("sandboxed-electron-runner");

  assert.deepEqual(await page.evaluate(() => window.farolLab.snapshot()), {
    direction: "beacon",
    section: "browser",
    selectedTaskId: "atlantic",
    state: "waiting",
  });
  await page.locator("#primary-action").click();
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).section,
    "computer",
  );
  await page.locator("#allow-request").click();
  assert.deepEqual(await page.evaluate(() => window.farolLab.snapshot()), {
    direction: "beacon",
    section: "browser",
    selectedTaskId: "atlantic",
    state: "running",
  });
  cases.push("bounded-computer-approval");

  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "unknown",
  });
  await assert.match(
    await page.locator("#state-detail").textContent(),
    /Inspect Activity before any retry/u,
  );
  assert.equal(
    await page.locator("#computer-fact").textContent(),
    "Do not retry",
  );
  cases.push("unknown-outcome-fail-closed");

  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "waiting",
  });
  await page.locator("#task-menu-button").click();
  await page.locator("#task-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#task-menu-computer").isEnabled(), true);
  await page.locator("#task-menu-computer").click();
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).section,
    "computer",
  );
  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "waiting",
  });
  await page.locator("#task-menu-button").click();
  await page.locator("#task-menu-activity").click();
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).section,
    "activity",
  );
  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "waiting",
  });
  await page.locator("#task-menu-button").click();
  await page.locator("#task-menu-setup").click();
  await page.locator("#setup-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.activeElement?.id === "task-menu-button",
  );
  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "running",
  });
  await page.locator("#task-menu-button").click();
  assert.equal(await page.locator("#task-menu-computer").isDisabled(), true);
  await page.keyboard.press("Escape");
  cases.push("selected-task-menu-actions");

  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "atlantic",
    state: "waiting",
  });
  await page.locator('[data-task-id="atlantic"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).selectedTaskId,
    "harbor",
  );
  await page.keyboard.press("Meta+4");
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).section,
    "settings",
  );
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .locator('[data-setting="Appearance"]')
    .waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Privacy", exact: true }).click();
  await page
    .locator('[data-setting="Privacy"]')
    .first()
    .waitFor({ state: "visible" });
  cases.push("keyboard-and-settings-navigation");

  const reviewSetup = page.locator("#review-setup");
  await reviewSetup.click();
  await page.locator("#setup-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.id === "setup-next");
  await page.locator("#setup-next").click();
  assert.equal(
    await page.locator("#setup-counter").textContent(),
    "Step 2 of 5",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.activeElement?.id === "review-setup",
  );
  cases.push("setup-dialog-focus-return");

  await page.locator("#command-button").focus();
  await page.keyboard.press("Meta+k");
  await page.locator("#command-search").fill("Activity");
  await page.keyboard.press("Enter");
  assert.equal(
    (await page.evaluate(() => window.farolLab.snapshot())).section,
    "activity",
  );
  await page.waitForFunction(
    () => document.activeElement?.id === "command-button",
  );
  cases.push("quick-switcher-focus-return");

  await setScene(page, {
    direction: "beacon",
    section: "activity",
    task: "atlantic",
    state: "failed",
  });
  await page.locator('[data-filter="complete"]').click();
  assert.equal(await page.locator("#timeline li").first().isHidden(), true);
  assert.equal(
    await page.locator('[data-filter="complete"]').getAttribute("aria-pressed"),
    "true",
  );
  await setScene(page, {
    direction: "beacon",
    section: "activity",
    task: "atlantic",
    state: "complete",
  });
  assert.equal(await page.locator("#timeline li").first().isVisible(), true);
  await page.locator('[data-filter="attention"]').click();
  assert.equal(await page.locator("#timeline li").first().isHidden(), true);
  await setScene(page, {
    direction: "beacon",
    section: "activity",
    task: "atlantic",
    state: "failed",
  });
  assert.equal(await page.locator("#timeline li").first().isVisible(), true);
  cases.push("activity-filtering");

  await setScene(page, {
    direction: "beacon",
    section: "settings",
    task: "atlantic",
    state: "unavailable",
  });
  assert.equal(
    (await page.locator("#runtime-status-label").textContent()).trim(),
    "Local runtime offline",
  );
  assert.equal(
    (await page.locator("#runtime-readiness-label").textContent()).trim(),
    "Offline",
  );
  assert.match(await page.locator("#state-title").textContent(), /offline/u);
  assert.equal(await page.locator("#new-task").isDisabled(), true);
  cases.push("runtime-readiness-single-source");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() => {
    const duration = getComputedStyle(document.querySelector(".primary-action"))
      .transitionDuration.split(",")
      .map(
        (value) => Number.parseFloat(value) * (value.includes("ms") ? 1 : 1000),
      );
    return Math.max(...duration);
  });
  assert.ok(reducedMotion <= 0.001);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  cases.push("reduced-motion");

  await setContentSize(application, 760, 640);
  const compactRoutes = [
    ["browser", "Browser", "⌘1"],
    ["computer", "Computer", "⌘2"],
    ["activity", "Activity", "⌘3"],
    ["settings", "Settings", "⌘4"],
  ];
  for (const [section, name, shortcut] of compactRoutes) {
    const route = page.getByRole("button", { name: `Open ${name}` });
    assert.equal(await route.isVisible(), true);
    assert.equal(await route.getAttribute("data-section"), section);
    assert.equal(await route.getAttribute("title"), `${name} (${shortcut})`);
  }
  cases.push("compact-route-accessible-names");

  await setScene(page, {
    direction: "beacon",
    section: "browser",
    task: "release",
    state: "complete",
  });
  const compactLongLabel = await page.evaluate(() => {
    const tabLabel = document.querySelector('[data-task-id="release"] strong');
    const title = document.querySelector("#browser-title");
    if (!tabLabel || !title) throw new Error("LAB_LONG_LABEL_TARGET_MISSING");
    const titleBounds = title.getBoundingClientRect();
    return {
      tabClientWidth: tabLabel.clientWidth,
      tabScrollWidth: tabLabel.scrollWidth,
      titleLeft: titleBounds.left,
      titleRight: titleBounds.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  assert.ok(
    compactLongLabel.tabScrollWidth > compactLongLabel.tabClientWidth,
    "long-task-label-must-truncate",
  );
  assert.ok(compactLongLabel.titleLeft >= 0);
  assert.ok(compactLongLabel.titleRight <= compactLongLabel.viewportWidth);
  assert.ok(
    compactLongLabel.documentWidth <= compactLongLabel.viewportWidth,
    "long-task-label-horizontal-overflow",
  );
  cases.push("long-task-label-compact");

  const directionCaptures = [
    ["native", "01-studio-rail"],
    ["dense", "02-operator-grid"],
    ["beacon", "03-beacon-field"],
  ];
  const comparisonScenes = [
    { slug: "browser-running", section: "browser", state: "running" },
    { slug: "computer-waiting", section: "computer", state: "waiting" },
  ];
  const comparisonSizes = [
    { slug: "wide", width: 1180, height: 760 },
    { slug: "compact", width: 760, height: 640 },
  ];
  for (const [direction, directionSlug] of directionCaptures) {
    for (const scene of comparisonScenes) {
      for (const size of comparisonSizes) {
        await capture(application, page, {
          direction,
          section: scene.section,
          task: "atlantic",
          state: scene.state,
          width: size.width,
          height: size.height,
          file: `${directionSlug}-${scene.slug}-${size.slug}@2x.png`,
        });
      }
    }
  }
  cases.push("three-directions-two-scenes-wide-and-compact-retina");

  const recommendedCaptures = [
    {
      section: "activity",
      state: "unknown",
      width: 1180,
      height: 760,
      file: "beacon-activity-unknown-wide@2x.png",
    },
    {
      section: "settings",
      state: "unavailable",
      width: 760,
      height: 640,
      file: "beacon-settings-unavailable-compact@2x.png",
    },
  ];
  for (const definition of recommendedCaptures) {
    await capture(application, page, {
      direction: "beacon",
      task: "atlantic",
      ...definition,
    });
  }

  await setContentSize(application, 1180, 760);
  await setScene(page, {
    direction: "beacon",
    section: "settings",
    task: "atlantic",
    state: "waiting",
  });
  await page.locator("#review-setup").click();
  const setupPath = path.join(galleryRoot, "beacon-setup-wide@2x.png");
  await page.screenshot({ path: setupPath, animations: "disabled" });
  assert.deepEqual(pngDimensions(await fs.readFile(setupPath)), {
    width: 2360,
    height: 1520,
  });
  screenshots.push({
    file: "beacon-setup-wide@2x.png",
    direction: "beacon",
    section: "setup",
    state: "waiting",
    viewport: "1180x760",
    pixels: "2360x1520",
  });
  cases.push("recommended-surface-states");

  await page.locator("#setup-close").click();
  const originalUrl = page.url();
  const blockedTargets = [
    pathToFileURL(path.join(nextRoot, "design-lab-other", "probe.html")).href,
    "https://example.invalid/farol-design-lab-probe",
  ];
  for (const target of blockedTargets) {
    await page.evaluate((url) => window.location.assign(url), target);
    await page.waitForTimeout(50);
    assert.equal(page.url(), originalUrl);
  }
  const navigationBlocks = await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("LAB_WINDOW_MISSING");
    return target.farolLabNavigationGuard.blocked;
  });
  assert.deepEqual(navigationBlocks, ["file", "external"]);
  cases.push("exact-page-navigation-boundary");
} finally {
  await close(prototype);
}

const gallery = await launchGallery();
try {
  const galleryPath = path.join(galleryRoot, "directions-overview@2x.png");
  await gallery.page.screenshot({
    path: galleryPath,
    fullPage: true,
    animations: "disabled",
  });
  const dimensions = pngDimensions(await fs.readFile(galleryPath));
  const galleryViewport = await gallery.page.evaluate(() => ({
    innerWidth: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(galleryViewport.innerWidth >= 1400);
  assert.equal(dimensions.width, galleryViewport.contentWidth * 2);
  screenshots.push({
    file: "directions-overview@2x.png",
    direction: "comparison",
    section: "browser+computer",
    state: "running+waiting",
    viewport: `${galleryViewport.innerWidth}xfull-page`,
    pixels: `${dimensions.width}x${dimensions.height}`,
  });
  cases.push("rendered-comparison-gallery");
} finally {
  await close(gallery);
}

const visiblePrototype = await launchPrototype({ show: true });
try {
  const presentation = await visiblePrototype.application.evaluate(
    ({ BrowserWindow, screen }) => {
      const target = BrowserWindow.getAllWindows()[0];
      if (!target) throw new Error("LAB_WINDOW_MISSING");
      const bounds = target.getBounds();
      const primary = screen.getPrimaryDisplay();
      const selected = screen.getDisplayMatching(bounds);
      const displays = screen.getAllDisplays().map((display) => ({
        id: display.id,
        internal: display.internal,
        primary: display.id === primary.id,
        workArea: display.workArea,
      }));
      return {
        visible: target.isVisible(),
        focused: target.isFocused(),
        bounds,
        planned: target.farolLabPlacement,
        display: {
          id: selected.id,
          internal: selected.internal,
          primary: selected.id === primary.id,
          selection: target.farolLabPlacement.selection,
          workArea: selected.workArea,
        },
        displays,
      };
    },
  );
  assert.equal(presentation.visible, true);
  assert.equal(presentation.focused, false);
  assert.equal(presentation.display.id, presentation.planned.displayId);
  assert.equal(presentation.display.internal, presentation.planned.internal);
  assert.equal(presentation.display.primary, presentation.planned.primary);
  const preferred = presentation.displays.filter(
    (display) => !display.primary && display.internal,
  );
  const secondary = presentation.displays.filter((display) => !display.primary);
  if (preferred.length > 0) {
    assert.equal(presentation.display.selection, "non-primary-internal");
  } else if (secondary.length > 0) {
    assert.equal(presentation.display.selection, "non-primary");
  } else if (presentation.displays.some((display) => display.internal)) {
    assert.equal(presentation.display.selection, "internal-primary-fallback");
  } else {
    assert.equal(presentation.display.selection, "primary-fallback");
  }
  assert.ok(presentation.bounds.x >= presentation.display.workArea.x);
  assert.ok(presentation.bounds.y >= presentation.display.workArea.y);
  assert.ok(
    presentation.bounds.x + presentation.bounds.width <=
      presentation.display.workArea.x + presentation.display.workArea.width,
  );
  assert.ok(
    presentation.bounds.y + presentation.bounds.height <=
      presentation.display.workArea.y + presentation.display.workArea.height,
  );
  visibleWindow = {
    visible: presentation.visible,
    focused: presentation.focused,
    bounds: presentation.bounds,
    display: {
      id: presentation.display.id,
      internal: presentation.display.internal,
      primary: presentation.display.primary,
      selection: presentation.display.selection,
    },
    primaryFallback: presentation.display.primary,
  };
  cases.push("visible-secondary-display-launch");
} finally {
  await close(visiblePrototype);
}

assert.deepEqual(externalRequests, []);
assert.deepEqual(consoleErrors, []);
assert.deepEqual(pageErrors, []);
cases.push("no-external-network-or-render-errors");

const digestInputs = [
  "prototype.html",
  "prototype.css",
  "prototype.js",
  "gallery.html",
  "gallery.css",
  "gallery.js",
  "tooling/lab-main.cjs",
].map((file) => path.join(labRoot, file));
const report = {
  schema: 1,
  result: "passed",
  fixture: "synthetic-local-atlantic",
  recommendedDirection: "beacon-field",
  ownerApproval: false,
  sourceBoundary: "tracked-nonshipping-design-lab",
  visibleWindow,
  prototypeSha256: await digestFiles(digestInputs),
  cases,
  screenshots,
};
await fs.writeFile(
  path.join(galleryRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
