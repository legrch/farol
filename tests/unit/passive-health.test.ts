import { expect, it, vi } from "vitest";
import { passiveHealthObserver } from "../../apps/desktop/operations/passive-health";
import type { OperationsRecorder } from "../../apps/desktop/renderer/operations-contract";

it("records only passive failure and recovery transitions without changing checks", async () => {
  const record = vi.fn();
  const observe = passiveHealthObserver(
    { record } as unknown as OperationsRecorder,
    () => 10,
  );
  const owner = {};
  const check = vi.fn(async () => true);
  for (let i = 0; i < 3000; i++)
    expect(await observe(owner, check, () => true)).toBe(true);
  expect(check).toHaveBeenCalledTimes(3000);
  expect(record).not.toHaveBeenCalled();
  await observe(
    owner,
    async () => false,
    () => true,
  );
  await observe(
    owner,
    async () => false,
    () => true,
  );
  await observe(
    owner,
    async () => true,
    () => true,
  );
  expect(record.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ["failed", "CONNECTION_HEALTH_FAILED"],
    ["done", null],
  ]);
});

it("preserves original errors and suppresses stale observations", async () => {
  const record = vi.fn();
  const observe = passiveHealthObserver({
    record,
  } as unknown as OperationsRecorder);
  const owner = {},
    original = Error("original");
  await expect(
    observe(
      owner,
      async () => {
        throw original;
      },
      () => false,
    ),
  ).rejects.toBe(original);
  expect(record).not.toHaveBeenCalled();
  await expect(
    observe(
      owner,
      async () => {
        throw original;
      },
      () => true,
    ),
  ).rejects.toBe(original);
  expect(record).toHaveBeenCalledTimes(1);
});
