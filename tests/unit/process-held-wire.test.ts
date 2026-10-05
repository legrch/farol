import { expect, it } from "vitest";
import {
  knownMethod,
  requiresOperationID,
  validate,
  type ComputerHeldBarrier,
} from "../../apps/desktop/bridge/wire.ts";

// Generated schema only; no native role, process or provider is started.
const barrier: ComputerHeldBarrier = {
  identity: {
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    operationId: "operation",
    sealSha256: "a".repeat(64),
    anchorLifetimeId: "anchor",
    childLaunchId: "held",
    deadline: "2026-10-05T19:00:00.123456789Z",
  },
  barrier: 1,
};

it.each([0, 1, 2, 3, -1, 1.5, 4294967296])(
  "bounds the live held barrier at %s",
  (value) => {
    expect(
      validate("ComputerHeldBarrier", { ...barrier, barrier: value }),
    ).toBe(value === 1 || value === 2);
  },
);

it.each(Object.keys(barrier.identity))(
  "requires the exact held identity field %s",
  (field) => {
    const identity: Record<string, unknown> = { ...barrier.identity };
    delete identity[field];
    expect(validate("ComputerHeldBarrier", { ...barrier, identity })).toBe(
      false,
    );
  },
);

it("keeps held identity closed and release effect-classified", () => {
  expect(validate("ComputerHeldBarrier", barrier)).toBe(true);
  expect(validate("ComputerHeldBarrier", { ...barrier, release: true })).toBe(
    false,
  );
  for (const identity of [
    { ...barrier.identity, authority: "invented" },
    { ...barrier.identity, sealSha256: "A".repeat(64) },
    { ...barrier.identity, deadline: "2026-10-05T19:00:00+00:00" },
  ]) {
    expect(validate("ComputerHeldBarrier", { ...barrier, identity })).toBe(
      false,
    );
  }
  expect(knownMethod("computer.process.held.ready")).toBe(true);
  expect(requiresOperationID("computer.process.held.ready")).toBe(false);
  expect(requiresOperationID("computer.process.held.release")).toBe(true);
  expect(knownMethod("computer.process.held.exec")).toBe(false);
});
