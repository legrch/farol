import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const require = createRequire("/Users/ac/code/farol/package.json");
const { chromium } = require("playwright-core");
const root = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, "screenshots-v3"), { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const results = [],
  errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  await ctx.route(/^https?:/, (route) => {
    errors.push("External request: " + route.request().url());
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const base = pathToFileURL(path.join(root, "index.html")).href;
  async function scene(name, query = "", width = 1180, height = 760) {
    await page.setViewportSize({ width, height });
    await page.goto(base + "?present=1&" + query);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      name + ": overflow",
    );
    assert.equal(await page.locator(".rail-brand").count(), 0);
    assert.equal(await page.locator(".pane .toolbar").count(), 0);
    assert.equal(await page.locator("#window h1").count(), 1);
    await page.screenshot({
      path: path.join(root, "screenshots-v3", name + ".png"),
    });
    results.push(name);
  }
  for (const theme of ["light", "dark"]) {
    await scene(theme + "-home", "theme=" + theme);
    await scene(
      theme + "-appearance",
      "theme=" + theme + "&page=settings&sub=appearance",
    );
  }
  await scene("activity-leaf-title", "theme=dark&page=activity");
  await page.locator('[data-event="3"]').first().click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Folder inventory",
  );
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "activity-leaf-title.png"),
  });
  results.push("Activity uses only the selected event title");
  await scene("chat-five-windows", "theme=dark&page=chat");
  assert.equal(await page.locator(".window-item").count(), 5);
  assert.equal(
    await page.locator("#rail button").first().getAttribute("aria-label"),
    "Home",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Appearance",
  );
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "General",
  );
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  assert.equal(await page.locator(".window-item").count(), 5);
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "General",
  );
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Go forward", exact: true })
      .isDisabled(),
    true,
  );
  results.push(
    "Back/forward restore page selection; new branch clears forward history",
  );
  await page.goto(base + "?present=1&page=settings&sub=folders");
  await page.locator(".content").evaluate((e) => (e.scrollTop = 200));
  const oldScroll = await page.locator(".content").evaluate((e) => e.scrollTop);
  await page.getByRole("button", { name: "This Mac", exact: true }).click();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  assert.equal(
    await page.locator(".content").evaluate((e) => e.scrollTop),
    oldScroll,
  );
  results.push("Back restores inspector scroll position");
  await scene(
    "appearance-collapsed",
    "theme=dark&page=settings&sub=appearance",
  );
  await page
    .getByRole("button", { name: "Toggle section menu", exact: true })
    .click();
  assert.equal(await page.locator("#context").isVisible(), false);
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "appearance-collapsed.png"),
  });
  await page
    .getByRole("button", { name: "Toggle section menu", exact: true })
    .click();
  results.push("Sidebar collapses from the unified toolbar");
  await scene("update-notice", "theme=light&state=ready&update=available");
  await page
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "A new version of Farol is available",
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "update-available.png"),
  });
  await page
    .getByRole("checkbox", {
      name: "Automatically download and install updates in the future",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Download Update", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Update Farol now?", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "update-confirm.png"),
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Remind Me Later", exact: true })
    .click();
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(await page.locator("#update-notice").isVisible(), false);
  assert.equal(
    await page
      .getByRole("button", { name: "Update ready", exact: true })
      .count(),
    1,
  );
  results.push(
    "Download, confirmation and Later keep context and a persistent update entry",
  );
  await scene("update-running", "theme=dark&update=ready&dialog=update");
  assert.equal(
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByText(
      "A task is still running. Wait for it to finish before restarting.",
      { exact: true },
    )
    .waitFor();
  results.push("Active work blocks restart");
  await scene(
    "update-unknown",
    "theme=light&state=attention&update=ready&dialog=update",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .isDisabled(),
    true,
  );
  results.push("Unconfirmed outcome blocks restart");
  await scene(
    "update-draft",
    "theme=dark&state=ready&gate=draft&update=ready&dialog=update",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .isDisabled(),
    true,
  );
  results.push("Browser draft blocks restart");
  await scene("update-failed", "theme=dark&update=failed&dialog=update");
  assert.equal(
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "View Diagnostics", exact: true })
    .click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Diagnostics",
  );
  results.push("Update failure routes to Diagnostics without retry");
  await scene(
    "update-skip",
    "theme=light&state=ready&update=available&dialog=update",
  );
  await page
    .getByRole("button", { name: "Skip This Version", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Update available", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator("#update-notice").isVisible(), false);
  results.push("Skip suppresses only this version in the sample");
  await scene(
    "updates-settings",
    "theme=light&state=ready&page=settings&sub=updates",
  );
  await page
    .getByRole("button", { name: "Check for Updates…", exact: true })
    .click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Updates",
  );
  await page
    .getByRole("heading", {
      name: "A new version of Farol is available",
      exact: true,
    })
    .waitFor();
  results.push("Check for Updates opens a dialog without changing the page");
  await scene(
    "compact-settings",
    "theme=dark&page=settings&sub=appearance",
    760,
    640,
  );
  await page
    .getByRole("button", { name: "Toggle section menu", exact: true })
    .click();
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), true);
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "compact-menu.png"),
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), false);
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.mouse.click(2, 2);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(
    await page
      .getByRole("button", { name: "Find a page", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  results.push("Compact menu and outside search dismissal retain focus");
  await scene(
    "narrow-appearance",
    "theme=light&page=settings&sub=appearance",
    500,
    720,
  );
  await scene(
    "narrow-update",
    "theme=light&state=ready&update=available&dialog=update",
    500,
    720,
  );
  for (const [screen, sub] of [
    ["settings", "general"],
    ["settings", "folders"],
    ["settings", "mac"],
    ["settings", "connection"],
    ["settings", "model"],
    ["settings", "shortcuts"],
    ["settings", "diagnostics"],
    ["setup", "overview"],
    ["setup", "signin"],
    ["setup", "folders"],
    ["setup", "connection"],
    ["setup", "add"],
  ]) {
    await page.goto(base + "?present=1&page=" + screen + "&sub=" + sub);
    assert.equal(await page.locator("#window h1").count(), 1);
  }
  results.push("All configuration/setup pages keep a single active title");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(path.join(root, "brand.html")).href);
  assert.equal(await page.locator("article").count(), 3);
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "abstract-brand.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Monochrome", exact: true }).click();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "abstract-brand-mono.png"),
    fullPage: true,
  });
  results.push(
    "Three abstract emblems, Dock variants and monochrome menu symbols",
  );
  await page.goto(pathToFileURL(path.join(root, "menu-bar.html")).href);
  await page
    .getByRole("button", { name: "Farol — Ready", exact: true })
    .click();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "menu-bar-ready.png"),
  });
  await page.keyboard.press("ArrowDown");
  assert.match(
    await page.locator("#status-menu :focus").textContent(),
    /Check for Updates/,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#status-menu").isVisible(), false);
  await page.locator("#menu-state").selectOption("attention");
  await page
    .getByRole("button", { name: "Farol — Needs attention", exact: true })
    .click();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "menu-bar-attention.png"),
  });
  await page.mouse.click(30, 30);
  assert.equal(await page.locator("#status-menu").isVisible(), false);
  await page.locator("#bar-theme").selectOption("dark");
  await page.locator("#menu-state").selectOption("running");
  await page
    .getByRole("button", { name: "Farol — 1 task running", exact: true })
    .click();
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "menu-bar-running.png"),
  });
  await page
    .getByRole("menuitem", { name: "Quit Farol", exact: false })
    .click();
  await page.getByText(/Quit preview: the installed app/).waitFor();
  results.push(
    "Menu bar states, keyboard movement, Escape/outside dismissal and bounded quit preview",
  );
  await page
    .getByRole("button", { name: "Farol — 1 task running", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Check for Updates…", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "A new version of Farol is available",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Home",
  );
  results.push("Menu-bar update opens a dialog over Home");
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "inspection-v3.json"),
    JSON.stringify(
      {
        mode: "headless Chromium, disposable context, local files only, external requests blocked",
        limits:
          "DOM/SVG prototype only; no native toolbar, Tray, menu, provider, install or restart evidence",
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ result: "passed", inspected: results.length, errors }),
  );
} finally {
  await browser.close();
}
