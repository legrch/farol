import { describe, expect, it, vi } from "vitest";
import { ContinuityBridge } from "./continuity";
import { RequestNotSentError, type Client } from "./client";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = { profileId: "profile", backendGeneration: "backend" };
const digest = "a".repeat(64);
const binding = { device: "16", inode: "42" };
const observation = {
  schema: "farol.workspace-continuity/1",
  volumeUuid: "11111111-2222-3333-4444-555555555555",
  fileId: "42",
  birthSeconds: "1700000000",
  birthNanoseconds: "0",
};
const confirmation = {
  operationId,
  computerId: "computer",
  workspaceId: "workspace",
  root: "/approved/workspace",
  rootIdentity: binding,
  expectedRevision: "5",
  expectedGeneration: "7",
  expectedConsentSha256: digest,
  continuity: observation,
};
const receipt = (phase: string) => ({
  effectId: `${operationId}_${phase}`,
  digest,
});

const cases = [
  [
    "begin",
    (bridge: ContinuityBridge) =>
      bridge.begin({
        operationId,
        mode: "legacy-confirm",
        savedBinding: binding,
      }),
    { operationId, admitted: true, priorPhase: "intent" },
    { operationId: otherId, admitted: true, priorPhase: "intent" },
  ],
  [
    "confirm",
    (bridge: ContinuityBridge) =>
      bridge.confirm({
        operationId,
        ownerPicked: true,
        selectedRoot: confirmation.root,
      }),
    confirmation,
    { ...confirmation, continuity: { ...observation, fileId: "43" } },
  ],
  [
    "plan",
    (bridge: ContinuityBridge) =>
      bridge.plan({ operationId, phase: "withdraw_intent" }),
    receipt("withdraw_intent"),
    receipt("settings_intent"),
  ],
  [
    "record",
    (bridge: ContinuityBridge) =>
      bridge.record({
        operationId,
        phase: "withdraw_intent",
        receipt: receipt("withdraw_intent"),
      }),
    { operationId, phase: "withdraw_intent" },
    { operationId, phase: "settings_intent" },
  ],
  [
    "withdraw",
    (bridge: ContinuityBridge) => bridge.withdraw(operationId),
    receipt("withdraw_intent"),
    receipt("settings_intent"),
  ],
  [
    "stage",
    (bridge: ContinuityBridge) => bridge.stage(operationId),
    receipt("publish_intent"),
    receipt("close_intent"),
  ],
  [
    "finish",
    (bridge: ContinuityBridge) =>
      bridge.finish({ operationId, kind: "committed" }),
    { operationId, phase: "committed" },
    { operationId, phase: "refused" },
  ],
  [
    "qualify",
    (bridge: ContinuityBridge) => bridge.qualify(operationId),
    { operationId, qualified: true },
    { operationId, qualified: false },
  ],
] as const;

function fixture(makeReply: (envelope: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (_method, _body, options) =>
    makeReply({
      requestId: options.id,
      context,
      ...(options.operationId ? { operationId: options.operationId } : {}),
    }),
  );
  const bridge = new ContinuityBridge({
    request,
    verifiedContext: context,
  } as unknown as Client);
  return { request, bridge };
}

describe("owner-only continuity bridge", () => {
  it.each(cases)(
    "correlates the original %s request and strictly checks its reply",
    async (method, invoke, data, crossed) => {
      const scenarios = [
        [
          (envelope: object) => ({ ...envelope, status: "ok", data }),
          { state: "acknowledged", value: data },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "refused",
            code: "computer_continuity_refused",
          }),
          { state: "refused" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "unknown",
            code: "owner_outcome_unknown",
          }),
          { state: "unknown" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "unavailable",
            code: "computer_continuity_current_unavailable",
          }),
          { state: "unavailable" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "refused",
            code: "refused",
            data,
          }),
          { state: "unknown" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "ok",
            data: { ...data, unexpected: true },
          }),
          { state: "unknown" },
        ],
        [
          (envelope: object) => ({ ...envelope, status: "ok", data: crossed }),
          { state: "unknown" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "ok",
            data,
            requestId: otherId,
          }),
          { state: "unknown" },
        ],
        [
          (envelope: object) => ({
            ...envelope,
            status: "ok",
            data,
            context: { ...context, backendGeneration: "foreign" },
          }),
          { state: "unknown" },
        ],
        [
          () => {
            throw Error("pipe closed");
          },
          { state: "unknown" },
        ],
        [
          () => {
            throw new RequestNotSentError();
          },
          { state: "refused" },
        ],
      ] as const;
      for (const [makeReply, expected] of scenarios) {
        const { bridge, request } = fixture(makeReply);
        expect(await invoke(bridge)).toEqual(expected);
        expect(request).toHaveBeenCalledTimes(1);
        const [name, body, envelope] = request.mock.calls[0]!;
        expect(name).toBe(`computer.continuity.${method}`);
        expect(body.operationId).toBe(operationId);
        if (method === "plan") expect(envelope.operationId).toBeUndefined();
        else if (method === "begin")
          expect(envelope.operationId).toBe(operationId);
        else expect(envelope.operationId).not.toBe(operationId);
      }
    },
  );

  it("rejects invalid arguments before sending a request", async () => {
    const { bridge, request } = fixture(() => {
      throw Error("unexpected send");
    });
    expect(await bridge.stage("foreign")).toEqual({ state: "refused" });
    expect(request).not.toHaveBeenCalled();
  });
});
