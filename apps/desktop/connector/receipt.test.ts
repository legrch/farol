import { describe, expect, it } from "vitest";
import {
  TUNNEL_EXITED,
  TUNNEL_TERMINAL,
  TUNNEL_UNKNOWN,
  childLifecycleRecord,
  terminalCode,
  terminalReceipt,
  terminalSignal,
} from "./receipt";

// The strict parsers for what a connector child reports about its own end.
// Pure values only: no process, channel or tunnel runs.

const receipt = {
  kind: TUNNEL_TERMINAL,
  source: "connector-tunnel",
  event: "exit",
  exitCode: 3,
  signal: null,
};

const record = {
  source: "connector-tunnel",
  event: "exit",
  code: "CONNECTOR_TUNNEL_EXIT",
  state: "observed",
  exitCode: 0,
  signal: null,
  forced: false,
};

describe("receipt vocabulary", () => {
  it("keeps the three wire tokens that the anchor script and Desktop share", () => {
    expect([TUNNEL_EXITED, TUNNEL_UNKNOWN, TUNNEL_TERMINAL]).toEqual([
      "farol-tunnel-exited-v1",
      "farol-tunnel-unknown-v1",
      "farol-tunnel-terminal-v1",
    ]);
  });
});

describe("terminalCode", () => {
  it.each([0, 1, -1, 2147483647, -2147483648])("admits %s", (value) =>
    expect(terminalCode(value)).toBe(value),
  );
  it.each([2147483648, -2147483649, 1.5, NaN, "3", null, undefined, {}])(
    "refuses %s",
    (value) => expect(terminalCode(value)).toBeNull(),
  );
});

describe("terminalSignal", () => {
  it.each(["SIGTERM", "SIGKILL", "SIGHUP", "SIGINFO"])("admits %s", (value) =>
    expect(terminalSignal(value)).toBe(value),
  );
  it.each(["sigterm", "SIGNOPE", "", 15, null, undefined])(
    "refuses %s",
    (value) => expect(terminalSignal(value)).toBeNull(),
  );
});

describe("terminalReceipt", () => {
  it("admits a frozen exit code receipt", () => {
    const result = terminalReceipt(receipt);
    expect(result).toEqual({ exitCode: 3, signal: null });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("admits a signal receipt", () => {
    expect(
      terminalReceipt({ ...receipt, exitCode: null, signal: "SIGKILL" }),
    ).toEqual({ exitCode: null, signal: "SIGKILL" });
  });

  it.each([
    ["a wrong kind", { ...receipt, kind: "other" }],
    ["a wrong source", { ...receipt, source: "connector-anchor" }],
    ["a wrong event", { ...receipt, event: "close" }],
    ["a missing code and signal", { ...receipt, exitCode: null }],
    ["both a code and a signal", { ...receipt, signal: "SIGTERM" }],
    ["an unknown signal", { ...receipt, exitCode: null, signal: "SIGNOPE" }],
    ["an out-of-range code", { ...receipt, exitCode: 2 ** 31 }],
    ["an extra key", { ...receipt, extra: 1 }],
    ["a missing key", { kind: TUNNEL_TERMINAL }],
    ["an array", [receipt]],
    ["a string token", TUNNEL_EXITED],
    ["null", null],
  ])("refuses %s", (_name, value) => expect(terminalReceipt(value)).toBeNull());

  it("never runs a getter and refuses it", () => {
    let reads = 0;
    const hostile = { ...receipt };
    Object.defineProperty(hostile, "exitCode", {
      enumerable: true,
      get() {
        reads += 1;
        return 3;
      },
    });
    expect(terminalReceipt(hostile)).toBeNull();
    expect(reads).toBe(0);
  });

  it("refuses a throwing proxy instead of throwing", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile");
        },
      },
    );
    expect(terminalReceipt(proxy)).toBeNull();
  });
});

describe("childLifecycleRecord", () => {
  it("admits an observed exit and freezes it", () => {
    const result = childLifecycleRecord(record);
    expect(result).toEqual(record);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("copies only the seven closed fields", () => {
    expect(childLifecycleRecord({ ...record })).not.toBe(record);
  });

  it.each([
    ["connector-tunnel", "error", "CONNECTOR_TUNNEL_ERROR"],
    ["connector-tunnel", "invalid-receipt", "CONNECTOR_TUNNEL_RECEIPT_INVALID"],
    ["connector-anchor", "error", "CONNECTOR_ANCHOR_ERROR"],
    ["connector-anchor", "disconnect", "CONNECTOR_IPC_DISCONNECTED"],
    ["connector-anchor", "cleanup-unknown", "CONNECTOR_STOP_UNCONFIRMED"],
  ])("admits the unknown-state %s %s record", (source, event, code) => {
    expect(
      childLifecycleRecord({
        ...record,
        source,
        event,
        code,
        state: "outcome_unknown",
        exitCode: null,
        signal: null,
      }),
    ).not.toBeNull();
  });

  it("admits an anchor close with a signal", () => {
    expect(
      childLifecycleRecord({
        ...record,
        source: "connector-anchor",
        event: "close",
        code: "CONNECTOR_ANCHOR_CLOSE",
        exitCode: null,
        signal: "SIGTERM",
      }),
    ).not.toBeNull();
  });

  it.each([
    ["a mismatched code for the event", { code: "CONNECTOR_ANCHOR_EXIT" }],
    ["an unknown source", { source: "other" }],
    ["an unknown state", { state: "done" }],
    ["a non-boolean forced", { forced: "no" }],
    ["both a code and a signal", { signal: "SIGTERM" }],
    ["an unknown signal", { exitCode: null, signal: "SIGNOPE" }],
    ["an observed record with no terminal", { exitCode: null }],
    [
      "an observed error event",
      {
        event: "error",
        code: "CONNECTOR_TUNNEL_ERROR",
      },
    ],
    [
      "a terminal on a non-terminal event",
      {
        event: "error",
        code: "CONNECTOR_TUNNEL_ERROR",
        state: "outcome_unknown",
      },
    ],
  ])("refuses %s", (_name, patch) =>
    expect(childLifecycleRecord({ ...record, ...patch })).toBeNull(),
  );

  it.each([
    ["an extra key", { ...record, extra: 1 }],
    ["a missing key", { source: "connector-tunnel" }],
    ["an array", [record]],
    ["null", null],
    ["a string", "exit"],
  ])("refuses %s", (_name, value) =>
    expect(childLifecycleRecord(value)).toBeNull(),
  );

  it("never runs a getter and refuses it", () => {
    let reads = 0;
    const hostile = { ...record };
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get() {
        reads += 1;
        return "observed";
      },
    });
    expect(childLifecycleRecord(hostile)).toBeNull();
    expect(reads).toBe(0);
  });
});
