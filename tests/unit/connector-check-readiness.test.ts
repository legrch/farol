import { expect, it, vi } from "vitest";
import { waitForConnectorCheckReadiness } from "../../apps/desktop/bridge/connector-check-readiness";
import type { ChatGptSignInStatusObservation } from "../../src/apps/desktop/chatgpt-route";

it("waits through initial page hydration without sending or reopening", async () => {
  let now = 0;
  const authenticated: ChatGptSignInStatusObservation = {
    state: "authenticated",
    binding: { sequence: 3, documentGeneration: 1 },
  };
  const route = {
    open: vi.fn(async () => ({ status: "opened" as const })),
    observeSignInStatus: vi
      .fn<() => Promise<ChatGptSignInStatusObservation>>()
      .mockResolvedValueOnce({ state: "unknown", binding: null })
      .mockResolvedValue(authenticated),
    isCurrentSignInStatus: (v: ChatGptSignInStatusObservation) =>
      v === authenticated,
  };
  expect(
    await waitForConnectorCheckReadiness(route, () => true, {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      timeoutMs: 1000,
    }),
  ).toBe(true);
  expect(route.open).toHaveBeenCalledTimes(1);
  expect(route.observeSignInStatus).toHaveBeenCalledTimes(2);
});

it("stops after its original readiness budget or lifetime invalidation", async () => {
  let now = 0;
  const route = {
    open: async () => ({ status: "opened" as const }),
    observeSignInStatus: vi.fn(async () => ({
      state: "unknown" as const,
      binding: null,
    })),
    isCurrentSignInStatus: () => false,
  };
  const timing = {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
    timeoutMs: 300,
  };
  expect(await waitForConnectorCheckReadiness(route, () => true, timing)).toBe(
    false,
  );
  expect(route.observeSignInStatus).toHaveBeenCalledTimes(2);
  route.observeSignInStatus.mockClear();
  expect(await waitForConnectorCheckReadiness(route, () => false, timing)).toBe(
    false,
  );
  expect(route.observeSignInStatus).not.toHaveBeenCalled();
});
