import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import {
  ConnectorMutationBridge,
  connectorMutationMethods,
  connectorSupportsMutations,
} from "../../apps/desktop/bridge/connector-mutation.ts";
import {
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
  type ComputerConnectorOpened,
  type ComputerConnectorMutationResponse,
  type Context,
  type Identity,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Injected pure codec fixtures only: no socket, process, filesystem or Go execution.
const context: Context = { profileId: "profile", backendGeneration: "backend" };
const opened: ComputerConnectorOpened = {
  endpoint: {
    binding: {
      ...context,
      buildId: "build",
      runtimeId: "runtime",
      connectorGeneration: "18446744073709551615",
    },
    socketPath: "/fixture/socket",
    token: "a".repeat(64),
  },
  execution: {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    generation: "2",
  },
  admissionOperationId: "admission",
};
const call = { requestId: "current-call", context };
const input = {
  workspaceId: "workspace",
  relativePath: "note.md",
  content: "🌊text",
};
const hash = "a".repeat(64);
const editInput = {
  workspaceId: input.workspaceId,
  relativePath: input.relativePath,
  expectedSHA256: hash,
  edits: [{ oldText: "old", newText: "new" }],
};
const readInput = {
  workspaceId: input.workspaceId,
  relativePath: input.relativePath,
  operationId: "operation",
};
function result(
  kind: "write" | "edit" = "write",
): ComputerConnectorMutationResponse {
  return {
    execution: { ...opened.execution },
    callId: call.requestId,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    operationId: "operation",
    computerGeneration: "9007199254740991",
    origin: {
      binding: { ...opened.endpoint.binding },
      execution: { ...opened.execution },
      callId: call.requestId,
      operation: kind,
    },
    phase: "completed",
    publication: "memory_only",
    receipt: {
      operation: kind,
      relativePath: input.relativePath,
      bytes: String(Buffer.byteLength(input.content, "utf8")),
      replacements: kind === "write" ? 0 : 1,
      ...(kind === "edit" ? { beforeSHA256: hash } : {}),
      afterSHA256: createHash("sha256").update(input.content).digest("hex"),
    },
  };
}
function outcome(data: unknown = result(), effect = true): unknown {
  return {
    status: "ok",
    requestId: call.requestId,
    context: { ...context },
    ...(effect ? { operationId: "operation" } : {}),
    data,
  };
}
function setup(reply: unknown = outcome()) {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      _options?: { id?: string; operationId?: string; timeoutMs?: number },
    ) => reply as Outcome,
  );
  return {
    request,
    bridge: new ConnectorMutationBridge({ request }, opened, context),
  };
}

it("sends one nested current-execution effect with the caller's operation ID", async () => {
  const { bridge, request } = setup();
  const out = await bridge.write(input, "operation", call);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.workspace.write",
    { ...input, execution: opened.execution, callId: call.requestId },
    { id: call.requestId, operationId: "operation", timeoutMs: 10000 },
  );
  expect(out).toMatchObject({
    status: "ok",
    operationId: "operation",
    data: { publication: "memory_only" },
  });
  expect(Object.isFrozen(out)).toBe(true);
  expect(Object.isFrozen(out.data?.origin.binding)).toBe(true);
  expect(Object.isFrozen(out.data?.receipt)).toBe(true);
});
it("uses the same selected client for edit and preimage validation", async () => {
  const { bridge, request } = setup(outcome(result("edit")));
  expect((await bridge.edit(editInput, "operation", call)).status).toBe("ok");
  expect(request.mock.calls[0]?.[0]).toBe("computer.workspace.edit");
  const wrong = result("edit");
  const changed = {
    ...wrong,
    receipt: { ...wrong.receipt!, beforeSHA256: "b".repeat(64) },
  };
  expect(
    (await setup(outcome(changed)).bridge.edit(editInput, "operation", call))
      .status,
  ).toBe("unknown");
});
it("retained read preserves old binding/execution/call and omits the outer operation ID", async () => {
  const old = result();
  const data = {
    ...old,
    origin: {
      ...old.origin,
      callId: "old-call",
      binding: {
        ...old.origin.binding,
        runtimeId: "old-runtime",
        buildId: "old-build",
        backendGeneration: "old-backend",
        connectorGeneration: "9007199254740993",
      },
      execution: {
        ...old.origin.execution,
        sessionId: "old-session",
        taskId: "old-task",
        taskEpoch: "0",
        participantId: "old-participant",
        turnId: "old-turn",
        generation: "0",
      },
    },
  };
  const { bridge, request } = setup(outcome(data, false));
  const out = await bridge.read(readInput, call);
  expect(out.status).toBe("ok");
  expect(out.data?.origin).toEqual(data.origin);
  expect(out.data?.publication).toBe("memory_only");
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.workspace.mutation.read",
    { ...readInput, execution: opened.execution, callId: call.requestId },
    { id: call.requestId, timeoutMs: 10000 },
  );
});

it.each([
  {
    field: "current execution",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      execution: { ...d.execution, turnId: "other" },
    }),
  },
  {
    field: "current call",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      callId: "other",
    }),
  },
  {
    field: "workspace",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      workspaceId: "other",
    }),
  },
  {
    field: "path",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      relativePath: "other.md",
    }),
  },
  {
    field: "operation",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      operationId: "other",
    }),
  },
  {
    field: "origin binding",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      origin: {
        ...d.origin,
        binding: { ...d.origin.binding, runtimeId: "other" },
      },
    }),
  },
  {
    field: "origin execution",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      origin: {
        ...d.origin,
        execution: { ...d.origin.execution, turnId: "other" },
      },
    }),
  },
  {
    field: "origin call",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      origin: { ...d.origin, callId: "other" },
    }),
  },
  {
    field: "origin kind",
    change: (d: ComputerConnectorMutationResponse) => ({
      ...d,
      origin: { ...d.origin, operation: "edit" },
    }),
  },
])(
  "rejects crossed $field on effects without disclosing payload",
  async ({ change }) => {
    const { bridge, request } = setup(outcome(change(result())));
    const out = await bridge.write(input, "operation", call);
    expect(out).toEqual({
      status: "unknown",
      requestId: call.requestId,
      context,
      operationId: "operation",
      code: "invalid_connector_mutation_response",
      retry: "never",
    });
    expect(JSON.stringify(out)).not.toContain(input.content);
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it.each(["0", "01", "1e3", "18446744073709551616"])(
  "rejects invalid retained connector generation %s",
  async (connectorGeneration) => {
    const d = result();
    const data = {
      ...d,
      origin: {
        ...d.origin,
        binding: { ...d.origin.binding, connectorGeneration },
      },
    };
    expect(
      (await setup(outcome(data, false)).bridge.read(readInput, call)).status,
    ).toBe("unknown");
  },
);
it.each(["owner", "profile"])(
  "refuses a retained result from another stable %s",
  async (field) => {
    const d = result();
    const data = {
      ...d,
      origin: {
        ...d.origin,
        ...(field === "owner"
          ? { execution: { ...d.origin.execution, ownerId: "other" } }
          : { binding: { ...d.origin.binding, profileId: "other" } }),
      },
    };
    expect(
      (await setup(outcome(data, false)).bridge.read(readInput, call)).status,
    ).toBe("unknown");
  },
);
it.each([
  { receipt: undefined },
  {
    failure: {
      code: "WORKSPACE_MUTATION_CONFLICT",
      source: "native-workspace",
      retry: "never",
    },
  },
  { publication: "persistent" },
  { receipt: { ...result().receipt!, replacements: 1 } },
  { receipt: { ...result().receipt!, bytes: "99999999" } },
  { receipt: { ...result().receipt!, bytes: "1" } },
  { receipt: { ...result().receipt!, afterSHA256: "b".repeat(64) } },
  { receipt: { ...result().receipt!, beforeSHA256: hash } },
  { receipt: { ...result().receipt!, relativePath: "other" } },
  {
    phase: "failed",
    receipt: undefined,
    failure: {
      code: "secret content",
      source: "native-workspace",
      retry: "never",
    },
  },
  {
    phase: "outcome_unknown",
    receipt: undefined,
    failure: {
      code: "WORKSPACE_MUTATION_CONFLICT",
      source: "native-workspace",
      retry: "never",
    },
  },
  {
    phase: "failed",
    receipt: undefined,
    failure: {
      code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      source: "native-workspace",
      retry: "never",
    },
  },
])("rejects invalid phase/receipt/publication semantics %#", async (change) => {
  const data = { ...result(), ...change };
  // Omit optional fields rather than putting undefined on wire.
  for (const key of Object.keys(data))
    if (data[key as keyof typeof data] === undefined)
      delete (data as Record<string, unknown>)[key];
  expect(
    (await setup(outcome(data)).bridge.write(input, "operation", call)).status,
  ).toBe("unknown");
});
it.each(["durable", "memory_only"] as const)(
  "preserves %s failures and UNKNOWN operation IDs",
  async (publication) => {
    for (const phase of ["failed", "outcome_unknown"] as const) {
      const { receipt: _receipt, ...rest } = result();
      const data = {
        ...rest,
        phase,
        publication,
        failure: {
          code:
            phase === "failed"
              ? "WORKSPACE_MUTATION_CONFLICT"
              : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          source: "operation-store",
          retry: "never",
        },
      };
      const out = await setup(outcome(data)).bridge.write(
        input,
        "operation",
        call,
      );
      expect(out).toMatchObject({
        status: phase === "failed" ? "refused" : "unknown",
        operationId: "operation",
        data: { phase, publication },
      });
    }
  },
);
it("requires the replacement preimage to match exactly", async () => {
  const data = result();
  const reply = { ...data, receipt: { ...data.receipt!, beforeSHA256: hash } };
  expect(
    (
      await setup(outcome(reply)).bridge.write(
        { ...input, expectedSHA256: hash },
        "operation",
        call,
      )
    ).status,
  ).toBe("ok");
  expect(
    (
      await setup(outcome(reply)).bridge.write(
        { ...input, expectedSHA256: "b".repeat(64) },
        "operation",
        call,
      )
    ).status,
  ).toBe("unknown");
});
it.each([
  { ...input, content: "🌊".repeat(65537) },
  { ...input, content: "\ud800" },
  { ...input, content: "\0" },
  { ...input, content: "\u0001".repeat(100000) },
  { ...input, relativePath: "../other" },
  { ...input, execution: opened.execution },
  { ...input, extra: "forbidden" },
])("refuses invalid/bounded request before dispatch %#", async (invalid) => {
  const { bridge, request } = setup();
  await expect(bridge.write(invalid, "operation", call)).rejects.toMatchObject({
    state: "refused",
    code: "invalid_connector_mutation_request",
  });
  expect(request).not.toHaveBeenCalled();
});
it("accepts the exact UTF-8 bound", async () => {
  const content = "🌊".repeat(65536);
  const data = result();
  const reply = {
    ...data,
    receipt: {
      ...data.receipt!,
      bytes: "262144",
      afterSHA256: createHash("sha256").update(content).digest("hex"),
    },
  };
  expect(
    (
      await setup(outcome(reply)).bridge.write(
        { ...input, content },
        "operation",
        call,
      )
    ).status,
  ).toBe("ok");
});
it.each([128, 129, 256])(
  "validates %i edits through the generated whole-body validator",
  async (count) => {
    const edits = Array.from({ length: count }, (_, i) => ({
      oldText: `old-${i}`,
      newText: `new-${i}`,
    }));
    const data = result("edit");
    const reply = {
      ...data,
      receipt: { ...data.receipt!, replacements: count },
    };
    const { bridge, request } = setup(outcome(reply));
    expect(
      (await bridge.edit({ ...editInput, edits }, "operation", call)).status,
    ).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("refuses zero or 257 edits, aggregate overflow and unchanged edits before dispatch", async () => {
  const { bridge, request } = setup();
  for (const edits of [
    [],
    Array.from({ length: 257 }, (_, i) => ({
      oldText: `old-${i}`,
      newText: `new-${i}`,
    })),
    [{ oldText: "x".repeat(262144), newText: "y" }],
    [{ oldText: "same", newText: "same" }],
  ]) {
    await expect(
      bridge.edit({ ...editInput, edits }, "operation", call),
    ).rejects.toMatchObject({ state: "refused" });
  }
  expect(request).not.toHaveBeenCalled();
});
it("preserves a metadata-only late-authority UNKNOWN with the original operation ID", async () => {
  const { bridge, request } = setup({
    status: "unknown",
    requestId: call.requestId,
    context,
    operationId: "operation",
    code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
  });
  expect(await bridge.write(input, "operation", call)).toEqual({
    status: "unknown",
    requestId: call.requestId,
    context,
    operationId: "operation",
    code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    retry: "never",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects accessors without invoking them on selection, request or response", async () => {
  const getter = vi.fn(() => "secret");
  const hostile = Object.defineProperty({ ...input }, "content", {
    enumerable: true,
    get: getter,
  });
  const { bridge, request } = setup();
  await expect(bridge.write(hostile, "operation", call)).rejects.toMatchObject({
    state: "refused",
  });
  expect(request).not.toHaveBeenCalled();
  const peer = Object.defineProperty(result(), "receipt", {
    enumerable: true,
    get: getter,
  });
  expect(
    (await setup(outcome(peer)).bridge.write(input, "operation", call)).status,
  ).toBe("unknown");
  const selection = Object.defineProperty({ ...opened }, "execution", {
    enumerable: true,
    get: getter,
  });
  expect(
    () => new ConnectorMutationBridge({ request }, selection, context),
  ).toThrow("invalid_connector_mutation_binding");
  expect(getter).not.toHaveBeenCalled();
});
it("detaches inputs before await and returns immutable original snapshots", async () => {
  const peer = result();
  const { bridge } = setup(outcome(peer));
  const out = await bridge.write(input, "operation", call);
  (peer.origin.binding as { runtimeId: string }).runtimeId = "changed";
  expect(out.data?.origin.binding.runtimeId).toBe("runtime");
  expect(() => {
    (out.data!.origin.binding as { runtimeId: string }).runtimeId = "changed";
  }).toThrow();
});
it("keeps transport UNKNOWN and its operation ID without replay", async () => {
  const { bridge, request } = setup();
  request.mockRejectedValueOnce(new BridgeError("unknown", "response_timeout"));
  expect(await bridge.write(input, "operation", call)).toMatchObject({
    status: "unknown",
    code: "response_timeout",
    operationId: "operation",
    retry: "never",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("suppresses unexpected peer content on failures and crossed envelopes", async () => {
  for (const reply of [
    {
      status: "refused",
      requestId: call.requestId,
      context,
      operationId: "operation",
      code: "secret content",
    },
    {
      status: "refused",
      requestId: call.requestId,
      context,
      operationId: "operation",
      code: "AUTHORITY_PATH_DENIED",
      data: { content: "secret" },
    },
    { ...(outcome() as object), operationId: "other" },
    {
      ...(outcome() as object),
      context: { ...context, backendGeneration: "other" },
    },
  ]) {
    const out = await setup(reply).bridge.write(input, "operation", call);
    expect(out.status).toBe("unknown");
    expect(JSON.stringify(out)).not.toContain("secret");
  }
});
describe("pure handshake capability gate", () => {
  const identity: Identity = {
    protocolMajor,
    protocolMinor,
    buildId: "build",
    profileId: context.profileId,
    backendGeneration: context.backendGeneration,
    maxFrameBytes,
    capabilities: [],
  };
  it("selects only the complete mutation slice and preserves read-only peers", () => {
    expect(connectorSupportsMutations(identity)).toBe(false);
    expect(
      connectorSupportsMutations({
        ...identity,
        capabilities: [...connectorMutationMethods],
      }),
    ).toBe(true);
    for (const capabilities of [
      [connectorMutationMethods[0]!],
      connectorMutationMethods.slice(0, 2),
      connectorMutationMethods.slice(1),
    ]) {
      expect(() =>
        connectorSupportsMutations({ ...identity, capabilities }),
      ).toThrow("connector_mutation_capabilities_invalid");
    }
  });
});
