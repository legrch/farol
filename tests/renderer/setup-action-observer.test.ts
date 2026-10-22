import { describe, expect, it, vi } from "vitest";

const helper = "../e2e/current-react-setup.mjs";
const { setupAction } = await import(helper);

// Source-only retirement proof: the removed journeys fail before page access.
// The current native replacement remains not run by this test.
describe("retired Setup action observer journeys", () => {
  it.each([
    [
      "Verify workspace",
      "The workspace-detail verification receipt was replaced by row-level Check access and Works status.",
    ],
    [
      "Add workspace…",
      "The workspace-detail approval/receipt form was replaced by workspace rows and + Add workspace.",
    ],
  ])("retires %s before accessing the page", async (name, reason) => {
    const access = vi.fn((property: string) => {
      throw new Error(`Unexpected page access: ${property}`);
    });
    const page = new Proxy(
      {},
      {
        get(_target, property) {
          return access(String(property));
        },
      },
    );

    await expect(setupAction(page, name)).rejects.toThrow(
      `E2E_JOURNEY_RETIRED:${name}: ${reason}`,
    );
    expect(access).not.toHaveBeenCalled();
  });
});
