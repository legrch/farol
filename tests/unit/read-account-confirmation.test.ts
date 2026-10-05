import { describe, expect, it, vi } from "vitest";
import { ReadAccountConfirmation } from "../../apps/desktop/read-account-confirmation.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type { ChatReadIntentAccountApprove } from "../../apps/desktop/bridge/wire.ts";
import type { BoundChatGptAccountObservation } from "../../apps/desktop/chatgpt-account-observation.ts";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
} from "../../src/pkg/product-settings/contract.ts";

// UI-to-host correlation with injected physical-read/Go transport ports. This
// fixture does not prove a Go grant, real WebContentsView or provider identity.
function fixture() {
  let current = true;
  const admission = {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    generation: "1",
    admissionOperationId: "original-read",
    storeRevision: "10",
  };
  const observation: BoundChatGptAccountObservation = {
    binding: {
      viewId: "17",
      viewGeneration: 1,
      documentGeneration: 1,
      partition: "persist:farol-dev-chatgpt",
      phase: "home",
      url: "https://chatgpt.com/",
      conversationId: null,
    },
    account: {
      state: "observed",
      source: "provider-session-v1",
      accountKey: "c".repeat(64),
      observedAtMillis: 1000,
      expiresAtMillis: 10000,
      documentUrl: "https://chatgpt.com/",
    },
  };
  const read = vi.fn(async (): Promise<BoundChatGptAccountObservation | null> =>
    structuredClone(observation),
  );
  const approve = vi.fn(async (request: ChatReadIntentAccountApprove) => ({
    admission: structuredClone(request.admission),
    approvalId: "go-grant",
    principalKey: request.confirmedPrincipalKey,
  }));
  const confirmation = new ReadAccountConfirmation({
    admission,
    read,
    approve,
    current: () => current,
  });
  return {
    admission,
    observation,
    read,
    approve,
    confirmation,
    withdraw: () => {
      current = false;
    },
  };
}
describe("explicit read account confirmation", () => {
  it("exposes only named confirmation commands and safe preview metadata to the renderer", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const command = {
      kind: "chatgpt.approve-readonly-account",
      operationId: id,
      confirmationId: id,
    };
    expect(ProductConfigurationCommandSchema.safeParse(command).success).toBe(
      true,
    );
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.inspect-readonly-account",
        operationId: id,
      }).success,
    ).toBe(true);
    for (const extra of [
      { accountKey: "c".repeat(64) },
      { observation: {} },
      { approvalId: id },
      { admission: {} },
      { script: "arbitrary" },
    ])
      expect(
        ProductConfigurationCommandSchema.safeParse({ ...command, ...extra })
          .success,
      ).toBe(false);
    const preview = {
      kind: "chatgpt.readonly-task-preview",
      operationId: id,
      workspaceId: id,
      workspaceLabel: "Work",
      relativePath: "note.txt",
      bytes: 10,
      contextCharacters: 10,
      contextLimit: 24000,
      contextTruncated: false,
      excludedPaths: [],
      expiresAt: "2026-10-04T20:00:00.000Z",
      account: { confirmationId: id, state: "observed" },
    };
    expect(ProductConfigurationEvidenceSchema.safeParse(preview).success).toBe(
      true,
    );
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        ...preview,
        account: { ...preview.account, principalKey: "c".repeat(64) },
      }).success,
    ).toBe(false);
  });
  it("separates inspection, explicit confirmation, fresh observation and Go approval", async () => {
    const f = fixture();
    expect(f.confirmation.projection()).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([
      f.confirmation.inspect(),
      f.confirmation.inspect(),
    ]);
    expect(a).toEqual(b);
    expect(a.state).toBe("observed");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.approve).not.toHaveBeenCalled();
    f.observation.account.observedAtMillis = 2000;
    const [first, second] = await Promise.all([
      f.confirmation.confirm(a.confirmationId),
      f.confirmation.confirm(a.confirmationId),
    ]);
    expect(first).toEqual({ ...a, state: "approved" });
    expect(second).toEqual(first);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.approve).toHaveBeenCalledExactlyOnceWith({
      admission: f.admission,
      confirmedPrincipalKey: "c".repeat(64),
      observation: {
        state: "observed",
        source: "provider-session-v1",
        principalKey: "c".repeat(64),
        observedAtMillis: "2000",
        expiresAtMillis: "10000",
      },
    });
    Reflect.set(first, "state", "observed");
    expect(f.confirmation.projection()?.state).toBe("approved");
    expect(await f.confirmation.confirm(a.confirmationId)).toEqual(second);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("does not accept a renderer-invented confirmation or approve before inspection", async () => {
    const f = fixture();
    await expect(f.confirmation.confirm("invented")).rejects.toMatchObject({
      state: "refused",
      code: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
    });
    const view = await f.confirmation.inspect();
    await expect(
      f.confirmation.confirm(`${view.confirmationId}-other`),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each([
    "account",
    "document",
    "view",
    "partition",
    "missing",
    "withdraw-before",
    "withdraw-during",
  ])(
    "refuses %s without Go approval or repeated observation",
    async (variant) => {
      const f = fixture();
      const view = await f.confirmation.inspect();
      if (variant === "account")
        f.observation.account.accountKey = "d".repeat(64);
      if (variant === "document")
        Reflect.set(f.observation.binding, "documentGeneration", 2);
      if (variant === "view")
        Reflect.set(f.observation.binding, "viewId", "other");
      if (variant === "partition")
        Reflect.set(
          f.observation.binding,
          "partition",
          "persist:farol-next-chatgpt",
        );
      if (variant === "missing") f.read.mockResolvedValueOnce(null);
      if (variant === "withdraw-before") f.withdraw();
      if (variant === "withdraw-during")
        f.read.mockImplementationOnce(async () => {
          f.withdraw();
          return f.observation;
        });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({ state: "refused" });
      const reads = f.read.mock.calls.length;
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.read).toHaveBeenCalledTimes(reads);
      expect(f.approve).not.toHaveBeenCalled();
      expect(f.confirmation.projection()?.state).toBe("observed");
    },
  );
  it.each(["unknown", "refused", "unavailable"] as const)(
    "retains the original %s Go outcome",
    async (state) => {
      const f = fixture();
      const view = await f.confirmation.inspect();
      const error = new BridgeError(state, "original-approval-outcome");
      f.approve.mockRejectedValueOnce(error);
      await expect(f.confirmation.confirm(view.confirmationId)).rejects.toBe(
        error,
      );
      await expect(f.confirmation.confirm(view.confirmationId)).rejects.toBe(
        error,
      );
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.approve).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["late-withdraw", "crossed-admission", "crossed-principal"])(
    "keeps %s after Go approval unknown and does not repeat",
    async (variant) => {
      const f = fixture();
      const view = await f.confirmation.inspect();
      f.approve.mockImplementationOnce(async (input) => {
        if (variant === "late-withdraw") f.withdraw();
        return {
          admission: {
            ...input.admission,
            ...(variant === "crossed-admission" ? { taskId: "other" } : {}),
          },
          approvalId: "original-grant",
          principalKey:
            variant === "crossed-principal"
              ? "d".repeat(64)
              : input.confirmedPrincipalKey,
        };
      });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
      });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.approve).toHaveBeenCalledTimes(1);
      expect(f.confirmation.projection()?.state).toBe("observed");
    },
  );
  it("pins the original read admission against later caller mutation", async () => {
    const f = fixture();
    const original = structuredClone(f.admission);
    f.admission.taskId = "replacement";
    const view = await f.confirmation.inspect();
    await f.confirmation.confirm(view.confirmationId);
    expect(f.approve.mock.calls[0]![0].admission).toEqual(original);
  });
  it("retains an unavailable inspection without another read or invented confirmation", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(null);
    await expect(f.confirmation.inspect()).rejects.toMatchObject({
      code: "CHATGPT_ACCOUNT_UNAVAILABLE",
    });
    await expect(f.confirmation.inspect()).rejects.toMatchObject({
      code: "CHATGPT_ACCOUNT_UNAVAILABLE",
    });
    expect(f.confirmation.projection()).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.approve).not.toHaveBeenCalled();
  });
  it("keeps invalid wrapper commands outside the original approval attempt", async () => {
    const f = fixture();
    await expect(f.confirmation.confirm("invented")).rejects.toMatchObject({
      state: "refused",
    });
    const view = await f.confirmation.inspect();
    await expect(f.confirmation.confirm("invented")).rejects.toMatchObject({
      state: "refused",
    });
    expect(await f.confirmation.confirm(view.confirmationId)).toEqual({
      ...view,
      state: "approved",
    });
    expect(f.approve).toHaveBeenCalledTimes(1);
  });
  it.each(["admission", "principal"] as const)(
    "does not let approval-port mutation of %s replace the pinned expectation",
    async (variant) => {
      const f = fixture();
      const view = await f.confirmation.inspect();
      f.approve.mockImplementationOnce(async (request) => {
        if (variant === "admission")
          Reflect.set(request.admission, "taskId", "replacement");
        else Reflect.set(request, "confirmedPrincipalKey", "d".repeat(64));
        return {
          admission: request.admission,
          approvalId: "crossed-grant",
          principalKey: request.confirmedPrincipalKey,
        };
      });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({
        state: "unknown",
        code: "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
      });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.confirmation.projection()?.state).toBe("observed");
      expect(f.approve).toHaveBeenCalledTimes(1);
    },
  );
});
