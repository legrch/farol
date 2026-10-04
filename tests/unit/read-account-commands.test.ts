import { describe, expect, it, vi } from "vitest";
import {
  ReadAccountCommands,
  readAccountFailure,
  type ReadAccountCommand,
} from "../../apps/desktop/read-account-commands.ts";
import { ReadAccountConfirmation } from "../../apps/desktop/read-account-confirmation.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type { ProductConfigurationResult } from "../../src/pkg/product-settings/contract.ts";
import {
  classifyConfigurationResponse,
  configurationEffectOutcome,
} from "../../src/ui/configuration-outcome.ts";

const snapshot = { status: "error", error: "SETTINGS_CORRUPT" } as const;
const failure = (
  error: Extract<ProductConfigurationResult, { ok: false }>["error"],
): ProductConfigurationResult => ({ ok: false, snapshot, error });
const approve: ReadAccountCommand = {
  kind: "chatgpt.approve-readonly-account",
  operationId: "original-preview",
  confirmationId: "original-confirmation",
};
const inspect: ReadAccountCommand = {
  kind: "chatgpt.inspect-readonly-account",
  operationId: "original-preview",
};

describe("retained account IPC replies", () => {
  it("retains an unknown approval before fresh current checks after expiry/retirement", async () => {
    let current = true;
    const read = vi.fn(async () => ({
      binding: {
        viewId: "1",
        viewGeneration: 1,
        documentGeneration: 1,
        partition: "persist:farol-dev-chatgpt" as const,
        phase: "home" as const,
        url: "https://chatgpt.com/",
        conversationId: null,
      },
      account: {
        state: "observed" as const,
        source: "provider-session-v1" as const,
        accountKey: "c".repeat(64),
        documentUrl: "https://chatgpt.com/",
        observedAtMillis: 1000,
        expiresAtMillis: 10000,
      },
    }));
    const rpc = vi.fn(async () => {
      throw new BridgeError("unknown", "ack_lost");
    });
    const confirmation = new ReadAccountConfirmation({
      current: () => current,
      read,
      approve: rpc,
      admission: {
        ownerId: "owner",
        sessionId: "session",
        taskId: "task",
        taskEpoch: "1",
        participantId: "participant",
        turnId: "turn",
        generation: "1",
        admissionOperationId: "read",
        storeRevision: "1",
      },
    });
    const observed = await confirmation.inspect();
    const command = { ...approve, confirmationId: observed.confirmationId };
    const dispatch = vi.fn(async () => {
      if (!current) return failure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
      try {
        await confirmation.confirm(command.confirmationId);
        return { ok: true as const, snapshot };
      } catch (error) {
        return failure(readAccountFailure(command, error));
      }
    });
    const replies = new ReadAccountCommands();
    const first = await replies.run(command, dispatch, failure);
    current = false;
    const repeated = await replies.run(command, dispatch, failure);
    expect(first).toEqual(failure("CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED"));
    expect(repeated).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(
      configurationEffectOutcome(
        classifyConfigurationResponse({
          settled: "fulfilled",
          value: repeated,
        }),
      ),
    ).toBe("unknown");
  });
  it.each(["unavailable", "refused", "unknown"] as const)(
    "classifies %s before retention without changing the original outcome",
    async (state) => {
      const replies = new ReadAccountCommands();
      let writes = 0;
      const dispatch = vi.fn(async () => {
        if (state === "unknown") writes++;
        return failure(
          readAccountFailure(approve, new BridgeError(state, "backend")),
        );
      });
      const result = await replies.run(approve, dispatch, failure);
      const effect = configurationEffectOutcome(
        classifyConfigurationResponse({ settled: "fulfilled", value: result }),
      );
      expect(effect).toBe(state === "unknown" ? "unknown" : "refused");
      expect(writes).toBe(state === "unknown" ? 1 : 0);
      expect(await replies.run(approve, dispatch, failure)).toEqual(result);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("latches concurrent calls, refuses changed confirmation, and detaches every reply", async () => {
    const replies = new ReadAccountCommands();
    const dispatch = vi.fn(async (): Promise<ProductConfigurationResult> => ({
      ok: true,
      snapshot,
    }));
    const [a, b] = await Promise.all([
      replies.run(approve, dispatch, failure),
      replies.run(approve, dispatch, failure),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    Reflect.set(a, "ok", false);
    expect(await replies.run(approve, dispatch, failure)).toEqual(b);
    expect(
      await replies.run(
        { ...approve, confirmationId: "different" },
        dispatch,
        failure,
      ),
    ).toEqual(failure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    await replies.run(inspect, dispatch, failure);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("retains unexpected thrown outcomes instead of repeating the dispatcher", async () => {
    const replies = new ReadAccountCommands();
    const error = new Error("unexpected");
    const dispatch = vi.fn(async () => {
      throw error;
    });
    await expect(replies.run(approve, dispatch, failure)).rejects.toBe(error);
    await expect(replies.run(approve, dispatch, failure)).rejects.toBe(error);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("refuses bounded exhaustion without evicting old unknown outcomes", async () => {
    const replies = new ReadAccountCommands();
    const dispatch = vi.fn(async () =>
      failure("CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED"),
    );
    for (let i = 0; i < 1024; i++)
      await replies.run(
        { ...approve, operationId: `op-${i}` },
        dispatch,
        failure,
      );
    expect(await replies.run(approve, dispatch, failure)).toEqual(
      failure("CHATGPT_ACCOUNT_UNAVAILABLE"),
    );
    expect(
      await replies.run({ ...approve, operationId: "op-0" }, dispatch, failure),
    ).toEqual(failure("CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED"));
    expect(dispatch).toHaveBeenCalledTimes(1024);
  });
});
