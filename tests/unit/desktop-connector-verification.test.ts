import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ConnectorVerificationBridge } from "../../apps/desktop/bridge/connector-verification";
import type {
  ComputerConnectorVerificationReceipt,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const binding = {
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  runtimeId: "runtime",
  connectorGeneration: "9007199254740993",
};
const execution = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "scope",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
};
const context = { profileId: "profile", backendGeneration: "backend" };
const opened = {
  endpoint: {
    binding,
    socketPath: "/private/tmp/farol-mcp-123/computer.sock",
    token: "a".repeat(64),
  },
  execution,
  admissionOperationId: "original",
};
function fixture() {
  const receipt: ComputerConnectorVerificationReceipt = {
    binding,
    execution,
    challengeSha256: hash("challenge"),
    workspaceId: "workspace",
    callIdSha256: hash("original-call"),
    entryCount: 2,
    truncated: false,
  };
  const state = {
    binding,
    receipt,
    receiptSha256: hash(JSON.stringify(receipt)),
  };
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options?: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options!.id!,
      context,
      data: state as unknown as Json,
    }),
  );
  return {
    receipt,
    state,
    request,
    bridge: new ConnectorVerificationBridge(
      { request },
      opened,
      hash("challenge"),
    ),
  };
}
it("observes exact Go proof and retains its original call on repeated verification", async () => {
  const f = fixture();
  expect(await f.bridge.observe()).toEqual(f.state);
  const result = await f.bridge.verify("challenge", "workspace", "later-call");
  expect(result.receipt?.callIdSha256).toBe(hash("original-call"));
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    "computer.connector.verification",
    "computer.connector.verify",
  ]);
  expect(Object.isFrozen(result.receipt?.execution)).toBe(true);
});
it("distinguishes known absence from a successful verification", async () => {
  const f = fixture();
  f.request.mockImplementation(async (_m, _b, options) => ({
    status: "ok",
    requestId: options!.id!,
    context,
    data: { binding },
  }));
  expect((await f.bridge.observe()).receipt).toBeUndefined();
  await expect(
    f.bridge.verify("challenge", "workspace", "call"),
  ).rejects.toMatchObject({ state: "unknown" });
});
it.each([
  "request",
  "context",
  "operation",
  "binding",
  "execution",
  "challenge",
  "digest",
  "count",
  "missing-receipt",
  "missing-digest",
])("rejects crossed %s proof without retry", async (mode) => {
  const f = fixture(),
    original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    const response = structuredClone(await original(...args));
    const data = response.data as unknown as typeof f.state;
    if (mode === "binding") data.binding = { ...binding, runtimeId: "other" };
    if (mode === "execution")
      data.receipt = {
        ...data.receipt,
        execution: { ...execution, turnId: "other" },
      };
    if (mode === "challenge")
      data.receipt = { ...data.receipt, challengeSha256: hash("other") };
    if (mode === "count") data.receipt = { ...data.receipt, entryCount: 501 };
    if (mode === "digest") data.receiptSha256 = "0".repeat(64);
    if (mode === "missing-receipt")
      delete (data as Partial<typeof data>).receipt;
    if (mode === "missing-digest")
      delete (data as Partial<typeof data>).receiptSha256;
    return {
      ...response,
      ...(mode === "request" ? { requestId: "other" } : {}),
      ...(mode === "operation" ? { operationId: "unexpected" } : {}),
      ...(mode === "context"
        ? { context: { ...context, backendGeneration: "other" } }
        : {}),
    };
  });
  await expect(f.bridge.observe()).rejects.toMatchObject({ state: "unknown" });
  expect(f.request).toHaveBeenCalledTimes(1);
});
it("refuses malformed input before any backend request", async () => {
  const f = fixture();
  await expect(
    f.bridge.verify("white space", "workspace", "call"),
  ).rejects.toMatchObject({ state: "refused" });
  expect(f.request).not.toHaveBeenCalled();
});
it.each(["old-runtime-challenge", "invented-challenge"])(
  "refuses %s as a challenge mismatch before backend IO",
  async (challenge) => {
    const f = fixture();
    await expect(
      f.bridge.verify(challenge, "workspace", "new-call"),
    ).rejects.toMatchObject({
      state: "refused",
      code: "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH",
    });
    expect(f.request).not.toHaveBeenCalled();
  },
);
it("preserves a backend refusal and never fabricates a receipt", async () => {
  const f = fixture();
  f.request.mockImplementation(async (_m, _b, options) => ({
    status: "unavailable",
    requestId: options!.id!,
    context,
    code: "owner_unavailable",
  }));
  await expect(f.bridge.observe()).rejects.toMatchObject({
    state: "unavailable",
    code: "owner_unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(1);
});
