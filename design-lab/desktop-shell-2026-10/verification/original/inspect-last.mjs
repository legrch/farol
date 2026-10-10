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
  await page.goto(base + "?present=1&page=activity&state=ready");
  await page.locator("#activity-filter").selectOption("attention");
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Activity",
  );
  assert.equal(await page.locator(".crumb").count(), 0);
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "activity-quiet-filter.png"),
  });
  await page.goto(base + "?present=1&page=activity&state=empty");
  assert.equal(
    await page.locator("#active-window-title").textContent(),
    "Activity",
  );
  results.push(
    "Empty Activity window title and breadcrumb match the displayed screen",
  );
  for (const fixture of ["working", "reused"]) {
    await page.goto(base + "?present=1&page=chat&state=" + fixture);
    assert.equal(
      await page.locator('.window-item[data-chat="4"] small').textContent(),
      "No task assigned",
    );
    await page.screenshot({
      path: path.join(
        root,
        "screenshots-v2",
        fixture === "working" ? "chat-current.png" : "chat-reused.png",
      ),
    });
  }
  results.push("Available windows have a distinct empty-task explanation");
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
      results,
      errors,
    }),
  );
} finally {
  await browser.close();
}
