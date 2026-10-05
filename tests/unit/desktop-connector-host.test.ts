import { expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client";
import { ConnectorHostBridge } from "../../apps/desktop/bridge/connector-host";
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
  await expect(host.open(input)).rejects.toMatchObject({
    state: "refused",
    code: refusalCode,
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
  await expect(host.open(input)).rejects.toMatchObject({
    state: "unknown",
    code: "connector_open_unconfirmed",
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
    await expect(host.open(input)).rejects.toBe(error);
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
    ).rejects.toThrow("lost response");
    const calls = request.mock.calls.length;
    await expect(host.close()).rejects.toMatchObject({ state: "unknown" });
    await expect(host.open(input)).rejects.toMatchObject({
      state: "unavailable",
    });
    expect(request).toHaveBeenCalledTimes(calls);
  }
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
