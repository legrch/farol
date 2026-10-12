import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import {
  ConnectorProcessBridge,
  connectorProcessMethods,
  connectorSupportsProcesses,
  type ConnectorProcessStartInput,
  type ConnectorProcessReadInput,
  type ConnectorProcessCancelInput,
} from "../../apps/desktop/bridge/connector-process.ts";
import {
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
  type Context,
  type ComputerConnectorOpened,
  type ComputerConnectorProcessResult,
  type Identity,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Injected codec fixtures only. No Go, native process, store, socket or provider.
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
    taskEpoch: "18446744073709551615",
    participantId: "participant",
    turnId: "turn",
    generation: "9007199254740993",
  },
  admissionOperationId: "admission",
};
const call = { requestId: "current-call", context };
const startInput: ConnectorProcessStartInput = {
  workspaceId: "workspace",
  relativeCwd: ".",
  command: "printf fixture",
  write: false,
};
const readInput: ConnectorProcessReadInput = {
  operationId: "original",
  handle: "handle",
  stdoutOffset: "0",
  stderrOffset: "0",
};
const cancelInput: ConnectorProcessCancelInput = {
  operationId: "original",
  handle: "handle",
};
type Kind = "start" | "read" | "cancel";
function observation(): ComputerConnectorProcessResult {
  return {
    execution: { ...opened.execution },
    callId: call.requestId,
    ...readInput,
    state: "running",
    rootState: "running",
    rootWaited: false,
    exitSignal: 0,
    groupCleanup: "pending",
    descendantCleanup: "pending",
    stdoutBase64: "",
    stderrBase64: "",
    stdoutNext: "0",
    stderrNext: "0",
    stdoutBytes: "0",
    stderrBytes: "0",
    outputLimitReached: false,
    outputDrained: false,
    cancelRequested: false,
    timedOut: false,
    authorityLost: false,
  };
}
function terminal(): ComputerConnectorProcessResult {
  return {
    ...observation(),
    state: "terminal",
    rootState: "exited",
    rootWaited: true,
    exitCode: 0,
    groupCleanup: "confirmed",
    descendantCleanup: "confirmed",
    outputDrained: true,
  };
}
function exited(): ComputerConnectorProcessResult {
  return {
    ...terminal(),
    state: "exited",
    supervisorState: "exited",
    groupCleanup: "unverified",
    descendantCleanup: "unverified",
  };
}
function data(kind: Kind): Record<string, unknown> {
  if (kind === "read") return { ...observation() };
  return {
    execution: { ...opened.execution },
    callId: call.requestId,
    operationId: "original",
    handle: "handle",
    ...(kind === "cancel"
      ? { cancelOperationId: "cancellation", status: "requested" }
      : {}),
  };
}
function outcome(
  kind: Kind,
  selected: unknown = data(kind),
): Record<string, unknown> {
  return {
    status: "ok",
    requestId: call.requestId,
    context: { ...context },
    data: selected,
    ...(kind === "read"
      ? {}
      : { operationId: kind === "start" ? "original" : "cancellation" }),
  };
}
function setup(kind: Kind, reply: unknown = outcome(kind)) {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      _options?: { id?: string; operationId?: string; timeoutMs?: number },
    ) => reply as Outcome,
  );
  return {
    request,
    bridge: new ConnectorProcessBridge({ request }, opened, context),
  };
}
function invoke(bridge: ConnectorProcessBridge, kind: Kind) {
  return kind === "start"
    ? bridge.start(startInput, "original", call)
    : kind === "read"
      ? bridge.read(readInput, call)
      : bridge.cancel(cancelInput, "cancellation", call);
}
const kinds: Kind[] = ["start", "read", "cancel"];

it.each(kinds)(
  "%s sends exactly one current call through the selected client",
  async (kind) => {
    const { bridge, request } = setup(kind);
    const out = await invoke(bridge, kind);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `computer.process.${kind}`,
      {
        ...(kind === "start"
          ? startInput
          : kind === "read"
            ? readInput
            : cancelInput),
        execution: opened.execution,
        callId: call.requestId,
      },
      {
        id: call.requestId,
        timeoutMs: 10000,
        ...(kind === "read"
          ? {}
          : { operationId: kind === "start" ? "original" : "cancellation" }),
      },
    );
    expect(out).toMatchObject({
      status: "ok",
      operationId: "original",
      context,
      requestId: call.requestId,
    });
    expect(out).not.toHaveProperty("retention");
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.context)).toBe(true);
    expect(Object.isFrozen(out.data?.execution)).toBe(true);
  },
);
it("retains distinct original and cancellation IDs and the explicit deadline", async () => {
  const { bridge, request } = setup("cancel");
  const out = await bridge.cancel(cancelInput, "cancellation", {
    ...call,
    timeoutMs: 17,
  });
  expect(out.data?.cancelOperationId).toBe("cancellation");
  expect(out.operationId).toBe("original");
  expect(out.cancelOperationId).toBe("cancellation");
  expect(request.mock.calls[0]?.[2]).toEqual({
    id: call.requestId,
    operationId: "cancellation",
    timeoutMs: 17,
  });
});
it("keeps both cancellation IDs when the outcome is malformed or remotely unknown", async () => {
  for (const selected of [
    outcome("cancel", { ...data("cancel"), handle: "crossed" }),
    {
      status: "unknown",
      requestId: call.requestId,
      context,
      operationId: "cancellation",
      code: "PROCESS_CANCEL_UNKNOWN",
    },
  ]) {
    const { bridge, request } = setup("cancel", selected);
    expect(
      await bridge.cancel(cancelInput, "cancellation", call),
    ).toMatchObject({
      status: "unknown",
      operationId: "original",
      cancelOperationId: "cancellation",
      retry: "never",
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
});
it.each(["requested", "already_terminal", "unknown"])(
  "keeps cancellation %s distinct from process completion",
  async (status) => {
    const { bridge } = setup(
      "cancel",
      outcome("cancel", { ...data("cancel"), status }),
    );
    const out = await bridge.cancel(cancelInput, "cancellation", call);
    expect(out.status).toBe(status === "unknown" ? "unknown" : "ok");
    expect(out.data?.status).toBe(status);
    expect(out.data).not.toHaveProperty("state");
    if (status === "unknown") expect(out.retry).toBe("never");
  },
);

const invalidStart: [string, Record<string, unknown>][] = [
  ["absolute cwd", { relativeCwd: "/tmp" }],
  ["parent cwd", { relativeCwd: "../x" }],
  ["dot segment", { relativeCwd: "x/./y" }],
  ["parent segment", { relativeCwd: "x/../y" }],
  ["empty segment", { relativeCwd: "x//y" }],
  ["trailing separator", { relativeCwd: "x/" }],
  ["backslash", { relativeCwd: "x\\y" }],
  ["control", { relativeCwd: "x\ny" }],
  ["empty cwd", { relativeCwd: "" }],
  ["cwd bytes", { relativeCwd: "🌊".repeat(1025) }],
  ["empty command", { command: "" }],
  ["NUL command", { command: "x\0y" }],
  ["command bytes", { command: "🌊".repeat(16385) }],
  ["stdin bytes", { stdin: "🌊".repeat(65537) }],
  ["invalid Unicode", { command: "\ud800" }],
  ["missing explicit write", { write: undefined }],
  ["string write", { write: "true" }],
  ["unknown field", { cancelOperationId: "cancellation" }],
  ["body operation ID", { operationId: "override" }],
  ["body call ID", { callId: "override" }],
  ["body execution", { execution: opened.execution }],
  ["body context", { context }],
];
it.each(invalidStart)(
  "refuses start %s before dispatch",
  async (_name, patch) => {
    const { bridge, request } = setup("start");
    await expect(
      bridge.start(
        { ...startInput, ...patch } as ConnectorProcessStartInput,
        "original",
        call,
      ),
    ).rejects.toMatchObject({ state: "refused" });
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([".", "folder/nested", "🌊"])(
  "accepts clean relative cwd %s",
  async (relativeCwd) => {
    const { bridge, request } = setup("start");
    expect(
      (await bridge.start({ ...startInput, relativeCwd }, "original", call))
        .status,
    ).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("accepts the exact UTF-8 command, cwd and stdin limits, and explicit write", async () => {
  const { bridge, request } = setup("start");
  expect(
    (
      await bridge.start(
        {
          ...startInput,
          relativeCwd: "🌊".repeat(1024),
          command: "🌊".repeat(16384),
          stdin: "🌊".repeat(65536),
          write: true,
        },
        "original",
        call,
      )
    ).status,
  ).toBe("ok");
  expect(request.mock.calls[0]?.[1]).toMatchObject({ write: true });
});
it("refuses escaped stdin above the Go body limit even when the frame fits", async () => {
  const input = { ...startInput, stdin: "\0".repeat(100000) };
  const body = {
    ...input,
    execution: opened.execution,
    callId: call.requestId,
  };
  expect(Buffer.byteLength(input.stdin, "utf8")).toBeLessThanOrEqual(262144);
  expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(
    512 * 1024,
  );
  expect(
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.requestId,
        method: "computer.process.start",
        params: { body, context, operationId: "original" },
      }),
      "utf8",
    ),
  ).toBeLessThanOrEqual(maxFrameBytes);
  const { bridge, request } = setup("start");
  await expect(bridge.start(input, "original", call)).rejects.toMatchObject({
    state: "refused",
    code: "invalid_connector_process_request",
  });
  expect(request).not.toHaveBeenCalled();
});
it.each([0, 1])(
  "checks the exact serialized body limit plus %s bytes",
  async (extra) => {
    const base = { ...startInput, stdin: "" };
    const overhead = Buffer.byteLength(
      JSON.stringify({
        ...base,
        execution: opened.execution,
        callId: call.requestId,
      }),
      "utf8",
    );
    const available = 512 * 1024 + extra - overhead;
    // NUL takes one raw stdin byte and six serialized JSON bytes.
    const input = {
      ...base,
      stdin: "\0".repeat(Math.floor(available / 6)) + "x".repeat(available % 6),
    };
    expect(Buffer.byteLength(input.stdin, "utf8")).toBeLessThanOrEqual(262144);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...input,
          execution: opened.execution,
          callId: call.requestId,
        }),
        "utf8",
      ),
    ).toBe(512 * 1024 + extra);
    const { bridge, request } = setup("start");
    if (extra === 0) {
      expect((await bridge.start(input, "original", call)).status).toBe("ok");
      expect(request).toHaveBeenCalledTimes(1);
    } else {
      await expect(bridge.start(input, "original", call)).rejects.toMatchObject(
        {
          state: "refused",
          code: "invalid_connector_process_request",
        },
      );
      expect(request).not.toHaveBeenCalled();
    }
  },
);
it("passes an empty or NUL-containing stdin without treating it as a command", async () => {
  for (const stdin of ["", "\0binary"]) {
    const { bridge, request } = setup("start");
    expect(
      (await bridge.start({ ...startInput, stdin }, "original", call)).status,
    ).toBe("ok");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ stdin });
  }
});
it.each(["", "bad id", "x".repeat(129)])(
  "refuses invalid start/cancel effect ID %j",
  async (id) => {
    const start = setup("start");
    const cancel = setup("cancel");
    await expect(
      start.bridge.start(startInput, id, call),
    ).rejects.toMatchObject({ state: "refused" });
    await expect(
      cancel.bridge.cancel(cancelInput, id, call),
    ).rejects.toMatchObject({ state: "refused" });
    expect(start.request).not.toHaveBeenCalled();
    expect(cancel.request).not.toHaveBeenCalled();
  },
);
it("refuses cancellation with the original operation ID before dispatch", async () => {
  const { bridge, request } = setup("cancel");
  await expect(
    bridge.cancel(cancelInput, "original", call),
  ).rejects.toMatchObject({ state: "refused" });
  expect(request).not.toHaveBeenCalled();
});
it.each([true, false])(
  "keeps the original supervisor observable after root exit (drained=%s)",
  async (outputDrained) => {
    const selected = {
      ...exited(),
      state: "running",
      supervisorState: "running",
      outputDrained,
    };
    const fixture = setup("read", outcome("read", selected));
    const out = await fixture.bridge.read(readInput, call);
    expect(out.status).toBe("ok");
    expect(out.data).toMatchObject({
      state: "running",
      rootState: "exited",
      exitCode: 0,
      supervisorState: "running",
      groupCleanup: "unverified",
      descendantCleanup: "unverified",
      outputDrained,
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "-1",
  "01",
  "1.0",
  "4194305",
  "18446744073709551615",
  "18446744073709551616",
])("refuses read offset %s before dispatch", async (offset) => {
  for (const stream of ["stdoutOffset", "stderrOffset"] as const) {
    const { bridge, request } = setup("read");
    await expect(
      bridge.read({ ...readInput, [stream]: offset }, call),
    ).rejects.toMatchObject({ state: "refused" });
    expect(request).not.toHaveBeenCalled();
  }
});
it.each([0, -1, 30001, Infinity, NaN])(
  "refuses deadline %s before dispatch",
  async (timeoutMs) => {
    const { bridge, request } = setup("start");
    await expect(
      bridge.start(startInput, "original", { ...call, timeoutMs }),
    ).rejects.toMatchObject({ state: "refused" });
    expect(request).not.toHaveBeenCalled();
  },
);
it("refuses crossed current context and missing current IDs before dispatch", async () => {
  const { bridge, request } = setup("start");
  for (const current of [
    { ...call, requestId: "" },
    { ...call, context: { ...context, backendGeneration: "old" } },
  ]) {
    await expect(
      bridge.start(startInput, "original", current),
    ).rejects.toMatchObject({ state: "refused" });
  }
  expect(request).not.toHaveBeenCalled();
});
it.each(["read", "cancel"] as const)(
  "refuses missing or overridden %s correlation before dispatch",
  async (kind) => {
    for (const patch of [
      { operationId: "" },
      { handle: "" },
      { callId: "override" },
      { execution: opened.execution },
      { cancelOperationId: "cancellation" },
    ]) {
      const { bridge, request } = setup(kind);
      const selected = {
        ...(kind === "read" ? readInput : cancelInput),
        ...patch,
      };
      await expect(
        kind === "read"
          ? bridge.read(selected as ConnectorProcessReadInput, call)
          : bridge.cancel(
              selected as ConnectorProcessCancelInput,
              "cancellation",
              call,
            ),
      ).rejects.toMatchObject({ state: "refused" });
      expect(request).not.toHaveBeenCalled();
    }
  },
);

const crossed: [string, (value: Record<string, unknown>) => unknown][] = [
  ["request", (value) => ({ ...value, requestId: "other" })],
  [
    "context",
    (value) => ({
      ...value,
      context: { ...context, backendGeneration: "other" },
    }),
  ],
  ["outer operation", (value) => ({ ...value, operationId: "other" })],
  [
    "call",
    (value) => ({
      ...value,
      data: { ...(value.data as object), callId: "other" },
    }),
  ],
  [
    "execution",
    (value) => ({
      ...value,
      data: {
        ...(value.data as object),
        execution: { ...opened.execution, taskEpoch: "2" },
      },
    }),
  ],
  [
    "target operation",
    (value) => ({
      ...value,
      data: { ...(value.data as object), operationId: "other" },
    }),
  ],
  [
    "missing handle",
    (value) => ({ ...value, data: { ...(value.data as object), handle: "" } }),
  ],
  [
    "extra retention",
    (value) => ({
      ...value,
      data: { ...(value.data as object), retention: "durable" },
    }),
  ],
  ["ok with code", (value) => ({ ...value, code: "PROCESS_OK" })],
  [
    "missing data",
    (value) => {
      const { data: _data, ...rest } = value;
      return rest;
    },
  ],
  ["extra envelope", (value) => ({ ...value, retry: "never" })],
];
describe.each(kinds)("%s crossed replies", (kind) => {
  it.each(crossed)(
    "returns unknown for %s after one dispatch",
    async (_name, change) => {
      const { bridge, request } = setup(kind, change(outcome(kind)));
      expect(await invoke(bridge, kind)).toMatchObject({
        status: "unknown",
        requestId: call.requestId,
        context,
        operationId: "original",
        retry: "never",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new Error("broken"),
    new BridgeError("unknown", "response_timeout"),
    new BridgeError("refused", "transport_refused"),
    new BridgeError("unavailable", "transport_lost"),
  ])("never resends a rejected transport call (%s)", async (error) => {
    const { bridge, request } = setup(kind);
    request.mockRejectedValueOnce(error);
    expect(await invoke(bridge, kind)).toMatchObject({
      status: "unknown",
      retry: "never",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["refused", "unavailable", "unsupported", "unknown"])(
    "preserves a correlated remote %s",
    async (status) => {
      const selected = outcome(kind);
      delete selected.data;
      const { bridge, request } = setup(kind, {
        ...selected,
        status,
        code: "PROCESS_INPUT_INVALID",
      });
      expect(await invoke(bridge, kind)).toMatchObject({
        status,
        code: "PROCESS_INPUT_INVALID",
        retry: "never",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects non-ok data and unsafe failure codes as unknown", async () => {
    for (const selected of [
      { ...outcome(kind), status: "refused", code: "PROCESS_INPUT_INVALID" },
      {
        ...outcome(kind),
        status: "unknown",
        data: undefined,
        code: "private diagnostic /unsafe",
      },
    ]) {
      const { bridge, request } = setup(kind, selected);
      expect((await invoke(bridge, kind)).status).toBe("unknown");
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
it.each(["read", "cancel"] as const)(
  "rejects crossed %s handle",
  async (kind) => {
    const { bridge, request } = setup(
      kind,
      outcome(kind, { ...data(kind), handle: "other" }),
    );
    expect((await invoke(bridge, kind)).status).toBe("unknown");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("rejects a cancellation receipt with the original ID as cancellation ID", async () => {
  const { bridge } = setup(
    "cancel",
    outcome("cancel", { ...data("cancel"), cancelOperationId: "original" }),
  );
  expect((await bridge.cancel(cancelInput, "cancellation", call)).status).toBe(
    "unknown",
  );
});

const invalidWindows: [string, Partial<ComputerConnectorProcessResult>][] = [
  [
    "noncanonical padding bits",
    { stdoutBase64: "Zh==", stdoutNext: "1", stdoutBytes: "1" },
  ],
  [
    "missing padding",
    { stdoutBase64: "Zg", stdoutNext: "1", stdoutBytes: "1" },
  ],
  ["whitespace", { stdoutBase64: "Zg==\n", stdoutNext: "1", stdoutBytes: "1" }],
  ["URL alphabet", { stdoutBase64: "_w==", stdoutNext: "1", stdoutBytes: "1" }],
  ["invalid alphabet", { stdoutBase64: "!!!!" }],
  [
    "decoded length",
    { stdoutBase64: "Zg==", stdoutNext: "0", stdoutBytes: "1" },
  ],
  [
    "window too large",
    {
      stdoutBase64: Buffer.alloc(65537).toString("base64"),
      stdoutNext: "65537",
      stdoutBytes: "65537",
    },
  ],
  ["next exceeds bytes", { stdoutNext: "1" }],
  ["backwards next", { stdoutOffset: "1", stdoutNext: "0" }],
  ["crossed offset", { stdoutOffset: "1", stdoutNext: "1", stdoutBytes: "1" }],
  ["noncanonical bytes", { stdoutBytes: "01" }],
  ["too many bytes", { stdoutBytes: "4194305" }],
  ["sum exceeds limit", { stdoutBytes: "4194304", stderrBytes: "1" }],
];
it.each(invalidWindows)(
  "rejects output %s after dispatch",
  async (_name, patch) => {
    const { bridge, request } = setup(
      "read",
      outcome("read", { ...observation(), ...patch }),
    );
    expect(await bridge.read(readInput, call)).toMatchObject({
      status: "unknown",
      retry: "never",
    });
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("checks stderr independently with canonical binary windows and exact maximum offsets", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const bytes = Buffer.from([0, 255, 254, 128]);
    const selected = {
      ...observation(),
      [`${stream}Offset`]: "4194300",
      [`${stream}Next`]: "4194304",
      [`${stream}Bytes`]: "4194304",
      [`${stream}Base64`]: bytes.toString("base64"),
    };
    const input = { ...readInput, [`${stream}Offset`]: "4194300" };
    expect(
      (await setup("read", outcome("read", selected)).bridge.read(input, call))
        .status,
    ).toBe("ok");
    selected[`${stream}Base64`] = "AP/+gA";
    expect(
      (await setup("read", outcome("read", selected)).bridge.read(input, call))
        .status,
    ).toBe("unknown");
  }
  const selected = {
    ...observation(),
    stdoutOffset: "4194304",
    stdoutNext: "4194304",
    stdoutBytes: "4194304",
  };
  expect(
    (
      await setup("read", outcome("read", selected)).bridge.read(
        { ...readInput, stdoutOffset: "4194304" },
        call,
      )
    ).status,
  ).toBe("ok");
});
it("accepts both exact 64KiB windows and a 4MiB combined total", async () => {
  const window = Buffer.alloc(65536, 255).toString("base64");
  const selected = {
    ...terminal(),
    stdoutBase64: window,
    stderrBase64: window,
    stdoutNext: "65536",
    stderrNext: "65536",
    stdoutBytes: "2097152",
    stderrBytes: "2097152",
    outputLimitReached: true,
  };
  const out = await setup("read", outcome("read", selected)).bridge.read(
    readInput,
    call,
  );
  expect(out.status).toBe("ok");
  expect(out.data?.state).toBe("terminal");
  expect(out.data).not.toHaveProperty("retention");
});

const invalidLifecycle: [string, Partial<ComputerConnectorProcessResult>][] = [
  ["running root waited", { rootWaited: true }],
  ["running root exit code", { exitCode: 0 }],
  ["running root signal", { exitSignal: 1 }],
  ["running group confirmed", { groupCleanup: "confirmed" }],
  ["running descendant confirmed", { descendantCleanup: "confirmed" }],
  ["running group unverified", { groupCleanup: "unverified" }],
  ["running descendant unverified", { descendantCleanup: "unverified" }],
  ["running declared terminal", { state: "terminal" }],
  ["unknown lifecycle", { state: "finished" as "terminal" }],
];
it.each(invalidLifecycle)("rejects %s", async (_name, patch) => {
  const out = await setup(
    "read",
    outcome("read", { ...observation(), ...patch }),
  ).bridge.read(readInput, call);
  expect(out.status).toBe("unknown");
  expect(out.data).toBeUndefined();
});
it.each([
  { rootWaited: false },
  { exitCode: 256 },
  { exitCode: -1 },
  { exitCode: 1.5 },
  { exitSignal: 1 },
  { groupCleanup: "pending" },
  { descendantCleanup: "pending" },
  { groupCleanup: "unverified" },
  { descendantCleanup: "unverified" },
  { outputDrained: false },
  { state: "running" },
  { retention: "durable" },
])("rejects inconsistent terminal relation %j", async (patch) => {
  const out = await setup(
    "read",
    outcome("read", { ...terminal(), ...patch }),
  ).bridge.read(readInput, call);
  expect(out.status).toBe("unknown");
  expect(out.data).toBeUndefined();
});
it.each([0, 1, 255])("accepts real exit code %s", async (exitCode) => {
  const out = await setup(
    "read",
    outcome("read", { ...terminal(), exitCode }),
  ).bridge.read(readInput, call);
  expect(out.status).toBe("ok");
  expect(out.data?.exitCode).toBe(exitCode);
});
it.each([0, 1, 128, 129])(
  "checks real exit signal %s without an exit code",
  async (exitSignal) => {
    const selected = { ...terminal(), exitSignal };
    delete selected.exitCode;
    const out = await setup("read", outcome("read", selected)).bridge.read(
      readInput,
      call,
    );
    expect(out.status).toBe(
      exitSignal >= 1 && exitSignal <= 128 ? "ok" : "unknown",
    );
  },
);
it.each([
  { ...observation(), state: "unknown" },
  { ...observation(), state: "unknown", groupCleanup: "unverified" },
  { ...terminal(), state: "unknown" },
  { ...terminal(), state: "unknown", descendantCleanup: "unverified" },
  { ...terminal(), state: "unknown", outputDrained: false },
])("preserves a valid sticky unknown observation (%j)", async (selected) => {
  const out = await setup("read", outcome("read", selected)).bridge.read(
    readInput,
    call,
  );
  expect(out).toMatchObject({
    status: "unknown",
    data: selected,
    retry: "never",
  });
});
it("unknown does not excuse an invalid root observation", async () => {
  const out = await setup(
    "read",
    outcome("read", { ...observation(), state: "unknown", rootWaited: true }),
  ).bridge.read(readInput, call);
  expect(out.status).toBe("unknown");
  expect(out.data).toBeUndefined();
});

it.each([observation(), terminal()])(
  "accepts legacy $state without a supervisor witness",
  async (selected) => {
    const out = await setup("read", outcome("read", selected)).bridge.read(
      readInput,
      call,
    );
    expect(out.status).toBe("ok");
    expect(out.data).toEqual(selected);
    expect(out.data).not.toHaveProperty("supervisorState");
  },
);
it.each([
  { ...observation(), supervisorState: "running" },
  { ...terminal(), supervisorState: "exited" },
])("accepts a consistent supervisor for $state", async (selected) => {
  const out = await setup("read", outcome("read", selected)).bridge.read(
    readInput,
    call,
  );
  expect(out.status).toBe("ok");
  expect(out.data).toEqual(selected);
});
it.each([
  { groupCleanup: "unverified", descendantCleanup: "confirmed" },
  { groupCleanup: "confirmed", descendantCleanup: "unverified" },
  { groupCleanup: "unverified", descendantCleanup: "unverified" },
] as const)("accepts exited without claiming cleanup (%j)", async (cleanup) => {
  const selected = { ...exited(), ...cleanup };
  const { bridge, request } = setup("read", outcome("read", selected));
  const out = await bridge.read(readInput, call);
  expect(out.status).toBe("ok");
  expect(out.data).toEqual(selected);
  expect(out.data?.state).toBe("exited");
  expect(out.data).not.toHaveProperty("retention");
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  { exitCode: 0 },
  { exitCode: 255 },
  { exitSignal: 1 },
  { exitSignal: 128 },
])(
  "accepts a supervised exit with valid code or signal (%j)",
  async (patch) => {
    const selected = { ...exited(), ...patch };
    if (patch.exitSignal !== undefined) delete selected.exitCode;
    const out = await setup("read", outcome("read", selected)).bridge.read(
      readInput,
      call,
    );
    expect(out.status).toBe("ok");
    expect(out.data).toEqual(selected);
  },
);

const invalidExited: [string, Record<string, unknown>][] = [
  ["running root", { rootState: "running", rootWaited: false }],
  ["root not waited", { rootWaited: false }],
  ["code out of range", { exitCode: 256 }],
  ["negative code", { exitCode: -1 }],
  ["fractional code", { exitCode: 1.5 }],
  ["code and signal", { exitCode: 0, exitSignal: 1 }],
  ["group pending", { groupCleanup: "pending" }],
  ["descendant pending", { descendantCleanup: "pending" }],
  [
    "both cleanups confirmed",
    { groupCleanup: "confirmed", descendantCleanup: "confirmed" },
  ],
  ["output undrained", { outputDrained: false }],
  ["supervisor still running", { supervisorState: "running" }],
  ["supervisor unknown", { supervisorState: "unknown" }],
];
it.each(invalidExited)("rejects exited with %s", async (_name, patch) => {
  const { bridge, request } = setup(
    "read",
    outcome("read", { ...exited(), ...patch }),
  );
  const out = await bridge.read(readInput, call);
  expect(out).toMatchObject({
    status: "unknown",
    code: "invalid_connector_process_response",
    retry: "never",
  });
  expect(out.data).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([0, 129])(
  "rejects exited with invalid signal %s",
  async (exitSignal) => {
    const selected = { ...exited(), exitSignal };
    delete selected.exitCode;
    const out = await setup("read", outcome("read", selected)).bridge.read(
      readInput,
      call,
    );
    expect(out.code).toBe("invalid_connector_process_response");
    expect(out.data).toBeUndefined();
  },
);
it("requires a supervisor witness for exited", async () => {
  const selected = { ...exited() };
  delete selected.supervisorState;
  const out = await setup("read", outcome("read", selected)).bridge.read(
    readInput,
    call,
  );
  expect(out.code).toBe("invalid_connector_process_response");
  expect(out.data).toBeUndefined();
});
it.each([
  { ...observation(), supervisorState: "unknown" },
  { ...observation(), supervisorState: "exited" },
  { ...observation(), supervisorState: "exited", outputDrained: true },
  { ...terminal(), supervisorState: "running" },
  { ...terminal(), supervisorState: "unknown" },
  { ...exited(), state: "terminal" },
])("rejects inconsistent supervisor classification (%j)", async (selected) => {
  const out = await setup("read", outcome("read", selected)).bridge.read(
    readInput,
    call,
  );
  expect(out.code).toBe("invalid_connector_process_response");
  expect(out.data).toBeUndefined();
});
it.each([
  { ...observation(), supervisorState: "running" },
  { ...observation(), supervisorState: "unknown" },
  { ...observation(), supervisorState: "unknown", groupCleanup: "unverified" },
  { ...terminal(), supervisorState: "running" },
  { ...terminal(), supervisorState: "unknown" },
  { ...terminal(), supervisorState: "exited" },
  { ...exited() },
  { ...terminal(), supervisorState: "unknown", outputDrained: false },
])(
  "preserves sticky unknown with valid supervisor facts (%j)",
  async (facts) => {
    const selected = { ...facts, state: "unknown" };
    const out = await setup("read", outcome("read", selected)).bridge.read(
      readInput,
      call,
    );
    expect(out).toMatchObject({
      status: "unknown",
      code: "PROCESS_OBSERVATION_UNKNOWN",
      data: selected,
      retry: "never",
    });
  },
);
it.each([
  { ...observation(), supervisorState: "exited" },
  { ...observation(), supervisorState: "exited", outputDrained: true },
  { ...terminal(), supervisorState: "exited", outputDrained: false },
  { ...exited(), rootWaited: false },
  { ...exited(), groupCleanup: "pending" },
  { ...exited(), descendantCleanup: "pending" },
  { ...exited(), exitCode: 256 },
])("unknown does not excuse invalid supervised facts (%j)", async (facts) => {
  const out = await setup(
    "read",
    outcome("read", { ...facts, state: "unknown" }),
  ).bridge.read(readInput, call);
  expect(out.code).toBe("invalid_connector_process_response");
  expect(out.data).toBeUndefined();
});
it.each([null, "finished", "", 0])(
  "rejects invalid optional supervisorState %j",
  async (supervisorState) => {
    const out = await setup(
      "read",
      outcome("read", { ...terminal(), state: "unknown", supervisorState }),
    ).bridge.read(readInput, call);
    expect(out.code).toBe("invalid_connector_process_response");
    expect(out.data).toBeUndefined();
  },
);

it("never invokes getters in opened, call, input, identity or response", async () => {
  const getter = vi.fn(() => {
    throw Error("must not run");
  });
  const accessor = (base: object, key: string) =>
    Object.defineProperty({ ...base }, key, { enumerable: true, get: getter });
  expect(
    () =>
      new ConnectorProcessBridge(
        { request: vi.fn() },
        accessor(opened, "execution") as ComputerConnectorOpened,
        context,
      ),
  ).toThrow(BridgeError);
  const { bridge, request } = setup("start");
  await expect(
    bridge.start(
      accessor(startInput, "command") as ConnectorProcessStartInput,
      "original",
      call,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  await expect(
    bridge.start(
      startInput,
      "original",
      accessor(call, "requestId") as typeof call,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  expect(request).not.toHaveBeenCalled();
  const peer = setup("start", accessor(outcome("start"), "data"));
  expect((await invoke(peer.bridge, "start")).status).toBe("unknown");
  expect(() =>
    connectorSupportsProcesses(
      accessor(identity(), "capabilities") as Identity,
    ),
  ).toThrow(BridgeError);
  expect(getter).not.toHaveBeenCalled();
});
it("detaches and freezes constructor, request and response data", async () => {
  const selectedOpened = structuredClone(opened);
  const selectedContext = { ...context };
  const selectedExecution = { ...selectedOpened.execution };
  const selectedReply = outcome("read");
  let reply!: (value: Outcome) => void;
  const request = vi.fn(
    (
      _method: string,
      _body: Json,
      _options?: { id?: string; operationId?: string; timeoutMs?: number },
    ) =>
      new Promise<Outcome>((resolve) => {
        reply = resolve;
      }),
  );
  const bridge = new ConnectorProcessBridge(
    { request },
    { ...selectedOpened, execution: selectedExecution },
    selectedContext,
  );
  selectedExecution.turnId = "mutated";
  selectedContext.backendGeneration = "mutated";
  const selectedInput = { ...readInput };
  const selectedCall = { ...call, context: { ...context } };
  const pending = bridge.read(selectedInput, selectedCall);
  selectedInput.handle = "mutated";
  selectedCall.context.backendGeneration = "mutated";
  reply(selectedReply as unknown as Outcome);
  const out = await pending;
  (selectedReply.data as Record<string, unknown>).handle = "mutated";
  (selectedReply.context as Record<string, unknown>).backendGeneration =
    "mutated";
  expect(out).toMatchObject({
    status: "ok",
    context,
    data: { handle: "handle", execution: opened.execution },
  });
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    handle: "handle",
    execution: opened.execution,
  });
  expect(Object.isFrozen(request.mock.calls[0]?.[1])).toBe(true);
  expect(Object.isFrozen(out.data)).toBe(true);
});
it.each([
  null,
  [],
  new Date(),
  Object.create({ command: "inherited" }),
  { ...startInput, cycle: undefined },
])("refuses non-JSON or non-plain input %j without dispatch", async (input) => {
  const { bridge, request } = setup("start");
  await expect(
    bridge.start(input as ConnectorProcessStartInput, "original", call),
  ).rejects.toMatchObject({ state: "refused" });
  expect(request).not.toHaveBeenCalled();
});
it("never invokes accessors on a transport exception", async () => {
  const getter = vi.fn(() => "private exception text");
  const error = Object.defineProperty(
    new BridgeError("unknown", "response_timeout"),
    "code",
    { get: getter },
  );
  const { bridge, request } = setup("start");
  request.mockRejectedValueOnce(error);
  expect(await invoke(bridge, "start")).toMatchObject({
    status: "unknown",
    code: "invalid_connector_process_response",
    retry: "never",
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(getter).not.toHaveBeenCalled();
});
it("bounds cyclic and oversized response snapshots", async () => {
  const cycle = outcome("start");
  cycle.data = cycle;
  for (const selected of [
    cycle,
    { ...outcome("start"), data: "x".repeat(1048577) },
  ]) {
    const { bridge, request } = setup("start", selected);
    expect((await invoke(bridge, "start")).status).toBe("unknown");
    expect(request).toHaveBeenCalledTimes(1);
  }
});
it("refuses crossed and zero-generation bindings", () => {
  for (const binding of [
    { ...opened.endpoint.binding, backendGeneration: "other" },
    { ...opened.endpoint.binding, connectorGeneration: "0" },
  ]) {
    expect(
      () =>
        new ConnectorProcessBridge(
          { request: vi.fn() },
          { ...opened, endpoint: { ...opened.endpoint, binding } },
          context,
        ),
    ).toThrow(BridgeError);
  }
});
function identity(
  capabilities: string[] = [...connectorProcessMethods],
): Identity {
  return {
    ...context,
    buildId: "build",
    protocolMajor,
    protocolMinor,
    maxFrameBytes,
    capabilities,
  };
}
it("accepts only the complete process capability slice, with no discovery", () => {
  expect(connectorSupportsProcesses(identity())).toBe(true);
  expect(
    connectorSupportsProcesses(
      identity(["core.status", ...connectorProcessMethods]),
    ),
  ).toBe(true);
  expect(connectorSupportsProcesses(identity([]))).toBe(false);
  expect(connectorSupportsProcesses(identity(["core.status"]))).toBe(false);
  for (const selected of [[0], [1], [2], [0, 1], [0, 2], [1, 2]]) {
    expect(() =>
      connectorSupportsProcesses(
        identity(selected.map((index) => connectorProcessMethods[index]!)),
      ),
    ).toThrow(BridgeError);
  }
  expect(() =>
    connectorSupportsProcesses(
      identity([...connectorProcessMethods, connectorProcessMethods[0]!]),
    ),
  ).toThrow(BridgeError);
  expect(Object.isFrozen(connectorProcessMethods)).toBe(true);
});
