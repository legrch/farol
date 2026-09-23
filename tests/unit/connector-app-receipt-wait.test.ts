import { describe, expect, it, vi } from "vitest";
import {
  readPendingConnectorReceipt,
  waitForConnectorAppReceipt,
} from "../../src/apps/desktop/connector-app-receipt-wait";

describe("one-click connector verification receipt", () => {
  it("continues after observing a file before its JSON write completes", async () => {
    let elapsed = 0;
    const readback = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("CONNECTOR_VERIFICATION_RECEIPT_INVALID"),
      )
      .mockResolvedValueOnce({ challenge: "current" });
    const result = await waitForConnectorAppReceipt<{ challenge: string }>(
      () => readPendingConnectorReceipt(readback),
      (receipt) => receipt.challenge === "current",
      {
        timeoutMs: 3_000,
        intervalMs: 1_000,
        now: () => elapsed,
        pause: async (ms) => {
          elapsed += ms;
        },
      },
    );
    expect(result).toEqual({ challenge: "current" });
    expect(readback).toHaveBeenCalledTimes(2);
  });

  it("does not hide an unsafe receipt file", async () => {
    await expect(
      readPendingConnectorReceipt(async () => {
        throw new Error("CONNECTOR_VERIFICATION_RECEIPT_UNSAFE");
      }),
    ).rejects.toThrow("CONNECTOR_VERIFICATION_RECEIPT_UNSAFE");
  });

  it("waits for the existing local receipt without dispatching another message", async () => {
    let elapsed = 0;
    const readback = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ challenge: "old" })
      .mockResolvedValueOnce({ challenge: "current" });
    const result = await waitForConnectorAppReceipt<{ challenge: string }>(
      readback,
      (receipt) => receipt.challenge === "current",
      {
        timeoutMs: 3_000,
        intervalMs: 1_000,
        now: () => elapsed,
        pause: async (ms) => {
          elapsed += ms;
        },
      },
    );
    expect(result).toEqual({ challenge: "current" });
    expect(readback).toHaveBeenCalledTimes(3);
    expect(elapsed).toBe(2_000);
  });

  it("stops at the bound and preserves a missing receipt as unconfirmed", async () => {
    let elapsed = 0;
    const readback = vi.fn(async () => null);
    const result = await waitForConnectorAppReceipt(readback, () => true, {
      timeoutMs: 2_500,
      intervalMs: 1_000,
      now: () => elapsed,
      pause: async (ms) => {
        elapsed += ms;
      },
    });
    expect(result).toBeNull();
    expect(readback).toHaveBeenCalledTimes(3);
    expect(elapsed).toBe(2_500);
  });

  it("bounds a stalled read-only probe without starting another read", async () => {
    const readback = vi.fn(() => new Promise<never>(() => {}));
    expect(
      await waitForConnectorAppReceipt(readback, () => true, {
        timeoutMs: 30,
      }),
    ).toBeNull();
    expect(readback).toHaveBeenCalledTimes(1);
  });
});
