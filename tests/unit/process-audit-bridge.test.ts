import { expect, it, vi } from "vitest";
import { ProcessAuditBridge } from "../../apps/desktop/bridge/process-audit";

const reference = {
  operationId: "process-1",
  buildId: "build-1",
  runtimeId: "runtime-1",
};
const fact = {
  ...reference,
  exitCode: 0,
  exitSignal: 0,
  rootWaited: true,
  outputDrained: true,
  groupCleanup: "confirmed",
  descendantCleanup: "unverified",
  timedOut: false,
  authorityLost: false,
};

it("observes only the selected original terminal facts", async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ status: "ok", data: { state: "observed", fact } });
  const bridge = new ProcessAuditBridge({ request });
  expect(await bridge.read(reference)).toEqual(fact);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.process.audit",
    reference,
  );
});

it.each([
  { state: "observed", fact: { ...fact, runtimeId: "other" } },
  { state: "observed", fact: { ...fact, rootWaited: false } },
  { state: "observed", fact: { ...fact, groupCleanup: "pending" } },
  { state: "observed", fact: { ...fact, exitCode: 0, exitSignal: 9 } },
  { state: "not_observed", fact },
  { state: "observed", fact: { ...fact, stdout: "PRIVATE" } },
])("refuses crossed, incomplete or unbounded observation %#", async (data) => {
  const bridge = new ProcessAuditBridge({
    request: vi.fn().mockResolvedValue({ status: "ok", data }),
  });
  await expect(bridge.read(reference)).rejects.toMatchObject({
    state: "unknown",
  });
});

it("does not promote an absent observation into an operation outcome", async () => {
  const bridge = new ProcessAuditBridge({
    request: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: { state: "not_observed" } }),
  });
  expect(await bridge.read(reference)).toBeNull();
});
