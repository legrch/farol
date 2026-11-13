import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
const { startupSplashHtml } =
  await import("../../src/apps/desktop/startup-splash");

it("renders a static, script-free startup page with the brand mark", () => {
  const html = startupSplashHtml("Farol", "data:image/png;base64,AAAA");
  expect(html).toContain("Starting Farol…");
  expect(html).toContain('src="data:image/png;base64,AAAA"');
  expect(html).toContain("default-src 'none'");
  expect(html).not.toMatch(/<script/iu);
});

it("escapes the title and drops a non-PNG icon", () => {
  const html = startupSplashHtml('<b>"x"</b>', 'javascript:alert(1)"');
  expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
});
