import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

// DOM and source-helper fixtures only; never launch a native journey.
const {
  waitForReactShell,
  assertSetupOverviewEvidence,
  assertSetupOverview,
  reviewSetupWithoutChanges,
} = await import(
  new URL("../e2e/current-react-setup.mjs", import.meta.url).href
);
describe("retired Setup checklist journeys", () => {
  it("explicitly retires the removed optional-sign-in overview evidence", () => {
    expect(() => assertSetupOverviewEvidence()).toThrow(
      /E2E_JOURNEY_RETIRED:setup-overview-evidence:.*required linear steps/u,
    );
  });
  it("refuses the removed overview and retained-action review before touching a page", async () => {
    await expect(assertSetupOverview()).rejects.toThrow(
      /E2E_JOURNEY_RETIRED:setup-overview:/u,
    );
    await expect(reviewSetupWithoutChanges()).rejects.toThrow(
      /E2E_JOURNEY_RETIRED:review-setup-retained-actions:/u,
    );
  });
});

describe("current shell readiness", () => {
  it.each([
    ['<nav aria-label="Sections"></nav><main class="stage">Home</main>', true],
    [
      '<main class="stage"><div class="setup-page">Welcome to Farol</div></main>',
      true,
    ],
    ['<main class="stage">Connecting to Farol…</main>', false],
    ['<main class="stage">Incompatible build</main>', false],
  ])(
    "recognizes the rendered shell without requiring the rail: %s",
    async (html, ready) => {
      const dom = new JSDOM(html as string);
      vi.stubGlobal("document", dom.window.document);
      let observed;
      const page = {
        locator: vi.fn(() => ({ waitFor: vi.fn(async () => undefined) })),
        waitForFunction: vi.fn(async (read: () => boolean) => {
          observed = read();
        }),
      };
      try {
        await waitForReactShell(page);
        expect(page.locator).toHaveBeenCalledWith(".toolbar-title strong");
        expect(observed).toBe(ready);
      } finally {
        vi.unstubAllGlobals();
        dom.window.close();
      }
    },
  );
});
