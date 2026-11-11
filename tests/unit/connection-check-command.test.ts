import { expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import {
  runExplicitConnectionCheck,
  ConnectionCheckRefusal,
  connectionCheckDigest,
  connectionCheckRuntimeReady,
  type ConnectionCheckBrowser,
} from "../../apps/desktop/connection-check-command.ts";
import type {
  ComputerCheckPrepareRequest,
  ComputerCheckPrepareResponse,
  ComputerCheckObserveResponse,
  ComputerCheckAdvanceRequest,
  ComputerCheckAdvanceResponse,
} from "../../apps/desktop/bridge/wire.ts";

it("does not treat an unresolved connector start as a live connection", () => {
  expect(connectionCheckRuntimeReady(null)).toBe(false);
  expect(
    connectionCheckRuntimeReady({
      isRunning: () => false,
      hasUnresolvedEffect: () => false,
    }),
  ).toBe(false);
  expect(
    connectionCheckRuntimeReady({
      isRunning: () => true,
      hasUnresolvedEffect: () => true,
    }),
  ).toBe(false);
  expect(
    connectionCheckRuntimeReady({
      isRunning: () => true,
      hasUnresolvedEffect: () => false,
    }),
  ).toBe(true);
});

// Real Desktop coordinator, scripted Go/browser ports. These tests qualify the
// caller's ordering and single dispatch, not native storage or provider behavior.
const id = "a12abb83-21d5-4535-9bef-ddf9a67ec4ad";
const nonce = "49a0cb44-5c67-4aae-9b56-41db024507d3";
const digest = "a".repeat(64);
const command = {
  kind: "connector.test-connection" as const,
  operationId: id,
  taskId: "",
};
function fixture(mode: "bootstrap" | "status" = "bootstrap") {
  const events: string[] = [];
  let phase: ComputerCheckObserveResponse["phase"] = "claimed";
  let fingerprint: string | null = null;
  let proof = false;
  let scopeCurrent = true;
  let documentCurrent = true;
  let sends = 0;
  const prepared: ComputerCheckPrepareResponse = {
    operationId: id,
    phase: "prepared",
    mode,
    ...(mode === "status" ? { checkId: nonce } : {}),
    prompt:
      mode === "status"
        ? `computer_connection_status {"checkId":"${nonce}"}`
        : "farol_connector_verify original-challenge",
    promptDigest: "",
    scopeDigest: digest,
    documentDigest: digest,
  };
  const prompt = {
    ...prepared,
    promptDigest: connectionCheckDigest(prepared.prompt),
  };
  const go = {
    claim: vi.fn(
      async (input: { operationId: string; fingerprint: string }) => {
        events.push("claim");
        if (
          input.operationId !== id ||
          (fingerprint !== null && fingerprint !== input.fingerprint)
        )
          throw new BridgeError("refused", "computer_connection_check_refused");
        const first = fingerprint === null;
        fingerprint = input.fingerprint;
        return { operationId: id, first, phase };
      },
    ),
    prepare: vi.fn(async (input: ComputerCheckPrepareRequest) => {
      events.push("prepare");
      expect(input.operationId).toBe(id);
      expect(input.documentDigest).toBe(digest);
      if (phase !== "claimed")
        throw new BridgeError("refused", "computer_connection_check_refused");
      phase = "prepared";
      return prompt;
    }),
    advance: vi.fn(
      async (
        input: ComputerCheckAdvanceRequest,
      ): Promise<ComputerCheckAdvanceResponse> => {
        events.push(input.stage);
        expect(input.operationId).toBe(id);
        if (input.stage === "dispatch") {
          if (phase !== "prepared")
            throw new BridgeError(
              "unknown",
              "computer_connection_check_unknown",
            );
          phase = "dispatch_intent";
        } else if (input.stage === "sent") phase = "send_acknowledged";
        else if (input.stage === "unknown") phase = "outcome_unknown";
        else if (input.stage === "refuse") phase = "refused_before_send";
        else {
          if (!proof)
            throw new BridgeError(
              "unknown",
              "computer_connection_check_unknown",
            );
          phase = "verified";
        }
        return {
          operationId: id,
          phase,
          sendAuthorized: input.stage === "dispatch",
          ...(phase === "verified" ? { receiptDigest: digest } : {}),
        };
      },
    ),
    observe: vi.fn(
      async (_operationId: string): Promise<ComputerCheckObserveResponse> => {
        events.push("observe");
        return {
          operationId: id,
          phase,
          ...(phase === "claimed"
            ? {}
            : { mode, ...(mode === "status" ? { checkId: nonce } : {}) }),
          ...(phase === "verified" ? { receiptDigest: digest } : {}),
          delivery: "not_recorded",
          receiptAvailable: proof,
        };
      },
    ),
  };
  const browser: ConnectionCheckBrowser = {
    selection: {
      mode,
      appName: "Farol Dev",
      model: "temporary-instant",
      tunnelId: "tunnel",
      challengeDigest: digest,
      computerGeneration: "1",
      ...(mode === "bootstrap" ? { challenge: "original-challenge" } : {}),
    },
    current: () => scopeCurrent,
    prepareDocument: vi.fn(async () => {
      events.push("document");
      return { documentDigest: digest, current: () => documentCurrent };
    }),
    send: vi.fn(async (_text, observer) => {
      events.push("browser");
      await observer.onDispatchIntent!();
      if (!observer.beforeSend!())
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
        };
      events.push("send");
      sends++;
      await observer.onSendAcknowledged!();
      proof = true;
      expect(await observer.readConnectorReceipt()).toBe(true);
      return { state: "receipt_confirmed", code: null };
    }),
  };
  const capture = vi.fn(async () => {
    events.push("capture");
    return browser;
  });
  const run = () => runExplicitConnectionCheck(command, go, capture);
  return {
    go,
    browser,
    capture,
    run,
    events,
    sends: () => sends,
    markSend: () => {
      sends++;
    },
    proof: (value: boolean) => {
      proof = value;
    },
    scope: (value: boolean) => {
      scopeCurrent = value;
    },
    document: (value: boolean) => {
      documentCurrent = value;
    },
  };
}

it.each(["bootstrap", "status"] as const)(
  "%s uses original identity, durable permit, one Send and original receipt",
  async (mode) => {
    const f = fixture(mode);
    expect(await f.run()).toEqual({
      state: "verified",
      operationId: id,
      receiptDigest: digest,
      retained: false,
    });
    expect(f.sends()).toBe(1);
    expect(f.events).toEqual([
      "claim",
      "capture",
      "document",
      "prepare",
      "browser",
      "dispatch",
      "send",
      "sent",
      "observe",
      "observe",
      "confirm",
    ]);
    expect(vi.mocked(f.browser.send).mock.calls[0]![0]).toContain(
      mode === "status" ? nonce : "original-challenge",
    );
    expect(await f.run()).toMatchObject({ state: "verified", retained: true });
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.sends()).toBe(1);
  },
);
it("same UUID with changed caller input cannot select a new route", async () => {
  const f = fixture();
  await f.run();
  const changed = await runExplicitConnectionCheck(
    { ...command, taskId: "other-route" },
    f.go,
    f.capture,
  );
  expect(changed.state).toBe("refused");
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.sends()).toBe(1);
});
it.each(["claim", "prepare", "dispatch", "sent", "confirm"] as const)(
  "lost %s RPC reply is never retried",
  async (stage) => {
    const f = fixture("status");
    if (stage === "claim")
      f.go.claim.mockRejectedValueOnce(new BridgeError("unknown", "lost"));
    else if (stage === "prepare")
      f.go.prepare.mockRejectedValueOnce(new BridgeError("unknown", "lost"));
    else {
      const original = f.go.advance.getMockImplementation()!;
      f.go.advance.mockImplementation(async (input) => {
        const result = await original(input);
        if (input.stage === stage) throw new BridgeError("unknown", "lost");
        return result;
      });
    }
    expect((await f.run()).state).toBe("unknown");
    expect(f.sends()).toBe(stage === "sent" || stage === "confirm" ? 1 : 0);
    if (stage !== "claim" && stage !== "prepare")
      expect(
        f.go.advance.mock.calls.filter(([input]) => input.stage === stage),
      ).toHaveLength(1);
    expect(
      f.go.advance.mock.calls.filter(([input]) => input.stage === "unknown"),
    ).toHaveLength(0);
  },
);
it("a lost browser Send ACK can be confirmed only by the exact original Go receipt", async () => {
  const f = fixture("status");
  vi.mocked(f.browser.send).mockImplementation(async (_text, observer) => {
    await observer.onDispatchIntent!();
    expect(observer.beforeSend!()).toBe(true);
    f.markSend();
    f.proof(true);
    return { state: "outcome_unknown", code: "CHATGPT_SUBMIT_UNAVAILABLE" };
  });
  expect((await f.run()).state).toBe("verified");
  expect(f.sends()).toBe(1);
  expect(f.go.advance.mock.calls.map(([x]) => x.stage)).toEqual([
    "dispatch",
    "confirm",
  ]);
});
it.each(["missing-id", "wrong-id", "no-proof"])(
  "status %s cannot settle the original and never resends",
  async (kind) => {
    const f = fixture("status");
    vi.mocked(f.browser.send).mockImplementation(async (_text, observer) => {
      await observer.onDispatchIntent!();
      f.markSend();
      return { state: "outcome_unknown", code: null };
    });
    const original = f.go.observe.getMockImplementation()!;
    f.go.observe.mockImplementation(async (operationId) => {
      const value = await original(operationId);
      const { checkId: _priorCheckId, ...withoutId } = value;
      return {
        ...withoutId,
        receiptAvailable: kind !== "no-proof",
        ...(kind === "missing-id"
          ? {}
          : { checkId: kind === "wrong-id" ? id : nonce }),
      };
    });
    expect((await f.run()).state).toBe("unknown");
    expect(f.sends()).toBe(1);
    expect(f.go.advance.mock.calls.some(([x]) => x.stage === "confirm")).toBe(
      false,
    );
  },
);
it.each(["draft", "attachments", "active-generation", "unrecognized-layout"])(
  "%s refuses before navigation/Send and retains the original claim",
  async () => {
    const f = fixture();
    vi.mocked(f.browser.prepareDocument).mockRejectedValueOnce(
      new ConnectionCheckRefusal("CONNECTION_CHECK_PREREQUISITES_REQUIRED"),
    );
    expect((await f.run()).state).toBe("refused");
    expect(f.sends()).toBe(0);
    expect(f.go.prepare).not.toHaveBeenCalled();
    expect(f.browser.send).not.toHaveBeenCalled();
    expect(f.go.advance.mock.calls.map(([x]) => x.stage)).toEqual(["refuse"]);
  },
);
it.each(["document", "runtime"])(
  "%s change after dispatch intent cannot become a no-effect refusal",
  async (kind) => {
    const f = fixture();
    vi.mocked(f.browser.send).mockImplementation(async (_text, observer) => {
      await observer.onDispatchIntent!();
      if (kind === "document") f.document(false);
      else f.scope(false);
      expect(observer.beforeSend!()).toBe(false);
      return {
        state: "failed_before_submit",
        code: "CHATGPT_APP_SELECTION_LOST",
      };
    });
    expect((await f.run()).state).toBe("unknown");
    expect(f.sends()).toBe(0);
    expect(f.go.advance.mock.calls.map(([x]) => x.stage)).toEqual([
      "dispatch",
      "unknown",
    ]);
  },
);
it("repeated browser dispatch callbacks do not obtain a second Go permit", async () => {
  const f = fixture();
  vi.mocked(f.browser.send).mockImplementation(async (_text, observer) => {
    await observer.onDispatchIntent!();
    f.markSend();
    await observer.onDispatchIntent!();
    f.markSend();
    return { state: "completed", code: null };
  });
  expect((await f.run()).state).toBe("unknown");
  expect(f.sends()).toBe(1);
  expect(f.go.advance.mock.calls.map(([x]) => x.stage)).toEqual(["dispatch"]);
});
it("an unconfirmed original is observation-only after caller remount/recreation", async () => {
  const f = fixture();
  vi.mocked(f.browser.send).mockImplementation(async (_text, observer) => {
    await observer.onDispatchIntent!();
    f.markSend();
    return { state: "outcome_unknown", code: null };
  });
  expect((await f.run()).state).toBe("unknown");
  const afterRestart = vi.fn(async () => {
    throw Error("must not resolve new runtime");
  });
  expect(
    (await runExplicitConnectionCheck(command, f.go, afterRestart)).state,
  ).toBe("unknown");
  expect(afterRestart).not.toHaveBeenCalled();
  expect(f.sends()).toBe(1);
});
