import { afterEach, expect, it, vi } from "vitest";
import { startChatGptFixture, stopChatGptFixture } from "./chatgpt-site.mjs";
// Loopback provider-double contract only; no native product or Go receipt.
const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await stopChatGptFixture(f);
});
it.each([true, false])(
  "waits for the external fixture verifier and reflects its actual result (%s)",
  async (ok) => {
    const verify = vi.fn(async (prompt) => {
      expect(prompt).toBe("synthetic prompt");
      if (!ok) throw Error("synthetic refusal");
    });
    const f = await startChatGptFixture({
      setupVerification: { appName: "Farol Dev", verify },
    });
    fixtures.push(f);
    const html = await (await fetch(f.url)).text();
    expect(html).toContain('aria-label="Select ChatGPT model"');
    expect(html).toContain('data-app-name="Farol Dev"');
    const endpoint = new URL("/setup-verify", f.url);
    expect((await fetch(endpoint)).status).toBe(405);
    expect(verify).not.toHaveBeenCalled();
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "synthetic prompt" }),
    });
    expect(result.status).toBe(ok ? 200 : 409);
    expect(await result.json()).toEqual({ verified: ok });
    expect(verify).toHaveBeenCalledTimes(1);
  },
);
it("keeps default readiness fixtures free of Setup model/app controls", async () => {
  const f = await startChatGptFixture();
  fixtures.push(f);
  const html = await (await fetch(f.url)).text();
  expect(html).not.toContain('id="setup-model-power"');
  expect(html).not.toContain('data-testid="composer-app-chip"');
});
