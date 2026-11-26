import { describe, expect, it } from "vitest";
import type { ChatGptPageObservation } from "../../../src/apps/desktop/chatgpt-page-policy";
import {
  ChatGptSignInBlockLedger,
  SIGN_IN_CLOSE_OBSERVATION_MS,
  createBoundedSignInObservation,
  unreadSignInOutcome,
  type SignInRead,
} from "./signin";

describe("the sign-in block ledger", () => {
  it("shows no block before anything is recorded", () => {
    expect(new ChatGptSignInBlockLedger().current()).toBeNull();
  });

  it("shows the recorded block as current", () => {
    const ledger = new ChatGptSignInBlockLedger();
    ledger.record({ kind: "navigation-blocked", host: "evil.test" });
    expect(ledger.current()).toEqual({
      kind: "navigation-blocked",
      host: "evil.test",
    });
  });

  it("replaces an earlier block with a later one inside an attempt", () => {
    const ledger = new ChatGptSignInBlockLedger();
    ledger.beginAttempt();
    ledger.record({ kind: "popup-blocked", host: "a.test" });
    ledger.record({ kind: "permission-denied", permission: "media" });
    expect(ledger.current()).toEqual({
      kind: "permission-denied",
      permission: "media",
    });
    ledger.record({ kind: "load-failed", code: -105 });
    expect(ledger.current()).toEqual({ kind: "load-failed", code: -105 });
  });

  it("starts the next attempt with no block, never showing a stale one", () => {
    const ledger = new ChatGptSignInBlockLedger();
    ledger.record({ kind: "popup-blocked", host: "a.test" });
    ledger.beginAttempt();
    expect(ledger.current()).toBeNull();
    ledger.record({ kind: "popup-blocked", host: "b.test" });
    expect(ledger.current()).toEqual({ kind: "popup-blocked", host: "b.test" });
  });

  it("keeps separate ledgers apart", () => {
    const first = new ChatGptSignInBlockLedger();
    const second = new ChatGptSignInBlockLedger();
    first.record({ kind: "load-failed", code: 1 });
    expect(second.current()).toBeNull();
  });
});

describe("an unread sign-in outcome", () => {
  it("says no window was read, at no elapsed time, for either trigger", () => {
    expect(unreadSignInOutcome("return")).toEqual({
      reason: "no-window",
      state: null,
      elapsedMs: 0,
      readStartedBy: "return",
    });
    expect(unreadSignInOutcome("closing")).toEqual({
      reason: "no-window",
      state: null,
      elapsedMs: 0,
      readStartedBy: "closing",
    });
  });
});

// A clock and a timer the test drives by hand: nothing runs until `advance`.
function fakeClock() {
  let now = 1_000;
  const timers: { at: number; callback: () => void }[] = [];
  return {
    ports: {
      now: () => now,
      after: (callback: () => void, ms: number) => {
        timers.push({ at: now + ms, callback });
      },
    },
    armed: () => timers.length,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.callback();
      }
      now = target;
    },
  };
}

const answered: ChatGptPageObservation = {
  state: "signed_out",
  code: "CHATGPT_SIGN_IN_REQUIRED",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the bounded sign-in observation", () => {
  it("keeps the close bound at two seconds", () => {
    expect(SIGN_IN_CLOSE_OBSERVATION_MS).toBe(2_000);
  });

  it("reports the observation with how long the read ran when it answers in time", async () => {
    const clock = fakeClock();
    const read = deferred<SignInRead>();
    const observe = createBoundedSignInObservation(clock.ports);
    const pending = observe(read.promise, "return");
    clock.advance(250);
    read.resolve({ observation: answered, reason: "answered" });
    expect(await pending).toEqual({
      observation: answered,
      diagnostic: {
        reason: "answered",
        state: "signed_out",
        elapsedMs: 250,
        readStartedBy: "return",
      },
    });
  });

  it("carries the read's own reason through, whatever it is", async () => {
    const clock = fakeClock();
    const observe = createBoundedSignInObservation(clock.ports);
    const unsupported: ChatGptPageObservation = {
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    };
    const result = await observe(
      Promise.resolve({ observation: unsupported, reason: "url-unsupported" }),
      "closing",
    );
    expect(result.diagnostic).toEqual({
      reason: "url-unsupported",
      state: "unsupported",
      elapsedMs: 0,
      readStartedBy: "closing",
    });
  });

  it("arms exactly one two-second timer per read", () => {
    const clock = fakeClock();
    const observe = createBoundedSignInObservation(clock.ports);
    void observe(new Promise<SignInRead>(() => undefined), "return");
    expect(clock.armed()).toBe(1);
    clock.advance(SIGN_IN_CLOSE_OBSERVATION_MS - 1);
    expect(clock.armed()).toBe(1);
  });

  it("yields a null observation and a timeout once the bound passes", async () => {
    const clock = fakeClock();
    const observe = createBoundedSignInObservation(clock.ports);
    const pending = observe(
      new Promise<SignInRead>(() => undefined),
      "closing",
    );
    clock.advance(SIGN_IN_CLOSE_OBSERVATION_MS);
    expect(await pending).toEqual({
      observation: null,
      diagnostic: {
        reason: "timeout",
        state: null,
        elapsedMs: SIGN_IN_CLOSE_OBSERVATION_MS,
        readStartedBy: "closing",
      },
    });
  });

  it("does not time out one millisecond before the bound", async () => {
    const clock = fakeClock();
    const read = deferred<SignInRead>();
    const observe = createBoundedSignInObservation(clock.ports);
    const pending = observe(read.promise, "return");
    clock.advance(SIGN_IN_CLOSE_OBSERVATION_MS - 1);
    read.resolve({ observation: answered, reason: "answered" });
    const result = await pending;
    expect(result.observation).toEqual(answered);
    expect(result.diagnostic.elapsedMs).toBe(SIGN_IN_CLOSE_OBSERVATION_MS - 1);
  });

  it("keeps the first side to settle when the read answers after the bound", async () => {
    const clock = fakeClock();
    const read = deferred<SignInRead>();
    const observe = createBoundedSignInObservation(clock.ports);
    const pending = observe(read.promise, "return");
    clock.advance(SIGN_IN_CLOSE_OBSERVATION_MS);
    read.resolve({ observation: answered, reason: "answered" });
    const result = await pending;
    expect(result.observation).toBeNull();
    expect(result.diagnostic.reason).toBe("timeout");
  });

  it("measures each read from its own start", async () => {
    const clock = fakeClock();
    const observe = createBoundedSignInObservation(clock.ports);
    clock.advance(500);
    const second = deferred<SignInRead>();
    const pending = observe(second.promise, "closing");
    clock.advance(40);
    second.resolve({ observation: answered, reason: "answered" });
    expect((await pending).diagnostic.elapsedMs).toBe(40);
  });

  it("passes a failing read through as a rejection, not as an outcome", async () => {
    const clock = fakeClock();
    const read = deferred<SignInRead>();
    const observe = createBoundedSignInObservation(clock.ports);
    const pending = observe(read.promise, "return");
    read.reject(new Error("probe failed"));
    await expect(pending).rejects.toThrow("probe failed");
  });
});
