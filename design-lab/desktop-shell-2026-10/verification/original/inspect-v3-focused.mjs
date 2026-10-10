import { createRequire } from "node:module";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const require = createRequire("/Users/ac/code/farol/package.json");
const { chromium } = require("playwright-core");
const root = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const results = [],
  errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
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
  await page.goto(url("menu-bar.html"));
  for (const [theme, status, shot] of [
    ["light", "ready", "menu-bar-ready"],
    ["light", "attention", "menu-bar-attention"],
    ["dark", "running", "menu-bar-running"],
  ]) {
    await page.locator("#bar-theme").selectOption(theme);
    await page.locator("#menu-state").selectOption(status);
    assert.deepEqual(
      await page
        .locator("#status-trigger svg path")
        .first()
        .evaluate((e) => [
          getComputedStyle(e).fill,
          getComputedStyle(e).stroke,
        ]),
      ["none", theme === "dark" ? "rgb(241, 242, 245)" : "rgb(48, 53, 64)"],
    );
    if (
      (await page.locator("#status-trigger").getAttribute("aria-expanded")) ===
      "false"
    )
      await page.locator("#status-trigger").click();
    await page.screenshot({
      path: path.join(root, "screenshots-v3", shot + ".png"),
    });
  }
  results.push(
    "Menu SVG outlines render correctly under CSP and inherit light/dark template ink",
  );
  await page.goto(
    url("index.html") + "?present=1&page=settings&sub=appearance&theme=light",
  );
  for (const accent of ["cobalt", "amber", "iris"]) {
    await page.locator('.pane [data-accent="' + accent + '"]').click();
    assert.equal(
      await page
        .locator('.pane [data-accent="' + accent + '"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page
        .locator('.pane [data-accent="' + accent + '"]')
        .evaluate((e) => e === document.activeElement),
      true,
    );
  }
  results.push(
    "All three accents apply and preserve focus without adding app history",
  );
  await page.locator('.pane [data-theme="system"]').click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() =>
    document.querySelector("#window").classList.contains("graphite"),
  );
  assert.equal(
    await page
      .locator("#window")
      .evaluate((e) => e.classList.contains("graphite")),
    true,
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() =>
    document.querySelector("#window").classList.contains("mac"),
  );
  assert.equal(
    await page.locator("#window").evaluate((e) => e.classList.contains("mac")),
    true,
  );
  results.push("System theme follows operating-system appearance");
  await page
    .getByRole("combobox", { name: "Typeface", exact: true })
    .selectOption("System");
  assert.equal(
    await page
      .locator("#window")
      .evaluate((e) => e.classList.contains("geist")),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Go back", exact: true })
      .isDisabled(),
    true,
  );
  results.push("System typeface applies without adding a route");
  await page.goto(url("gallery.html"));
  assert.equal(await page.locator("article img").count(), 10);
  for (const img of await page.locator("article img").all()) {
    await img.scrollIntoViewIfNeeded();
    await img.evaluate((e) => e.decode());
    assert.equal(await img.evaluate((e) => e.naturalWidth > 0), true);
  }
  for (const href of await page
    .locator("a")
    .evaluateAll((es) => es.map((e) => e.getAttribute("href")))) {
    await access(fileURLToPath(new URL(href, url("gallery.html"))));
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: path.join(root, "screenshots-v3", "review-gallery.png"),
    fullPage: true,
  });
  results.push("Revision 3 gallery images and local links resolve");
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "inspection-v3-focused.json"),
    JSON.stringify(
      {
        mode: "Headless Chromium; disposable context; local-only; focused checks after visual CSP fix and gallery update",
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ result: "passed", checks: results.length, errors }),
  );
} finally {
  await browser.close();
}
