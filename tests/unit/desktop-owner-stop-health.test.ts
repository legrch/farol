import { expect, it, vi } from "vitest";
import { ConnectorHostBridge } from "../../apps/desktop/bridge/connector-host";
import type {
  ComputerConnectorHealthState,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire";

// Protocol doubles only. No real endpoint, native drain or installed acceptance.
const context = { profileId: "profile", backendGeneration: "backend" };
const binding = {
  ...context,
  buildId: "build",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const input = {
  publication: {
    fence: "1",
    storeRevision: "1",
    settingsRevision: "1",
    generation: "1",
    approvalDigest: "a".repeat(64),
    publishOperationId: "publish",
  },
  runtimeId: "runtime",
  connectorGeneration: "1",
  launchDigest: "b".repeat(64),
};
const stopped = (): ComputerConnectorHealthState => ({
  binding,
  expectedInstanceId: "runtime",
  state: "stopped",
  reason: "owner_stopped",
  localReady: false,
  observedAtMillis: "200000",
  validUntilMillis: "245000",
});
function deferred() {
  let resolve!: (value: Outcome) => void;
  const promise = new Promise<Outcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(recovery: string | null = "settled") {
  const request = vi.fn(
    async (
      method: string,
      body: Json,
      options: { id?: string; operationId?: string } = {},
    ): Promise<Outcome> => {
      const b = body as unknown as { runtimeId?: string };
      return {
        requestId: options.id!,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        context,
        status: "ok",
        data: method.endsWith("open")
          ? {
              endpoint: {
                binding: { ...binding, runtimeId: b.runtimeId! },
                socketPath: "/private/tmp/fixture.sock",
                token: "c".repeat(64),
              },
              execution: {
                ownerId: "owner",
                sessionId: "session",
                taskId: "scope",
                taskEpoch: "1",
                participantId: "participant",
                turnId: "turn",
                generation: "1",
              },
              admissionOperationId: options.operationId!,
            }
          : method.endsWith("close")
            ? { binding, closed: true, ...(recovery ? { recovery } : {}) }
            : (stopped() as unknown as Json),
      };
    },
  );
  return {
    request,
    host: new ConnectorHostBridge({ request }, context, "build"),
  };
}
it("observes only the acknowledged original owner stop through a read-only Go request", async () => {
  const { host, request } = fixture();
  await host.open(input);
  expect(host.ownerStoppedReceipt).toBeUndefined();
  await host.close("owner_stop");
  const original = host.ownerStoppedReceipt!;
  expect(original.reason).toBe("owner_stop");
  expect(Object.isFrozen(original)).toBe(true);
  const result = await host.observeOwnerStoppedHealth(original);
  expect(result).toEqual(stopped());
  expect(Object.isFrozen(result.binding)).toBe(true);
  expect(host.currentBinding).toBeUndefined();
  expect(request.mock.calls[1]![1]).toEqual({ binding, reason: "owner_stop" });
  expect(request.mock.calls[2]![0]).toBe("computer.connector.health");
  expect(request.mock.calls[2]![1]).toEqual({
    binding,
    expectedInstanceId: "runtime",
  });
  expect(request.mock.calls[2]![2]).not.toHaveProperty("operationId");
  expect(host.closureReceipt).toBe(original);
  const count = request.mock.calls.length;
  await expect(
    host.observeOwnerStoppedHealth({ ...original }),
  ).rejects.toMatchObject({ code: "connector_health_unavailable" });
  expect(request).toHaveBeenCalledTimes(count);
});
it.each([
  null,
  "pending_operation",
  "operation_unknown",
  "authority_unknown",
  "unavailable",
])("does not infer a stop from unsettled Close %s", async (recovery) => {
  const { host } = fixture(recovery);
  await host.open(input);
  await host.close("owner_stop");
  expect(host.ownerStoppedReceipt).toBeUndefined();
  expect(host.currentBinding).toBeUndefined();
});
it("never upgrades a generic close or no-op to owner stop", async () => {
  const { host, request } = fixture();
  await host.open(input);
  const pending = deferred();
  const originalRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, body, options) =>
    method.endsWith("close")
      ? pending.promise
      : originalRequest(method, body, options),
  );
  const closing = host.close();
  const joined = host.close("owner_stop");
  expect(joined).toBe(closing);
  const [, , options] = request.mock.calls.at(-1)!;
  pending.resolve({
    requestId: options!.id!,
    operationId: options!.operationId!,
    context,
    status: "ok",
    data: { binding, closed: true, recovery: "settled" },
  });
  await closing;
  await host.close("owner_stop");
  expect(host.closureReceipt?.reason).toBeUndefined();
  expect(host.ownerStoppedReceipt).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});
it("keeps a failed original close unknown", async () => {
  const { host, request } = fixture();
  await host.open(input);
  request.mockRejectedValueOnce(new Error("lost reply"));
  await expect(host.close("owner_stop")).rejects.toMatchObject({
    code: "connector_close_unconfirmed",
  });
  expect(host.ownerStoppedReceipt).toBeUndefined();
  expect(host.closureReceipt).toBeUndefined();
  await expect(host.close("owner_stop")).rejects.toMatchObject({
    code: "connector_close_unconfirmed",
  });
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([
  ["positive state", { state: "recent_transport" }],
  ["reason", { reason: "recent_poll_success" }],
  ["ready", { localReady: true }],
  ["poll", { lastPollSuccessMillis: "199000" }],
  ["upload", { lastResponseAcceptedMillis: "199000" }],
  ["retry", { nextRetryMillis: "201000" }],
  ["sample", { sampleAtMillis: "200000" }],
  ["missing time", { observedAtMillis: undefined }],
  ["missing deadline", { validUntilMillis: undefined }],
  ["instance", { expectedInstanceId: "foreign" }],
  ["binding", { binding: { ...binding, backendGeneration: "foreign" } }],
] as const)(
  "refuses contradictory or crossed retired health: %s",
  async (_name, change) => {
    const { host, request } = fixture();
    await host.open(input);
    await host.close("owner_stop");
    const receipt = host.ownerStoppedReceipt!;
    request.mockImplementationOnce(async (_m, _b, o) => ({
      requestId: o!.id!,
      context,
      status: "ok",
      data: { ...stopped(), ...change } as unknown as Json,
    }));
    await expect(host.observeOwnerStoppedHealth(receipt)).rejects.toMatchObject(
      { state: "unknown" },
    );
    expect(host.currentBinding).toBeUndefined();
    expect(host.ownerStoppedReceipt).toBe(receipt);
  },
);
it.each(["request", "operation", "context"] as const)(
  "refuses crossed negative outcome %s",
  async (mode) => {
    const { host, request } = fixture();
    await host.open(input);
    await host.close("owner_stop");
    const receipt = host.ownerStoppedReceipt!;
    request.mockImplementationOnce(async (_m, _b, o) => ({
      requestId: mode === "request" ? "foreign" : o!.id!,
      ...(mode === "operation" ? { operationId: "effect" } : {}),
      context:
        mode === "context" ? { ...context, profileId: "foreign" } : context,
      status: "ok",
      data: stopped() as unknown as Json,
    }));
    await expect(host.observeOwnerStoppedHealth(receipt)).rejects.toMatchObject(
      { code: "crossed_connector_health" },
    );
  },
);
it.each(["known-open", "failed-open"] as const)(
  "a late stopped read cannot survive %s",
  async (mode) => {
    const { host, request } = fixture();
    await host.open(input);
    await host.close("owner_stop");
    const receipt = host.ownerStoppedReceipt!;
    const late = deferred();
    request.mockImplementationOnce(async () => late.promise);
    const reading = host.observeOwnerStoppedHealth(receipt);
    const readOptions = request.mock.calls.at(-1)![2]!;
    if (mode === "failed-open")
      request.mockRejectedValueOnce(new Error("lost open"));
    const opening = host.open({ ...input, runtimeId: "replacement" });
    expect(host.ownerStoppedReceipt).toBeUndefined();
    if (mode === "failed-open")
      await expect(opening).rejects.toMatchObject({ outcome: "unknown" });
    else await opening;
    late.resolve({
      requestId: readOptions.id!,
      context,
      status: "ok",
      data: stopped() as unknown as Json,
    });
    await expect(reading).rejects.toMatchObject({
      code: "connector_health_unavailable",
    });
    expect(host.ownerStoppedReceipt).toBeUndefined();
    expect(host.closureReceipt).toBe(receipt);
  },
);
