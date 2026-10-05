import { expect, it, vi } from "vitest";
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
