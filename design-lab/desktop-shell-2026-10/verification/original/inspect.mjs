import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire("/Users/ac/code/farol/package.json");
const { chromium } = require("playwright-core");
const root = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, "screenshots"), { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const results = [],
  faults = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  await context.route(/^https?:/, (route) => {
    faults.push("Unexpected external request: " + route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => faults.push(e.message));
  const base = pathToFileURL(path.join(root, "index.html")).href;
  async function scene(name, query, width = 1180, height = 760) {
    await page.setViewportSize({ width, height });
    await page.goto(base + "?present=1&" + query);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      name + ": viewport overflow",
    );
    await page.screenshot({
      path: path.join(root, "screenshots", name + ".png"),
    });
    results.push(name);
  }
  for (const direction of ["mac", "graphite", "studio"]) {
    await scene(direction + "-home", "direction=" + direction + "&page=home");
    await scene(
      direction + "-settings",
      "direction=" + direction + "&page=settings&sub=general",
    );
  }
  await scene(
    "graphite-folders",
    "direction=graphite&page=settings&sub=folders",
  );
  await page
    .getByRole("button", { name: "Notes Read-only", exact: true })
    .click();
  await page
    .locator(".folder-detail")
    .getByRole("heading", { name: "Notes", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add folder…", exact: true }).click();
  await page.getByLabel("Folder label").fill("Preview folder");
  await page
    .getByRole("button", { name: "Preview addition", exact: true })
    .click();
  await page
    .locator(".folder-detail")
    .getByRole("heading", { name: "Preview folder", exact: true })
    .waitFor();
  results.push("folder selection and local sample addition");
  await scene(
    "graphite-activity",
    "direction=graphite&page=activity&state=attention",
  );
  await page.getByLabel("Activity filter").selectOption("attention");
  await page
    .getByRole("heading", { name: "Connection check", exact: true })
    .waitFor();
  assert.equal(await page.locator(".context .item").count(), 2);
  results.push("activity attention filter and matching detail");
  await scene("graphite-chat", "direction=graphite&page=chat");
  await page
    .getByRole("button", {
      name: "2 ChatGPT 2 Design review Working",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Design review", exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".browser-top strong").textContent(),
    "ChatGPT 2",
  );
  results.push("stable chat selection");
  await scene(
    "graphite-home-attention",
    "direction=graphite&page=home&state=attention",
  );
  await scene(
    "graphite-home-empty",
    "direction=graphite&page=home&state=empty",
  );
  await scene(
    "graphite-home-ready",
    "direction=graphite&page=home&state=ready",
  );
  await scene(
    "graphite-home-offline",
    "direction=graphite&page=home&state=offline",
  );
  await scene(
    "graphite-compact",
    "direction=graphite&page=settings&sub=general",
    760,
    640,
  );
  assert.equal(await page.locator("#context").isVisible(), false);
  await page
    .getByRole("button", { name: "Toggle section menu", exact: true })
    .click();
  await page.getByRole("button", { name: "Updates", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(root, "screenshots", "graphite-compact-menu.png"),
  });
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
  assert.equal(await page.locator("#context").isVisible(), false);
  await page
    .getByRole("button", { name: "Review restore…", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Restore Farol 0.1.7?", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Review restore…", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  results.push("compact menu, route selection, dialog Escape and focus return");
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.getByLabel("Page name", { exact: true }).fill("Model");
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Model", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Model", exact: true, level: 1 })
    .waitFor();
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  results.push("page search and dialog dismissal");
  for (const [pageName, sub] of [
    ["settings", "mac"],
    ["settings", "connection"],
    ["settings", "model"],
    ["settings", "shortcuts"],
    ["settings", "updates"],
    ["settings", "diagnostics"],
    ["setup", "overview"],
    ["setup", "signin"],
    ["setup", "add"],
  ]) {
    await page.goto(base + "?present=1&page=" + pageName + "&sub=" + sub);
    assert.equal(await page.locator(".content h1").count(), 1);
  }
  results.push("all remaining settings and setup pages render");
  await scene("narrow-home", "direction=mac&page=home", 500, 720);
  await scene(
    "narrow-folders",
    "direction=graphite&page=settings&sub=folders",
    500,
    720,
  );
  await page.setViewportSize({ width: 1440, height: 990 });
  await page.goto(base);
  await page.screenshot({
    path: path.join(root, "screenshots", "design-room.png"),
  });
  assert.deepEqual(faults, []);
  await writeFile(
    path.join(root, "inspection.json"),
    JSON.stringify(
      {
        mode: "headless Chromium, disposable browser context, local file only",
        limits: "DOM prototype, no native Electron or live provider evidence",
        results,
        errors: faults,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      result: "passed",
      inspected: results.length,
      errors: faults,
      output: root,
    }),
  );
} finally {
  await browser.close();
}
