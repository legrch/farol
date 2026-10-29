import { expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client";
import {
  ConnectorHostBridge,
  ConnectorHostError,
} from "../../apps/desktop/bridge/connector-host";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";
const context = { profileId: "profile", backendGeneration: "backend" };
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
  connectorGeneration: "9007199254740993",
  launchDigest: "b".repeat(64),
};
const binding = {
  ...context,
  buildId: "build",
  runtimeId: input.runtimeId,
  connectorGeneration: input.connectorGeneration,
};
function fixture() {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string; operationId?: string } = {},
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
      data: method.endsWith("open")
        ? {
            endpoint: {
              binding,
              socketPath: "/private/tmp/fixture.sock",
              token: "c".repeat(64),
            },
            execution: {
              ownerId: "owner",
              sessionId: "session",
              taskId: "scope",
              taskEpoch: "1",
              participantId: "participant",
              turnId: "correlation",
              generation: "1",
            },
            admissionOperationId: options.operationId!,
          }
        : { binding, closed: true },
    }),
  );
  return {
    request,
    host: new ConnectorHostBridge({ request }, context, "build"),
  };
}
function deferredOutcome() {
  let resolve!: (outcome: Outcome) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Outcome>((resolveReply, rejectReply) => {
    resolve = resolveReply;
    reject = rejectReply;
  });
  return { promise, resolve, reject };
}
it("retains the exact Go reply and closes once without granting or reminting", async () => {
  const { request, host } = fixture();
  const result = await host.open(input);
  expect(result.endpoint.binding).toEqual(binding);
  expect(Object.isFrozen(result.execution)).toBe(true);
  expect(Object.isFrozen(result.endpoint.binding)).toBe(true);
  await expect(host.open(input)).rejects.toMatchObject({
    code: "connector_host_unavailable",
  });
  await host.close();
  await host.close();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.open",
    "computer.connector.close",
  ]);
});

it.each([
  undefined,
  "pending_operation",
  "operation_unknown",
  "authority_unknown",
  "unavailable",
] as const)(
  "requires a settled original close receipt before recovery: %s",
  async (recovery) => {
    const { host, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const response = await original(...args);
      return args[0].endsWith("close") && recovery !== undefined
        ? { ...response, data: { ...(response.data as object), recovery } }
        : response;
    });
    await host.open(input);
    expect(host.currentBinding).toEqual(binding);
    await host.close();
    const receipt = host.closureReceipt!;
    expect(receipt.result).toEqual({
      binding,
      closed: true,
      ...(recovery ? { recovery } : {}),
    });
    expect(receipt.requestId).toBe(request.mock.calls[1]![2]!.id);
    expect(receipt.operationId).toBe(request.mock.calls[1]![2]!.operationId);
    expect(Object.isFrozen(receipt.result.binding)).toBe(true);
    expect(host.currentBinding).toBeUndefined();
    await expect(
      host.open({ ...input, runtimeId: "successor", recoveryFrom: binding }),
    ).rejects.toMatchObject({ code: "connector_recovery_unavailable" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.closureReceipt).toBe(receipt);
  },
);

it("does not mint recovery from no close or a crossed original binding", async () => {
  const { host, request } = fixture();
  await expect(
    host.open({ ...input, recoveryFrom: binding }),
  ).rejects.toMatchObject({ code: "connector_recovery_unavailable" });
  expect(request).not.toHaveBeenCalled();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => {
    const response = await original(...args);
    return args[0].endsWith("close")
      ? {
          ...response,
          data: { ...(response.data as object), recovery: "settled" },
        }
      : response;
  });
  await host.open(input);
  await host.close();
  await expect(
    host.open({
      ...input,
      recoveryFrom: { ...binding, backendGeneration: "foreign" },
    }),
  ).rejects.toMatchObject({ code: "connector_recovery_unavailable" });
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["lost", "known"] as const)(
  "retains the original closure but never repeats a %s recovery Open",
  async (outcome) => {
    const { host, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const response = await original(...args);
      return args[0].endsWith("close")
        ? {
            ...response,
            data: { ...(response.data as object), recovery: "settled" },
          }
        : response;
    });
    await host.open(input);
    await host.close();
    const receipt = host.closureReceipt!;
    if (outcome === "lost")
      request.mockRejectedValueOnce(new Error("original successor reply lost"));
    else
      request.mockImplementationOnce(async (method, body, options) => {
        const response = await original(method, body, options);
        return {
          ...response,
          data: {
            ...(response.data as object),
            endpoint: {
              ...((response.data as Record<string, Json>).endpoint as object),
              binding: { ...binding, runtimeId: "successor" },
            },
          },
        };
      });
    const next = { ...input, runtimeId: "successor", recoveryFrom: binding };
    const started = host.open(next);
    if (outcome === "lost")
      await expect(started).rejects.toMatchObject({
        outcome: "unknown",
        method: "computer.connector.open",
      });
    else expect((await started).endpoint.binding.runtimeId).toBe("successor");
    await expect(host.open(next)).rejects.toMatchObject({
      code: "connector_host_unavailable",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(host.closureReceipt).toBe(receipt);
    expect(request.mock.calls[2]![1]).toMatchObject({ recoveryFrom: binding });
    expect(
      Object.isFrozen(
        (request.mock.calls[2]![1] as { recoveryFrom: object }).recoveryFrom,
      ),
    ).toBe(true);
  },
);
it("joins the original overlapping close until its exact ACK confirms closure", async () => {
  const { request, host } = fixture();
  const original = request.getMockImplementation()!;
  await host.open(input);
  const reply = deferredOutcome();
  request.mockReturnValueOnce(reply.promise);
  const first = host.close();
  const second = host.close();
  const completed = vi.fn();
  const results = Promise.allSettled([first, second]).then((outcomes) => {
    completed();
    return outcomes;
  });
  expect(second).toBe(first);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.open",
    "computer.connector.close",
  ]);
  await expect(host.open(input)).rejects.toMatchObject({
    state: "unavailable",
    code: "connector_host_unavailable",
  });
  reply.resolve(await original(...request.mock.calls[1]!));
  expect(await results).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ]);
  await expect(host.close()).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(["unknown", "lost"])(
  "joins the original overlapping close and retains its exact %s failure",
  async (mode) => {
    const { request, host } = fixture();
    await host.open(input);
    expect(host.availableBinding).toEqual(binding);
    const reply = deferredOutcome();
    request.mockReturnValueOnce(reply.promise);
    const first = host.close();
    expect(host.availableBinding).toBeUndefined();
    const second = host.close();
    const completed = vi.fn();
    const results = Promise.allSettled([first, second]).then((outcomes) => {
      completed();
      return outcomes;
    });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "computer.connector.open",
      "computer.connector.close",
    ]);
    const error =
      mode === "unknown"
        ? new BridgeError("unknown", "original_close_unknown")
        : new Error("lost close response");
    reply.reject(error);
    const outcomes = await results;
    expect(host.availableBinding).toBeUndefined();
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        ConnectorHostError,
      );
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        state: "unknown",
        method: "computer.connector.close",
        requestId: request.mock.calls[1]![2]!.id,
        operationId: request.mock.calls[1]![2]!.operationId,
        outcome: "unknown",
        code: "connector_close_unconfirmed",
      });
    }
    expect((outcomes[1] as PromiseRejectedResult).reason).toBe(
      (outcomes[0] as PromiseRejectedResult).reason,
    );
    await expect(host.close()).rejects.toMatchObject({
      state: "unknown",
      code: "connector_close_unconfirmed",
    });
    await expect(host.open(input)).rejects.toMatchObject({
      state: "unavailable",
      code: "connector_host_unavailable",
    });
    expect(request).toHaveBeenCalledTimes(2);
  },
);
it("refuses close while the original open is pending without sending a close request", async () => {
  const { request, host } = fixture();
  const original = request.getMockImplementation()!;
  const reply = deferredOutcome();
  request.mockReturnValueOnce(reply.promise);
  const opening = host.open(input);
  await expect(host.close()).rejects.toMatchObject({
    state: "unknown",
    code: "connector_close_unconfirmed",
  });
  expect(request).toHaveBeenCalledTimes(1);
  reply.resolve(await original(...request.mock.calls[0]!));
  await opening;
  await expect(host.close()).resolves.toBeUndefined();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.open",
    "computer.connector.close",
  ]);
});
it.each<readonly [string, (outcome: Outcome) => Outcome]>([
  ["unknown status", (out) => ({ ...out, status: "unknown" })],
  ["crossed request", (out) => ({ ...out, requestId: "crossed" })],
  ["crossed operation", (out) => ({ ...out, operationId: "crossed" })],
  [
    "crossed profile",
    (out) => ({ ...out, context: { ...context, profileId: "crossed" } }),
  ],
  [
    "crossed backend",
    (out) => ({
      ...out,
      context: { ...context, backendGeneration: "crossed" },
    }),
  ],
  ["invalid data", (out) => ({ ...out, data: {} })],
  [
    "unconfirmed closure",
    (out) => ({ ...out, data: { binding, closed: false } }),
  ],
  [
    "crossed binding",
    (out) => ({
      ...out,
      data: { binding: { ...binding, runtimeId: "crossed" }, closed: true },
    }),
  ],
])("fences overlapping close callers after %s", async (_name, change) => {
  const { request, host } = fixture();
  const original = request.getMockImplementation()!;
  await host.open(input);
  const reply = deferredOutcome();
  request.mockReturnValueOnce(reply.promise);
  const first = host.close();
  const second = host.close();
  const results = Promise.allSettled([first, second]);
  expect(second).toBe(first);
  expect(request).toHaveBeenCalledTimes(2);
  reply.resolve(change(await original(...request.mock.calls[1]!)));
  const outcomes = await results;
  expect(outcomes[0]).toMatchObject({
    status: "rejected",
    reason: {
      state: "unknown",
      outcome: "unknown",
      method: "computer.connector.close",
      requestId: request.mock.calls[1]![2]!.id,
      operationId: request.mock.calls[1]![2]!.operationId,
    },
  });
  expect(outcomes[1]).toMatchObject({ status: "rejected" });
  expect((outcomes[1] as PromiseRejectedResult).reason).toBe(
    (outcomes[0] as PromiseRejectedResult).reason,
  );
  await expect(host.close()).rejects.toMatchObject({
    state: "unknown",
    code: "connector_close_unconfirmed",
  });
  await expect(host.open(input)).rejects.toMatchObject({
    state: "unavailable",
  });
  expect(request).toHaveBeenCalledTimes(2);
});
const refusalCode = "connector_open_refused_before_publication";
function refuseOpen(
  request: ReturnType<typeof fixture>["request"],
  change: (outcome: Outcome) => unknown = (outcome) => outcome,
) {
  request.mockImplementationOnce(async (_method, _body, options = {}) => {
    return change({
      status: "refused",
      code: refusalCode,
      requestId: options.id!,
      operationId: options.operationId!,
      context,
    }) as Outcome;
  });
}
it("retains the exact pre-publication refusal and closes without another request", async () => {
  const { request, host } = fixture();
  refuseOpen(request);
  const error = await host.open(input).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConnectorHostError);
  expect(error).toMatchObject({
    state: "refused",
    code: refusalCode,
    method: "computer.connector.open",
    requestId: request.mock.calls[0]![2]!.id,
    operationId: request.mock.calls[0]![2]!.operationId,
    outcome: "known",
  });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(host.open(input)).rejects.toMatchObject({
    state: "refused",
    code: refusalCode,
  });
  await expect(host.close()).resolves.toBeUndefined();
  await expect(host.close()).resolves.toBeUndefined();
  await expect(host.open(input)).rejects.toMatchObject({
    state: "refused",
    code: refusalCode,
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.open",
  ]);
});
it.each<readonly [string, (outcome: Outcome) => unknown]>([
  ["crossed request", (out) => ({ ...out, requestId: "crossed" })],
  ["crossed operation", (out) => ({ ...out, operationId: "crossed" })],
  [
    "crossed context",
    (out) => ({ ...out, context: { ...context, profileId: "crossed" } }),
  ],
  [
    "crossed backend",
    (out) => ({
      ...out,
      context: { ...context, backendGeneration: "crossed" },
    }),
  ],
  ["unexpected data", (out) => ({ ...out, data: {} })],
  ["null data", (out) => ({ ...out, data: null })],
  ["undefined data", (out) => ({ ...out, data: undefined })],
  ["unexpected code", (out) => ({ ...out, code: "authority_refused" })],
  [
    "missing code",
    (out) => {
      const { code: _code, ...rest } = out;
      return rest;
    },
  ],
  ["unknown status", (out) => ({ ...out, status: "unknown" })],
  ["unavailable status", (out) => ({ ...out, status: "unavailable" })],
  ["unsupported status", (out) => ({ ...out, status: "unsupported" })],
  ["ok without data", (out) => ({ ...out, status: "ok" })],
  ["invalid status", (out) => ({ ...out, status: "invalid" })],
  [
    "missing request",
    (out) => {
      const { requestId: _requestId, ...rest } = out;
      return rest;
    },
  ],
  [
    "missing operation",
    (out) => {
      const { operationId: _operationId, ...rest } = out;
      return rest;
    },
  ],
  [
    "missing context",
    (out) => {
      const { context: _context, ...rest } = out;
      return rest;
    },
  ],
  ["null context", (out) => ({ ...out, context: null })],
  [
    "extra context field",
    (out) => ({ ...out, context: { ...context, extra: true } }),
  ],
  ["extra outcome field", (out) => ({ ...out, extra: true })],
  ["missing outcome", () => undefined],
  ["null outcome", () => null],
])("keeps %s unknown and close blocked", async (_name, change) => {
  const { request, host } = fixture();
  refuseOpen(request, change);
  const error = await host.open(input).catch((error: unknown) => error);
  expect(error).toMatchObject({
    state: "unknown",
    code: "connector_open_unconfirmed",
    method: "computer.connector.open",
    requestId: request.mock.calls[0]![2]!.id,
    operationId: request.mock.calls[0]![2]!.operationId,
    outcome: "unknown",
  });
  await expect(host.close()).rejects.toMatchObject({
    state: "unknown",
    code: "connector_close_unconfirmed",
  });
  await expect(host.open(input)).rejects.toMatchObject({
    state: "unavailable",
    code: "connector_host_unavailable",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([refusalCode, "authority_refused"])(
  "does not infer no publication from a rejected request: %s",
  async (code) => {
    const { request, host } = fixture();
    const error = new BridgeError("refused", code);
    request.mockRejectedValueOnce(error);
    await expect(host.open(input)).rejects.toMatchObject({
      state: "refused",
      outcome: "unknown",
      requestId: expect.any(String),
      operationId: expect.any(String),
      code: code === refusalCode ? code : "connector_open_unconfirmed",
    });
    await expect(host.close()).rejects.toMatchObject({
      state: "unknown",
      code: "connector_close_unconfirmed",
    });
    await expect(host.open(input)).rejects.toMatchObject({
      state: "unavailable",
      code: "connector_host_unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "build",
  "profile",
  "backend",
  "runtime",
  "generation",
  "operation",
  "request",
  "context",
])("blocks crossed %s without another effect", async (field) => {
  const { request, host } = fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementationOnce(async (...args) => {
    const out = await original(...args);
    const data = structuredClone(out.data) as Record<string, any>;
    const key = {
      build: "buildId",
      profile: "profileId",
      backend: "backendGeneration",
      runtime: "runtimeId",
      generation: "connectorGeneration",
    }[field];
    if (key)
      data.endpoint.binding[key] = field === "generation" ? "2" : "crossed";
    if (field === "operation") data.admissionOperationId = "crossed";
    return {
      ...out,
      data,
      ...(field === "request" ? { requestId: "crossed" } : {}),
      ...(field === "context"
        ? { context: { ...context, backendGeneration: "crossed" } }
        : {}),
    };
  });
  await expect(host.open(input)).rejects.toMatchObject({ state: "unknown" });
  await expect(host.open(input)).rejects.toMatchObject({
    code: "connector_host_unavailable",
  });
  await expect(host.close()).rejects.toMatchObject({
    code: "connector_close_unconfirmed",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("keeps lost open or close replies blocked and never repeats effects", async () => {
  for (const phase of ["open", "close"]) {
    const { request, host } = fixture();
    if (phase === "close") await host.open(input);
    request.mockRejectedValueOnce(new Error("lost response"));
    await expect(
      phase === "open" ? host.open(input) : host.close(),
    ).rejects.toMatchObject({
      state: "unknown",
      code: `connector_${phase}_unconfirmed`,
      outcome: "unknown",
      method: `computer.connector.${phase}`,
      requestId: request.mock.calls.at(-1)![2]!.id,
      operationId: request.mock.calls.at(-1)![2]!.operationId,
    });
    const calls = request.mock.calls.length;
    await expect(host.close()).rejects.toMatchObject({ state: "unknown" });
    await expect(host.open(input)).rejects.toMatchObject({
      state: "unavailable",
    });
    expect(request).toHaveBeenCalledTimes(calls);
  }
});

it("exposes the exact original identity when the Go-open reply is lost", async () => {
  // Pipe fixture only: Go may have opened the connector, but no reply arrives.
  const { request, host } = fixture();
  const original = request.getMockImplementation()!;
  const reply = deferredOutcome();
  request.mockReturnValueOnce(reply.promise);
  const opening = host.open(input).catch((error: unknown) => error);
  const goReply = await original(...request.mock.calls[0]!);
  reply.reject(new BridgeError("unknown", "response_timeout"));
  const error = await opening;
  expect(error).toBeInstanceOf(BridgeError);
  expect(error).toBeInstanceOf(ConnectorHostError);
  expect(Object.isFrozen(error)).toBe(true);
  expect(error).toMatchObject({
    state: "unknown",
    code: "response_timeout",
    method: "computer.connector.open",
    requestId: goReply.requestId,
    operationId: goReply.operationId,
    outcome: "unknown",
  });
  expect(goReply.requestId).not.toBe(goReply.operationId);
  await expect(host.open(input)).rejects.toMatchObject({
    code: "connector_host_unavailable",
  });
  await expect(host.close()).rejects.toMatchObject({
    code: "connector_close_unconfirmed",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["open", "close"] as const)(
  "keeps %s failure metadata content-free even for an untrusted bridge error",
  async (phase) => {
    const { request, host } = fixture();
    if (phase === "close") await host.open(input);
    const privateContent = "private_fixture_endpoint_token_and_path";
    const error = Object.assign(new BridgeError("unknown", privateContent), {
      data: { endpoint: { token: privateContent } },
      requestId: "foreign-request",
      operationId: "foreign-operation",
      cause: new Error(privateContent),
    });
    request.mockRejectedValueOnce(error);
    const failure = await (
      phase === "open" ? host.open(input) : host.close()
    ).catch((error: unknown) => error);
    if (!(failure instanceof ConnectorHostError))
      throw new Error("missing connector host failure");
    expect(failure.message).toBe(`connector_${phase}_unconfirmed`);
    expect(JSON.parse(JSON.stringify(failure))).toEqual({
      state: "unknown",
      code: `connector_${phase}_unconfirmed`,
      method: `computer.connector.${phase}`,
      requestId: request.mock.calls.at(-1)![2]!.id,
      operationId: request.mock.calls.at(-1)![2]!.operationId,
      outcome: "unknown",
    });
    expect(failure.stack).not.toContain(privateContent);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("data");
  },
);

it("does not invent operation identity for local pre-request failures", async () => {
  const { request, host } = fixture();
  const error = await host
    .open({ ...input, runtimeId: "" })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(BridgeError);
  expect(error).not.toBeInstanceOf(ConnectorHostError);
  expect(error).toMatchObject({
    state: "refused",
    code: "invalid_connector_open",
  });
  expect(error).not.toHaveProperty("requestId");
  expect(error).not.toHaveProperty("operationId");
  expect(request).not.toHaveBeenCalled();
});

it.each(["missing", "wrong-path", "known"])(
  "requires the original Go launch file receipt: %s",
  async (mode) => {
    const { host, request } = fixture(),
      original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const response = await original(...args);
      return {
        ...response,
        data: {
          ...(response.data as object),
          ...(mode === "missing"
            ? {}
            : {
                launchFile:
                  mode === "known"
                    ? "/private/tmp/computer-go-launch.json"
                    : "/private/tmp/other/computer-go-launch.json",
                launchSha256: "d".repeat(64),
              }),
        },
      };
    });
    const attempt = host.open({
      ...input,
      challengeSha256: "a".repeat(64),
      lifecycleRoot: "/private/tmp/lifecycle",
    });
    if (mode === "known")
      expect((await attempt).launchSha256).toBe("d".repeat(64));
    else {
      await expect(attempt).rejects.toMatchObject({ state: "unknown" });
      await expect(host.close()).rejects.toMatchObject({ state: "unknown" });
    }
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("observes polling as a correlated read without publication, close or authority effects", async () => {
  const { host, request } = fixture();
  await expect(host.observePolling({})).rejects.toMatchObject({
    code: "connector_polling_unavailable",
  });
  expect(request).not.toHaveBeenCalled();
  await host.open(input);
  request.mockClear();
  request.mockImplementation(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: {
      binding,
      state: "recent",
      observedAtMillis: "1700000000000",
      cycles: "10",
      ageSeconds: "1",
    },
  }));
  const observed = await host.observePolling({
    cycles: "10",
    lastSuccessMillis: "1699999999000",
  });
  expect(observed.state).toBe("recent");
  expect(Object.isFrozen(observed.binding)).toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.connector.polling",
    { binding, samples: { cycles: "10", lastSuccessMillis: "1699999999000" } },
    { id: expect.any(String), timeoutMs: 5000 },
  );
});
it("withholds original polling after close and refuses crossed result bindings", async () => {
  const { host, request } = fixture();
  await host.open(input);
  request.mockImplementationOnce(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: {
      binding: { ...binding, runtimeId: "crossed" },
      state: "recent",
      observedAtMillis: "1700000000000",
    },
  }));
  await expect(host.observePolling({})).rejects.toMatchObject({
    code: "crossed_connector_polling",
  });
  const deferred = deferredOutcome();
  let originalId = "";
  // Supply the known original close result independently of the pending read.
  request.mockImplementation(async (method, _body, options = {}) => {
    if (method === "computer.connector.polling") {
      originalId = options.id!;
      return deferred.promise;
    }
    return {
      status: "ok",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
      data: { binding, closed: true },
    };
  });
  const pending = host.observePolling({});
  const rejected = expect(pending).rejects.toMatchObject({
    code: "connector_polling_unavailable",
  });
  await host.close();
  deferred.resolve({
    status: "ok",
    requestId: originalId,
    context,
    data: { binding, state: "recent", observedAtMillis: "1700000000000" },
  });
  await rejected;
  expect(
    request.mock.calls.filter(
      ([method]) => method === "computer.connector.close",
    ),
  ).toHaveLength(1);
});

it.each([
  { state: "recent" },
  { state: "unknown", ageSeconds: "1" },
  { state: "recent", ageSeconds: "1", cycles: "crossed" },
])("refuses inconsistent polling result %j", async (data) => {
  const { host, request } = fixture();
  await host.open(input);
  request.mockImplementationOnce(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: { binding, observedAtMillis: "1700000000000", ...data },
  }));
  await expect(host.observePolling({})).rejects.toMatchObject({
    code: "invalid_connector_polling",
  });
});

const healthSample = () => ({
  snapshotAtMillis: "200000",
  runtimeInstanceId: "instance-A",
  runtimeStartedAtMillis: "1000",
  runtimeLifecycle: "running" as const,
  runtimeLimited: false,
  live: true,
  ready: true,
  truncated: false,
});
const healthResult = () => ({
  binding,
  expectedInstanceId: "instance-A",
  sampleAtMillis: "200000",
  state: "unobserved",
  reason: "polling_missing",
  localReady: true,
  observedAtMillis: "200000",
  validUntilMillis: "245000",
});
it("observes health only through the original bound read, with a detached request and no effect", async () => {
  const { host, request } = fixture();
  await expect(host.observeHealth("instance-A")).rejects.toMatchObject({
    code: "connector_health_unavailable",
  });
  expect(request).not.toHaveBeenCalled();
  await host.open(input);
  request.mockClear();
  request.mockImplementation(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: healthResult(),
  }));
  const source = healthSample();
  const pending = host.observeHealth("instance-A", source);
  source.snapshotAtMillis = "300000";
  const result = await pending;
  expect(result.sampleAtMillis).toBe("200000");
  expect(Object.isFrozen(result.binding)).toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.connector.health",
    { binding, expectedInstanceId: "instance-A", snapshot: healthSample() },
    { id: expect.any(String), timeoutMs: 5000 },
  );
});
it.each([
  { binding: { ...binding, runtimeId: "foreign" } },
  { expectedInstanceId: "foreign" },
  { sampleAtMillis: "200001" },
])("rejects crossed health echo %j without effects", async (changed) => {
  const { host, request } = fixture();
  await host.open(input);
  request.mockImplementationOnce(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: { ...healthResult(), ...changed },
  }));
  await expect(
    host.observeHealth("instance-A", healthSample()),
  ).rejects.toMatchObject({ code: "crossed_connector_health" });
  expect(request).toHaveBeenCalledTimes(2);
});
it("rejects malformed health state and retains original unknown outcomes", async () => {
  const { host, request } = fixture();
  await host.open(input);
  request.mockImplementationOnce(async (_method, _body, options = {}) => ({
    status: "ok",
    requestId: options.id!,
    context,
    data: { ...healthResult(), reason: "raw-private-error" },
  }));
  await expect(
    host.observeHealth("instance-A", healthSample()),
  ).rejects.toMatchObject({ code: "invalid_connector_health" });
  request.mockImplementationOnce(async (_method, _body, options = {}) => ({
    status: "unknown",
    requestId: options.id!,
    context,
  }));
  await expect(
    host.observeHealth("instance-A", healthSample()),
  ).rejects.toMatchObject({ state: "unknown" });
  expect(request).toHaveBeenCalledTimes(3);
});
it("withholds a pending health result after original close without replay", async () => {
  const { host, request } = fixture();
  await host.open(input);
  const deferred = deferredOutcome();
  let requestId = "";
  request.mockImplementation(async (method, _body, options = {}) => {
    if (method === "computer.connector.health") {
      requestId = options.id!;
      return deferred.promise;
    }
    return {
      status: "ok",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
      data: { binding, closed: true },
    };
  });
  const pending = host.observeHealth("instance-A", healthSample());
  const rejected = expect(pending).rejects.toMatchObject({
    code: "connector_health_unavailable",
  });
  await host.close();
  deferred.resolve({ status: "ok", requestId, context, data: healthResult() });
  await rejected;
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.open",
    "computer.connector.health",
    "computer.connector.close",
  ]);
});
