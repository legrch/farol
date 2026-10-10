import { createRequire } from "node:module";
import { access, writeFile, readFile } from "node:fs/promises";
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
    viewport: { width: 1180, height: 760 },
    reducedMotion: "reduce",
  });
  await ctx.route(/^https?:/, (r) =>
    r.request().url().startsWith("http://127.0.0.1:54186/")
      ? r.continue()
      : (errors.push("External request " + r.request().url()), r.abort()),
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const url = (name) => pathToFileURL(path.join(root, name)).href;
  await p.goto(url("gallery.html"));
  assert.equal(await p.locator("article img").count(), 17);
  for (const im of await p.locator("article img").all()) {
    await im.scrollIntoViewIfNeeded();
    await im.evaluate((e) => e.decode());
    assert.equal(await im.evaluate((e) => e.naturalWidth > 0), true);
  }
  for (const href of await p
    .locator("a")
    .evaluateAll((es) => es.map((e) => e.getAttribute("href"))))
    await access(fileURLToPath(new URL(href, url("gallery.html"))));
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({
    path: path.join(root, "screenshots-v4/review-gallery.png"),
  });
  results.push("All 17 gallery images and linked review/archive files resolve");
  for (const name of [
    "index.html",
    "brand.html",
    "menu-bar.html",
    "v3/index.html",
    "v3/brand.html",
    "v3/menu-bar.html",
    "v3/gallery.html",
  ]) {
    await p.goto(url(name));
    for (const ref of await p
      .locator("a[href],script[src],link[href],img[src]")
      .evaluateAll((es) =>
        es
          .map((e) => e.getAttribute("href") || e.getAttribute("src"))
          .filter(Boolean),
      )) {
      if (/^https?:|^data:/.test(ref)) continue;
      await access(fileURLToPath(new URL(ref, url(name))));
    }
  }
  results.push(
    "Current and revision-3 source, assets and archive navigation links resolve",
  );
  await p.goto(
    "http://127.0.0.1:54186/index.html?revision=4&present=1&theme=light&page=settings&sub=updates&update=available&auto=off&version=0.4.0",
  );
  await p
    .getByRole("switch", { name: "Automatic updates", exact: true })
    .click();
  await p.waitForFunction(() => demoUpdate.phase === "ready");
  await p.reload();
  assert.equal(
    await p.evaluate(() => demoUpdate.automatic),
    false,
    "explicit auto=off must override stored choice",
  );
  await p.goto(
    "http://127.0.0.1:54186/index.html?present=1&state=working&update=available&version=0.4.1",
  );
  await p.waitForFunction(() => demoUpdate.phase === "ready");
  assert.equal(await p.evaluate(() => demoUpdate.automatic), true);
  assert.equal(await p.locator("#dialog").evaluate((e) => e.open), false);
  results.push(
    "Existing loopback server serves revision 4; saved preference works on its actual browser origin; explicit review override is scoped to its URL",
  );
  await p.goto(url("index.html") + "?present=1&theme=light&state=ready");
  assert.equal(
    await p
      .locator(".health")
      .getByText("1 need a check", { exact: true })
      .count(),
    1,
  );
  assert.match(
    await p
      .locator(".health")
      .getByText("1 need a check", { exact: true })
      .getAttribute("class"),
    /attention/,
  );
  await p.screenshot({
    path: path.join(root, "screenshots-v4/home-ready.png"),
  });
  results.push(
    "Unchecked optional folder uses an attention label, separate from connection Ready",
  );
  await p.goto(
    url("index.html") + "?present=1&theme=dark&page=settings&sub=folders",
  );
  await p.getByText("More access options", { exact: true }).click();
  await p.locator(".content").evaluate((e) => (e.scrollTop = 130));
  const scrolling = await p.locator(".content").evaluate((e) => ({
    width: getComputedStyle(e).scrollbarWidth,
    gutter: getComputedStyle(e).scrollbarGutter,
    color: getComputedStyle(e).scrollbarColor,
    scrollable: e.scrollHeight > e.clientHeight,
  }));
  assert.equal(scrolling.width, "thin");
  assert.equal(scrolling.gutter, "stable");
  assert.notEqual(scrolling.color, "auto");
  assert.equal(scrolling.scrollable, true);
  await p.screenshot({
    path: path.join(root, "screenshots-v4/folders-scroll.png"),
  });
  results.push(
    "Expanded folder details scroll with a valid themed thumb color and stable thin gutter",
  );
  await p.setViewportSize({ width: 500, height: 820 });
  await p.goto(url("brand.html"));
  for (const im of await p.locator("img").all())
    await im.evaluate((e) => e.decode());
  await p.locator(".dock").scrollIntoViewIfNeeded();
  await p.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  assert.equal(await p.locator(".dock").isVisible(), true);
  await p.screenshot({
    path: path.join(root, "screenshots-v4/compact-dock.png"),
  });
  results.push(
    "Compact Dock layer visibly rendered after decode and settled frames",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "inspection-v4-final.json"),
    JSON.stringify(
      {
        mode: "Headless Chromium, temporary context; local files and existing loopback server only; no production mutation",
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
