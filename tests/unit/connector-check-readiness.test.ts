import { expect, it, vi } from "vitest";
import {
  waitForConnectorCheckReadiness,
  prepareConnectorCheckDocument,
} from "../../apps/desktop/bridge/connector-check-readiness";
import type { ChatGptSignInStatusObservation } from "../../src/apps/desktop/chatgpt-route";

it("waits through initial page hydration without sending or reopening", async () => {
  let now = 0;
  const authenticated: ChatGptSignInStatusObservation = {
    state: "authenticated",
    binding: { sequence: 3, documentGeneration: 1 },
  };
  const route = {
    hasPendingReadinessDocument: () => false,
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
    hasPendingReadinessDocument: () => false,
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

it("joins retained loading and negative hydration within one preflight", async () => {
  let now = 0,
    stage = 0;
  const positive: ChatGptSignInStatusObservation = {
    state: "authenticated",
    binding: { sequence: 2, documentGeneration: 2 },
  };
  const fresh: ChatGptSignInStatusObservation = {
    state: "authenticated",
    binding: { sequence: 4, documentGeneration: 3 },
  };
  const route = {
    open: vi
      .fn()
      .mockResolvedValueOnce({ status: "unreachable" })
      .mockResolvedValue({ status: "opened" }),
    hasPendingReadinessDocument: () => true,
    observeSignInStatus: vi
      .fn()
      .mockResolvedValueOnce({ state: "unknown", binding: null })
      .mockResolvedValueOnce(positive)
      .mockResolvedValueOnce({
        state: "signed_out",
        binding: { sequence: 5, documentGeneration: 3 },
      })
      .mockResolvedValue(fresh),
    isCurrentSignInStatus: (v: ChatGptSignInStatusObservation) =>
      v === (stage === 0 ? positive : fresh),
    openTemporaryChat: vi.fn(async () => {
      stage++;
      return { status: "opened" as const };
    }),
  };
  expect(
    await prepareConnectorCheckDocument(route, () => true, {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      timeoutMs: 1000,
    }),
  ).toEqual({ ready: true });
  expect(route.openTemporaryChat).toHaveBeenCalledOnce();
  expect(stage).toBe(1);
  expect(route.open).toHaveBeenCalledTimes(2);
  expect(route.observeSignInStatus).toHaveBeenCalledTimes(4);
});

it.each([
  "permanent-negative",
  "expired-after-navigation",
  "invalidated",
  "protected-opener",
])("refuses %s without another temporary navigation", async (scenario) => {
  let now = 0,
    live = true;
  const positive: ChatGptSignInStatusObservation = {
    state: "authenticated",
    binding: { sequence: 1, documentGeneration: 1 },
  };
  const route = {
    open: vi.fn(async () => ({
      status:
        scenario === "protected-opener"
          ? ("unreachable" as const)
          : ("opened" as const),
    })),
    hasPendingReadinessDocument: () => false,
    observeSignInStatus: vi.fn(async () =>
      scenario === "permanent-negative"
        ? { state: "signed_out" as const, binding: null }
        : positive,
    ),
    isCurrentSignInStatus: (v: ChatGptSignInStatusObservation) =>
      v === positive,
    openTemporaryChat: vi.fn(async () => {
      if (scenario === "expired-after-navigation") now = 1000;
      if (scenario === "invalidated") live = false;
      return { status: "opened" as const };
    }),
  };
  expect(
    (
      await prepareConnectorCheckDocument(route, () => live, {
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
        timeoutMs: 300,
      })
    ).ready,
  ).toBe(false);
  expect(route.openTemporaryChat).toHaveBeenCalledTimes(
    ["permanent-negative", "protected-opener"].includes(scenario) ? 0 : 1,
  );
});
