import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire("/Users/ac/code/farol/package.json");
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const errors = [],
  results = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  await ctx.route(/^https?:/, (r) => {
    errors.push("External request: " + r.request().url());
    return r.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const base = pathToFileURL(path.join(root, "index.html")).href;
  await page.goto(base + "?present=1&page=settings&sub=appearance");
  await page.getByRole("button", { name: "Light", exact: true }).last().click();
  assert.equal(
    await page
      .locator('.content [data-theme="light"]')
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Cobalt accent", exact: true })
    .click();
  assert.equal(
    await page
      .locator('.content [data-accent="cobalt"]')
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.getByLabel("Typeface").selectOption("System");
  assert.equal(
    await page
      .getByLabel("Typeface")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  results.push("Theme, accent and typeface retain focus inside Appearance");
  await page.goto(base + "?present=1&page=activity&state=ready");
  await page.locator("#activity-filter").selectOption("attention");
  await page
    .getByRole("heading", { name: "No events need attention", exact: true })
    .waitFor();
  assert.equal(await page.locator(".event-item").count(), 0);
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "activity-quiet-filter.png"),
  });
  results.push("Quiet attention filter has matching empty list and detail");
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(
    await page
      .getByRole("button", { name: "Find a page", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  results.push("Search Escape dismisses and restores focus");
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(pathToFileURL(path.join(root, "gallery.html")).href);
  await page.locator("img").last().waitFor();
  assert.equal(await page.locator("img").count(), 8);
  assert.equal(
    await page
      .locator("img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0),
      ),
    true,
  );
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "theme-comparison.png"),
    fullPage: true,
  });
  results.push(
    "Theme comparison uses all six palettes and both Appearance pages",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(path.join(root, "brand.html")).href);
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "brand-study.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const report = JSON.parse(
    await readFile(path.join(root, "inspection-v2.json"), "utf8"),
  );
  report.results.push(...results);
  report.errors.push(...errors);
  await writeFile(
    path.join(root, "inspection-v2.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      result: "passed",
      inspected: report.results.length,
      focused: results,
      errors,
    }),
  );
} finally {
  await browser.close();
}
