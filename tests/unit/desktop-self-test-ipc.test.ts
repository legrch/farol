import { expect, it, vi } from "vitest";
import { runSelfTestCommand } from "../../apps/desktop/self-test-ipc";
import type { DesktopGoCore } from "../../apps/desktop/go-core-host";
import { SelfTestResponseSchema } from "../../apps/desktop/renderer/self-test-contract";

const selection = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "work",
  computerGeneration: "1",
  planVersion: "2" as const,
};
function fixture() {
  const host = {
    selfTestHistory: vi.fn(async () => ({
      markers: [],
      records: [],
      unresolved: [],
      pending: undefined,
    })),
    startSelfTest: vi.fn(async () => ({
      selection,
      state: "unknown" as const,
    })),
    observeSelfTest: vi.fn(async () => ({
      selection,
      state: "unknown" as const,
    })),
    pendingSelfTest: vi.fn(() => selection),
  };
  return { host, selected: host as unknown as DesktopGoCore };
}

it("rejects malformed or crossed selections without touching the core", async () => {
  const f = fixture();
  for (const value of [
    { kind: "start", workspaceId: "work", extra: true },
    { kind: "observe", workspaceId: "other", selection },
    {
      kind: "observe",
      workspaceId: "work",
      selection: { ...selection, operationId: "bad" },
    },
    {
      kind: "observe",
      workspaceId: "work",
      selection: { ...selection, computerGeneration: "bad" },
    },
  ]) {
    expect(
      await runSelfTestCommand(
        () => f.selected,
        () => true,
        value,
      ),
    ).toEqual({ ok: false, code: "SELF_TEST_INVALID_REQUEST" });
  }
  expect(f.host.startSelfTest).not.toHaveBeenCalled();
  expect(f.host.observeSelfTest).not.toHaveBeenCalled();
});

it("returns the original unknown identity and never retries the start", async () => {
  const f = fixture();
  const result = await runSelfTestCommand(
    () => f.selected,
    () => true,
    { kind: "start", workspaceId: "work" },
  );
  expect(SelfTestResponseSchema.safeParse(result).success).toBe(true);
  expect(result).toEqual({
    ok: true,
    kind: "start",
    observation: { selection, state: "unknown" },
  });
  expect(f.host.startSelfTest).toHaveBeenCalledTimes(1);
});

it("withholds a known report if the owning core changes during the call", async () => {
  const f = fixture();
  let current: DesktopGoCore | null = f.selected;
  f.host.startSelfTest.mockImplementationOnce(async () => {
    current = null;
    return { selection, state: "unknown" };
  });
  expect(
    await runSelfTestCommand(
      () => current,
      () => true,
      { kind: "start", workspaceId: "work" },
    ),
  ).toEqual({
    ok: true,
    kind: "start",
    observation: { selection, state: "unknown" },
  });
  expect(f.host.startSelfTest).toHaveBeenCalledTimes(1);
});

it("preserves a retained identity if a start unexpectedly rejects", async () => {
  const f = fixture();
  f.host.startSelfTest.mockRejectedValueOnce(new Error("lost"));
  expect(
    await runSelfTestCommand(
      () => f.selected,
      () => true,
      { kind: "start", workspaceId: "work" },
    ),
  ).toEqual({ ok: false, code: "SELF_TEST_START_UNCONFIRMED", selection });
  expect(f.host.startSelfTest).toHaveBeenCalledTimes(1);
});

it("does not turn unavailable history into an empty result", async () => {
  const f = fixture();
  f.host.selfTestHistory.mockRejectedValueOnce(new Error("unavailable"));
  expect(
    await runSelfTestCommand(
      () => f.selected,
      () => true,
      { kind: "history", workspaceId: "work" },
    ),
  ).toEqual({ ok: false, code: "SELF_TEST_UNAVAILABLE" });
});

it("does not start while application admission is closed", async () => {
  const f = fixture();
  expect(
    await runSelfTestCommand(
      () => f.selected,
      () => false,
      { kind: "start", workspaceId: "work" },
    ),
  ).toEqual({ ok: false, code: "SELF_TEST_UNAVAILABLE" });
  expect(f.host.startSelfTest).not.toHaveBeenCalled();
});

it("retains the original identity when observation becomes unavailable", async () => {
  const f = fixture();
  f.host.observeSelfTest.mockRejectedValueOnce(new Error("disconnected"));
  expect(
    await runSelfTestCommand(
      () => f.selected,
      () => true,
      { kind: "observe", workspaceId: "work", selection },
    ),
  ).toEqual({
    ok: true,
    kind: "observe",
    observation: { selection, state: "unknown" },
  });
  expect(f.host.observeSelfTest).toHaveBeenCalledTimes(1);
});
