import { createRequire } from "node:module";
import { mkdir, writeFile, access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot =
  process.env.FAROL_PROJECT_ROOT || path.resolve(root, "../..");
const require = createRequire(path.join(projectRoot, "package.json"));
const { chromium } = require("playwright-core");
const output = path.join(projectRoot, "_output/design-handoff");
await mkdir(path.join(output, "screenshots"), { recursive: true });
const pickerRoot = await mkdtemp(
  path.join(os.tmpdir(), "farol-design-picker-"),
);
const pickerFixture = path.join(pickerRoot, "Example folder");
await mkdir(pickerFixture, { recursive: true });
await writeFile(
  path.join(pickerFixture, "sample.txt"),
  "Synthetic folder-selection metadata fixture only.",
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_EXECUTABLE ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const results = [],
  errors = [],
  shots = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await ctx.route(/^https?:/, (r) => {
    errors.push("External request: " + r.request().url());
    return r.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const url = (name) => pathToFileURL(path.join(root, name)).href;
  const base = url("index.html");
  await page.goto(base);
  const screenshot = async (name) => {
    await page.screenshot({
      path: path.join(output, "screenshots", name + ".png"),
    });
    shots.push(name);
  };
  async function scene(query = "", width = 1180, height = 760) {
    await page.evaluate(() => localStorage.clear());
    await page.setViewportSize({ width, height });
    await page.goto(base + "?present=1&" + query);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "horizontal overflow " + query,
    );
    assert.equal(await page.locator("#window h1").count(), 1);
  }
  let lightGeometry;
  for (const theme of ["light", "dark"]) {
    await scene(`theme=${theme}&page=settings&sub=appearance`);
    const geometry = await page
      .locator(
        ".appearance-group, .appearance-group .row, .choice-row, .theme-choice",
      )
      .evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          const c = getComputedStyle(e);
          return {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            p: c.padding,
            b: c.borderWidth,
            r: c.borderRadius,
            f: c.fontSize,
          };
        }),
      );
    if (theme === "light") lightGeometry = geometry;
    else
      assert.deepEqual(
        geometry,
        lightGeometry,
        "light/dark appearance geometry differs",
      );
    await screenshot(theme + "-appearance");
  }
  results.push(
    "Light/dark Appearance has identical boxes, padding, borders, radii and font sizes",
  );
  await scene("theme=light&page=settings&sub=general");
  assert.equal(
    await page.getByRole("combobox", { name: "Sidebar", exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "Activity detail", exact: true })
      .count(),
    0,
  );
  await screenshot("general");
  await page
    .getByRole("combobox", { name: "Sidebar", exact: true })
    .selectOption("Remember my choice");
  await page
    .getByRole("button", { name: "Show or hide sidebar", exact: true })
    .click();
  assert.equal(await page.locator("#context").isVisible(), false);
  await page
    .getByRole("button", { name: "Show or hide sidebar", exact: true })
    .click();
  results.push(
    "Sidebar preference names its real region; Activity detail preference removed",
  );
  await scene("theme=light&page=settings&sub=folders");
  assert.equal(
    await page
      .getByRole("combobox", { name: "Folder access", exact: true })
      .inputValue(),
    "Read & write",
  );
  assert.match(
    await page.locator(".permission-explainer").textContent(),
    /approval/,
  );
  await screenshot("folders");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add folder…", exact: true }).click();
  const picked = await chooser;
  assert.equal(picked.isMultiple(), true);
  await picked.setFiles(pickerFixture);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(
    await page.locator(".folder-title h2").textContent(),
    "Example folder",
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "Folder access", exact: true })
      .inputValue(),
    "Read-only",
  );
  assert.equal(
    await page.getByText("Check needed", { exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "Check access", exact: true }).click();
  assert.match(
    await page.locator("#dialog").textContent(),
    /cannot perform that check/,
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Folder access", exact: true })
    .selectOption("Read & write");
  assert.equal(
    await page.getByText("Check needed", { exact: true }).count(),
    1,
  );
  results.push(
    "Add folder invokes directory chooser; synthetic selection begins read-only/unverified; no mock verification",
  );
  await scene("theme=dark&page=settings&sub=mac");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Computer name", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.locator(".advanced-settings").getAttribute("open"),
    null,
  );
  await screenshot("this-mac");
  results.push(
    "This Mac has one name; command access is collapsed; arbitrary rename setting removed",
  );
  for (const [fixture, name] of [
    ["ready", "home-ready"],
    ["attention", "home-unconfirmed"],
  ]) {
    await scene("theme=light&state=" + fixture);
    assert.equal(
      await page.locator(".health-summary .badge").textContent(),
      fixture === "ready" ? "Ready" : "Connection check needed",
    );
    assert.match(
      await page.locator(".health").textContent(),
      /2 verified · 1 need a check/,
    );
    await screenshot(name);
  }
  results.push(
    "Home distinguishes connection readiness, unknown result and optional unverified folder access",
  );
  await scene("theme=light&state=ready&update=available");
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  await screenshot("update-notice");
  await page
    .getByRole("button", { name: "Update available", exact: true })
    .click();
  await screenshot("update-available");
  await page.mouse.click(15, 300);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(await page.locator("#update-notice").isVisible(), false);
  assert.equal(await page.locator(".update-dot").count(), 0);
  await page
    .getByRole("button", { name: "Update available", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  await page
    .getByRole("button", { name: "Update available", exact: true })
    .click();
  await page.getByRole("button", { name: "Close update", exact: true }).click();
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  results.push(
    "Quiet notice only; review closes by backdrop, Escape and Close; acknowledgement clears attention dot",
  );
  await scene(
    "theme=light&state=working&update=available&page=settings&sub=updates",
  );
  await page
    .getByRole("switch", { name: "Automatic updates", exact: true })
    .click();
  await page.waitForFunction(() => demoUpdate.phase === "ready");
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  await screenshot("updates-settings");
  await page.goto(
    base + "?present=1&theme=dark&state=working&update=available&version=0.2.0",
  );
  await page.waitForFunction(() => demoUpdate.phase === "ready");
  assert.equal(await page.evaluate(() => demoUpdate.automatic), true);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  await page.getByRole("button", { name: "Update ready", exact: true }).click();
  assert.match(
    await page.locator(".update-policy-strip").textContent(),
    /Automatic updates are on/,
  );
  assert.equal(await page.locator("#dialog [role=switch]").count(), 0);
  assert.equal(await page.evaluate(() => demoUpdate.current), "0.1.8");
  await screenshot("update-auto-ready");
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("heading", { name: "Interrupt work and update?", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await screenshot("update-interrupt-confirm");
  await page.mouse.click(15, 300);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(await page.evaluate(() => demoUpdate.current), "0.1.8");
  await page.getByRole("button", { name: "Update ready", exact: true }).click();
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Interrupt & Update", exact: true })
    .click();
  assert.equal(await page.evaluate(() => chats()[1].phase), "Interrupted");
  assert.equal(await page.evaluate(() => eventsFor()[1].code), "INTERRUPTED");
  assert.equal(await page.evaluate(() => demoUpdate.current), "0.2.0");
  results.push(
    "Automatic preference persists to next candidate; background download has no forced dialog; click reviews only; confirmed mock interruption never completes the task",
  );
  for (const [fixture, gate, name] of [
    ["ready", "draft", "update-draft-confirm"],
    ["attention", "unknown", "update-unknown-confirm"],
  ]) {
    await scene(
      `theme=light&state=${fixture}&gate=${gate}&update=ready&dialog=update`,
    );
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Interrupt & Update", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await screenshot(name);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
    assert.equal(await page.evaluate(() => demoUpdate.current), "0.1.8");
    if (gate === "unknown") {
      await page
        .getByRole("button", { name: "Update ready", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Restart & Update", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Interrupt & Update", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() => eventsFor()[1].code),
        "OUTCOME_UNKNOWN",
      );
    }
  }
  results.push(
    "Draft and unknown-work warnings permit explicit interruption; Cancel changes nothing; unknown remains unknown",
  );
  await scene("theme=light&state=ready&update=ready");
  await page.getByRole("button", { name: "Update ready", exact: true }).click();
  assert.equal(await page.evaluate(() => demoUpdate.current), "0.1.8");
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .click();
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(await page.evaluate(() => demoUpdate.current), "0.1.9");
  assert.equal(await page.evaluate(() => demoUpdate.didInterrupt), false);
  results.push(
    "Idle review offers one explicit restart action without an unnecessary second confirmation",
  );
  await scene(
    "theme=dark&state=ready&gate=integrity&update=ready&dialog=update",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Restart & Update", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  results.push(
    "Package verification failure remains a hard installation block",
  );
  await scene("theme=light&state=ready&update=failed");
  assert.equal(
    await page
      .getByRole("button", { name: "Update needs attention", exact: true })
      .count(),
    1,
  );
  await page
    .getByRole("button", { name: "Update needs attention", exact: true })
    .click();
  await screenshot("update-failed");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "View update status", exact: true })
      .count(),
    1,
  );
  assert.equal(await page.locator(".update-dot").count(), 0);
  await page.reload();
  assert.equal(
    await page
      .getByRole("button", { name: "View update status", exact: true })
      .count(),
    1,
  );
  assert.equal(await page.locator("#update-notice").isVisible(), false);
  results.push(
    "Acknowledged same-candidate failure stays discoverable without repeating warning or badge after reload",
  );
  await scene("state=ready&update=available&dialog=update");
  await page
    .getByRole("button", { name: "Skip This Version", exact: true })
    .click();
  await page.reload();
  assert.equal(await page.locator(".rail-update").count(), 0);
  await page.goto(
    base + "?present=1&state=ready&update=available&version=0.2.1",
  );
  assert.equal(await page.locator(".rail-update").count(), 1);
  results.push(
    "Skip is candidate-specific and survives reload; next version is eligible",
  );
  await scene("theme=dark&page=settings&sub=updates&update=available");
  await page
    .getByRole("switch", { name: "Update notices", exact: true })
    .click();
  assert.equal(await page.locator("#update-notice").isVisible(), false);
  assert.equal(await page.locator(".rail-update").count(), 1);
  results.push(
    "Update notice preference hides prompts while keeping manual review",
  );
  await scene("theme=dark&page=settings&sub=appearance", 500, 820);
  await screenshot("compact-appearance");
  await page
    .getByRole("button", { name: "Show or hide sidebar", exact: true })
    .click();
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), false);
  await scene("theme=light&state=working&update=ready&dialog=update", 500, 820);
  await page
    .getByRole("button", { name: "Restart & Update", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("#dialog").scrollWidth <=
        document.querySelector("#dialog").clientWidth,
    ),
    true,
  );
  await screenshot("compact-update-confirm");
  results.push(
    "500px layout, sidebar overlay inertness and interruption dialog fit",
  );
  await scene("theme=dark&page=activity");
  await page.locator('[data-event="3"]').first().click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Folder inventory",
  );
  await screenshot("activity-history");
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Atlas workspace check",
  );
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Folder inventory",
  );
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.mouse.click(15, 300);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  results.push(
    "One selected title, app history and dismissible page search retained",
  );
  assert.equal(
    await page
      .locator(".content")
      .evaluate((e) => getComputedStyle(e).scrollbarWidth),
    "thin",
  );
  assert.equal(
    await page
      .locator(".content")
      .evaluate((e) => getComputedStyle(e).scrollbarGutter),
    "stable",
  );
  results.push("Themed thin scrolling reserves a stable gutter");
  await page.goto(url("brand.html"));
  await page.setViewportSize({ width: 1180, height: 900 });
  for (const img of await page.locator("img").all()) {
    await img.evaluate((e) => e.decode());
    assert.equal(await img.evaluate((e) => e.naturalWidth > 0), true);
  }
  await screenshot("signal-lens-dock-concepts");
  for (const name of ["prism", "aurora-enamel", "iris-glass"]) {
    await page.locator(`[data-choice="${name}"]`).click();
    assert.match(
      await page.locator("#selected-icon").getAttribute("src"),
      new RegExp(name),
    );
  }
  await page.locator('[data-desktop="dark"]').click();
  await page.locator(".dock-preview").scrollIntoViewIfNeeded();
  await screenshot("signal-lens-dock-context");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  results.push(
    "Three color Signal Lens images load; Dock preview selects each and changes desktop backdrop",
  );
  await page.setViewportSize({ width: 500, height: 820 });
  await page.goto(url("brand.html"));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator(".dock-preview").scrollIntoViewIfNeeded();
  for (const img of await page.locator("img").all())
    await img.evaluate((e) => e.decode());
  await page.locator(".dock").scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await screenshot("compact-dock");
  results.push("Brand and Dock study fit a 500px preview");
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto(url("menu-bar.html"));
  await page.locator("#menu-state").selectOption("running");
  await page.locator("#bar-theme").selectOption("dark");
  await page.locator("#status-trigger").click();
  await screenshot("menu-bar-running");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#status-menu").isVisible(), false);
  results.push(
    "Signal Lens menu study retains status, contextual action and keyboard dismissal",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "inspection.json"),
    JSON.stringify(
      {
        mode: "Headless Chromium; disposable context; external requests blocked; DOM prototype only",
        sourceSnapshot: "DOM export only; production source not exercised",
        results,
        shots,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      result: "passed",
      checks: results.length,
      screenshots: shots.length,
      errors,
    }),
  );
} finally {
  await browser.close();
  await rm(pickerRoot, { recursive: true, force: true });
}
