import { describe, expect, it, vi } from "vitest";
import { AccountObservationConfirmation } from "../../apps/desktop/account-observation-confirmation.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type { BrowserAccountObservation } from "../../apps/desktop/bridge/wire.ts";
import type { BoundChatGptAccountObservation } from "../../apps/desktop/chatgpt-account-observation.ts";

// Mechanical correlation with injected reads and commit. These fixtures prove
// neither a real browser/provider observation nor account authority.
function fixture() {
  let current = true;
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
  const result = { selected: { principal: "c".repeat(64) }, state: "ready" };
  const read = vi.fn(
    async (): Promise<BoundChatGptAccountObservation | null> => observation,
  );
  const commit = vi.fn(
    async (_input: {
      confirmedPrincipalKey: string;
      observation: BrowserAccountObservation;
    }) => result,
  );
  const isCurrent = vi.fn(() => current);
  const confirmation = new AccountObservationConfirmation({
    read,
    commit,
    current: isCurrent,
  });
  return {
    observation,
    result,
    read,
    commit,
    isCurrent,
    confirmation,
    withdraw: () => {
      current = false;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("account observation confirmation", () => {
  it("retains in-flight reads and commits before callbacks can reenter", async () => {
    const f = fixture();
    const reading = deferred<BoundChatGptAccountObservation | null>();
    let reenteredInspection: ReturnType<typeof f.confirmation.inspect>;
    f.read.mockImplementationOnce(() => {
      reenteredInspection = f.confirmation.inspect();
      return reading.promise;
    });
    const a = f.confirmation.inspect();
    const b = f.confirmation.inspect();
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(1);
    reading.resolve(f.observation);
    const view = await a;
    expect(await b).toEqual(view);
    expect(await reenteredInspection!).toEqual(view);
    expect(view).toEqual({
      confirmationId: expect.any(String),
      state: "observed",
    });
    expect(f.commit).not.toHaveBeenCalled();
    const committing = deferred<typeof f.result>();
    let reenteredConfirmation: ReturnType<typeof f.confirmation.confirm>;
    f.commit.mockImplementationOnce(() => {
      reenteredConfirmation = f.confirmation.confirm(view.confirmationId);
      return committing.promise;
    });
    const first = f.confirmation.confirm(view.confirmationId);
    const second = f.confirmation.confirm(view.confirmationId);
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1));
    committing.resolve(f.result);
    expect(await first).toEqual(f.result);
    expect(await second).toEqual(f.result);
    expect(await reenteredConfirmation!).toEqual(f.result);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.isCurrent).toHaveBeenCalledTimes(5);
  });

  it("uses fresh timestamps with only detached observation and principal input", async () => {
    const f = fixture();
    const view = await f.confirmation.inspect();
    f.observation.account.observedAtMillis = 2000;
    f.observation.account.expiresAtMillis = 12000;
    await f.confirmation.confirm(view.confirmationId);
    expect(f.commit).toHaveBeenCalledExactlyOnceWith({
      confirmedPrincipalKey: "c".repeat(64),
      observation: {
        state: "observed",
        source: "provider-session-v1",
        principalKey: "c".repeat(64),
        observedAtMillis: "2000",
        expiresAtMillis: "12000",
      },
    });
    Reflect.set(
      f.commit.mock.calls[0]![0].observation,
      "principalKey",
      "changed",
    );
    expect(f.observation.account.accountKey).toBe("c".repeat(64));
    expect(await f.confirmation.inspect()).toEqual(view);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("detaches inspection, consumer result and every returned result", async () => {
    const f = fixture();
    const view = await f.confirmation.inspect();
    const id = view.confirmationId;
    Reflect.set(view, "confirmationId", "invented");
    expect((await f.confirmation.inspect()).confirmationId).toBe(id);
    const expected = structuredClone(f.result);
    const [first, second] = await Promise.all([
      f.confirmation.confirm(id),
      f.confirmation.confirm(id),
    ]);
    first.selected.principal = "caller-mutation";
    f.result.selected.principal = "consumer-mutation";
    expect(second).toEqual(expected);
    expect(await f.confirmation.confirm(id)).toEqual(expected);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("accepts only the original object's ID, including after a successful commit", async () => {
    const f = fixture();
    const other = fixture();
    const view = await f.confirmation.inspect();
    const otherView = await other.confirmation.inspect();
    await expect(
      other.confirmation.confirm(view.confirmationId),
    ).rejects.toMatchObject({ code: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID" });
    // The first invalid attempt is retained even after the real ID is supplied.
    await expect(
      other.confirmation.confirm(otherView.confirmationId),
    ).rejects.toMatchObject({ state: "refused" });
    expect(other.read).toHaveBeenCalledTimes(1);
    expect(other.commit).not.toHaveBeenCalled();
    await f.confirmation.confirm(view.confirmationId);
    await expect(
      f.confirmation.confirm(otherView.confirmationId),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("cannot turn a confirmation invoked before inspection into a later commit", async () => {
    const f = fixture();
    const inspecting = f.confirmation.inspect();
    const confirming = f.confirmation.confirm("invented");
    await expect(confirming).rejects.toMatchObject({ state: "refused" });
    const view = await inspecting;
    await expect(
      f.confirmation.confirm(view.confirmationId),
    ).rejects.toMatchObject({ code: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID" });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "account",
      (o: BoundChatGptAccountObservation) => {
        o.account.accountKey = "d".repeat(64);
      },
    ],
    [
      "view",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "viewId", "other");
      },
    ],
    [
      "view-generation",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "viewGeneration", 2);
      },
    ],
    [
      "document-generation",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "documentGeneration", 2);
      },
    ],
    [
      "partition",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "partition", "persist:other");
      },
    ],
    [
      "phase",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "phase", "conversation");
      },
    ],
    [
      "url",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "url", "https://chatgpt.com/c/other");
      },
    ],
    [
      "conversation",
      (o: BoundChatGptAccountObservation) => {
        Reflect.set(o.binding, "conversationId", "other");
      },
    ],
  ] as const)(
    "refuses a changed %s against the cloned inspection",
    async (_name, mutate) => {
      const f = fixture();
      const view = await f.confirmation.inspect();
      mutate(f.observation);
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({
        state: "refused",
        code: "CHATGPT_ACCOUNT_CHANGED",
      });
      await expect(
        f.confirmation.confirm(view.confirmationId),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["inspect", "confirm"] as const)(
    "retains a missing %s observation",
    async (phase) => {
      const f = fixture();
      const id =
        phase === "confirm"
          ? (await f.confirmation.inspect()).confirmationId
          : "";
      f.read.mockResolvedValueOnce(null);
      const attempt = () =>
        phase === "inspect"
          ? f.confirmation.inspect()
          : f.confirmation.confirm(id);
      await expect(attempt()).rejects.toMatchObject({
        code: "CHATGPT_ACCOUNT_UNAVAILABLE",
      });
      await expect(attempt()).rejects.toMatchObject({
        code: "CHATGPT_ACCOUNT_UNAVAILABLE",
      });
      expect(f.read).toHaveBeenCalledTimes(phase === "inspect" ? 1 : 2);
      expect(f.commit).not.toHaveBeenCalled();
    },
  );

  it.each(["inspect", "confirm"] as const)(
    "rechecks current before and after the %s read",
    async (phase) => {
      for (const timing of ["before", "during"] as const) {
        const f = fixture();
        const id =
          phase === "confirm"
            ? (await f.confirmation.inspect()).confirmationId
            : "";
        const priorReads = f.read.mock.calls.length;
        if (timing === "before") f.withdraw();
        else
          f.read.mockImplementationOnce(async () => {
            f.withdraw();
            return f.observation;
          });
        const attempt = () =>
          phase === "inspect"
            ? f.confirmation.inspect()
            : f.confirmation.confirm(id);
        await expect(attempt()).rejects.toMatchObject({
          state: "refused",
          code: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
        });
        await expect(attempt()).rejects.toMatchObject({ state: "refused" });
        expect(f.read).toHaveBeenCalledTimes(
          priorReads + (timing === "during" ? 1 : 0),
        );
        expect(f.commit).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["refused", "unknown", "unavailable"] as const)(
    "retains original %s errors from both reads and commit",
    async (state) => {
      for (const port of ["inspection", "fresh-read", "commit"] as const) {
        const f = fixture();
        const id =
          port === "inspection"
            ? ""
            : (await f.confirmation.inspect()).confirmationId;
        const error = new BridgeError(state, "original-outcome");
        // A synchronous throw also occurs only after the attempt was retained.
        if (port === "commit")
          f.commit.mockImplementationOnce(() => {
            throw error;
          });
        else
          f.read.mockImplementationOnce(() => {
            throw error;
          });
        const attempt = () =>
          port === "inspection"
            ? f.confirmation.inspect()
            : f.confirmation.confirm(id);
        await expect(attempt()).rejects.toBe(error);
        await expect(attempt()).rejects.toBe(error);
        expect(f.read).toHaveBeenCalledTimes(port === "inspection" ? 1 : 2);
        expect(f.commit).toHaveBeenCalledTimes(port === "commit" ? 1 : 0);
      }
    },
  );

  it("keeps a current mismatch after commit unknown without another attempt", async () => {
    const f = fixture();
    const view = await f.confirmation.inspect();
    f.commit.mockImplementationOnce(async () => {
      f.withdraw();
      return f.result;
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
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});
