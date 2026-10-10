import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const require = createRequire("/Users/ac/code/farol/package.json");
const { chromium } = require("playwright-core");
const root = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, "screenshots-v2"), { recursive: true });
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
    assert.equal(
      (await page.locator("#active-window-title").textContent()) === "Farol",
      false,
      "constant app title",
    );
    assert.equal(
      await page.locator(".rail-lamp").count(),
      0,
      "orphan status control",
    );
    await page.screenshot({
      path: path.join(root, "screenshots-v2", name + ".png"),
    });
    results.push(name);
  }
  for (const theme of ["light", "dark"]) {
    for (const accent of ["iris", "cobalt", "amber"])
      await scene(
        theme + "-" + accent + "-home",
        "theme=" + theme + "&accent=" + accent + "&page=home",
      );
    await scene(
      theme + "-appearance",
      "theme=" + theme + "&page=settings&sub=appearance",
    );
  }
  await page.getByRole("button", { name: "Light", exact: true }).last().click();
  assert.equal(
    await page.locator("#window").evaluate((e) => e.classList.contains("mac")),
    true,
  );
  await page
    .getByRole("button", { name: "Cobalt accent", exact: true })
    .click();
  assert.equal(
    await page
      .locator("#window")
      .evaluate((e) => getComputedStyle(e).getPropertyValue("--accent").trim()),
    "#315db5",
  );
  await page
    .getByRole("button", { name: "System", exact: true })
    .last()
    .click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() =>
    document.querySelector("#window").classList.contains("graphite"),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() =>
    document.querySelector("#window").classList.contains("mac"),
  );
  results.push("Appearance theme/accent changes and live system following");
  await page.getByLabel("Typeface").selectOption("System");
  assert.equal(
    await page
      .locator("#window")
      .evaluate((e) => e.classList.contains("geist")),
    false,
  );
  results.push("Typeface choice");
  await scene("chat-current", "theme=dark&page=chat");
  assert.equal(await page.locator(".window-item").count(), 5);
  assert.equal(
    await page.locator(".browser-message,.browser-bottom").count(),
    0,
  );
  await page.locator('.window-item[data-chat="2"]').click();
  assert.match(
    await page.locator("#active-window-title").textContent(),
    /2.*Design review/,
  );
  await page.locator('.window-item[data-chat="5"]').click();
  await page.getByText("Window 5 is available", { exact: true }).waitFor();
  results.push("Five numbered windows, active title and idle slot");
  await scene("activity-current", "theme=dark&page=activity");
  await page.getByRole("button", { name: "View chat", exact: true }).click();
  assert.equal(
    await page
      .locator('.window-item[aria-current="page"]')
      .getAttribute("data-chat"),
    "1",
  );
  results.push("Exact current-task chat link");
  await scene("activity-reused", "theme=dark&page=activity&state=reused");
  assert.equal(
    await page.getByRole("button", { name: "View chat", exact: true }).count(),
    0,
  );
  await page
    .getByRole("heading", { name: "Chat no longer available here" })
    .waitFor();
  results.push("Reused slot hides old-task chat link");
  await scene("chat-reused", "theme=dark&page=chat&state=reused");
  await page.locator(".recent-item").first().click();
  await page
    .getByRole("heading", { name: "Atlas workspace check", level: 1 })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "View chat", exact: true }).count(),
    0,
  );
  results.push("Recent work opens recorded details, not a different chat");
  await scene("home-attention", "theme=dark&page=home&state=attention");
  assert.equal(await page.locator(".home-attention").count(), 1);
  await page
    .getByRole("button", { name: "Inspect event", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Connection check", level: 1 })
    .waitFor();
  results.push("Home attention marker and recent-event routing");
  await scene("home-empty", "theme=light&page=home&state=empty");
  await scene(
    "compact-settings",
    "theme=dark&page=settings&sub=appearance",
    760,
    640,
  );
  assert.equal(await page.locator("#context").isVisible(), false);
  await page
    .getByRole("button", { name: "Toggle section menu", exact: true })
    .click();
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "compact-menu.png"),
  });
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#pane").evaluate((e) => e.inert), false);
  results.push("Compact menu, Escape and inert work pane");
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.getByLabel("Page name", { exact: true }).fill("Folders");
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "page-search.png"),
  });
  await page.mouse.click(2, 2);
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  assert.equal(
    await page
      .getByRole("button", { name: "Find a page", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  results.push("Search dismisses on outside click and restores focus");
  await page.getByRole("button", { name: "Find a page", exact: true }).click();
  await page.getByLabel("Page name", { exact: true }).fill("Updates");
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Updates", exact: true })
    .click();
  await page.getByRole("heading", { name: "Updates", level: 1 }).waitFor();
  assert.equal(await page.locator("#dialog").evaluate((e) => e.open), false);
  results.push("Search selection dismisses and navigates");
  for (const [screen, sub] of [
    ["settings", "general"],
    ["settings", "folders"],
    ["settings", "mac"],
    ["settings", "connection"],
    ["settings", "model"],
    ["settings", "shortcuts"],
    ["settings", "updates"],
    ["settings", "diagnostics"],
    ["setup", "overview"],
    ["setup", "signin"],
    ["setup", "folders"],
    ["setup", "connection"],
    ["setup", "add"],
  ]) {
    await page.goto(base + "?present=1&page=" + screen + "&sub=" + sub);
    assert.equal(await page.locator(".content h1").count(), 1);
  }
  results.push("All configuration and setup pages render");
  await scene("narrow-home", "theme=light&page=home", 500, 720);
  await scene("narrow-chat", "theme=dark&page=chat", 500, 720);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(path.join(root, "brand.html")).href);
  assert.equal(await page.locator("article").count(), 3);
  await page.screenshot({
    path: path.join(root, "screenshots-v2", "brand-study.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cobalt", exact: true }).click();
  assert.match(
    await page.locator("a.choice-link").nth(1).getAttribute("href"),
    /accent=cobalt/,
  );
  await page.locator("a.choice-link").nth(1).click();
  assert.match(await page.locator("#rail .rail-brand").innerHTML(), /svg/);
  results.push(
    "Brand vector concepts, small sizes, monochrome and interface preview",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "inspection-v2.json"),
    JSON.stringify(
      {
        mode: "headless Chromium, disposable context, local files only, no external requests",
        limits:
          "DOM and SVG evidence only; no native Electron, live ChatGPT, scheduler or persistent history evidence",
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
