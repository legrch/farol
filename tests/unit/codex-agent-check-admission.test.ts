import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition";
import {
  activateAgentCheckSession,
  type AgentCheckActivation,
} from "../../src/apps/desktop/codex-agent-check-admission";

// S35-Q1. `host.run-codex-agent-check` takes the `agent-admission`
// reservation to re-read the authority it was admitted with and bind it to
// the session that carries it. Everything after that is polling: up to 480
// cycles of reading the child's thread, binding nothing.
//
// The reservation is the same one `openProductAgentSession` takes, so while
// the check holds it every new Product Agent session — and every rejoin of a
// running one — is refused with `AUTHORITY_CHANGE_IN_PROGRESS`. A connector
// start and every `computer.*` authority change wait behind it too.
//
// The two paths to an active session are the whole content of these rows: a
// first poll launches one, a resumed poll (the previous poll answered
// `CODEX_AGENT_STILL_RUNNING`, so `activeCodexAgentCheck` is still set)
// already has one. Both must close the window.

type Session = Readonly<{ key: string }>;
type Refusal = Readonly<{ error: string }>;

const session: Session = { key: "check-key" };

function deferred(): Readonly<{ promise: Promise<void>; settle: () => void }> {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** What `openProductAgentSession` does with the same reservation. */
function productAgentOpenAdmitted(
  transitions: AuthorityTransitionReservation,
): boolean {
  const handle = transitions.tryReserve("agent-admission");
  if (!handle) return false;
  handle.release();
  return true;
}

function reserved(): Readonly<{
  transitions: AuthorityTransitionReservation;
  admission: NonNullable<
    ReturnType<AuthorityTransitionReservation["tryReserve"]>
  >;
}> {
  const transitions = new AuthorityTransitionReservation();
  const admission = transitions.tryReserve("agent-admission");
  expect(admission).not.toBeNull();
  return { transitions, admission: admission! };
}

describe("S35-Q1 native Agent check authority admission", () => {
  it("closes the window when a first poll's launch produces the session", async () => {
    const { transitions, admission } = reserved();
    expect(productAgentOpenAdmitted(transitions)).toBe(false);

    const activation = await activateAgentCheckSession<Session, Refusal>(
      admission,
      null,
      async () => ({ active: true, session }),
    );

    expect(activation).toEqual({ active: true, session });
    expect(transitions.current()).toBeNull();
    expect(productAgentOpenAdmitted(transitions)).toBe(true);
  });

  it("closes the window for a resumed poll, which already has its session", async () => {
    const { transitions, admission } = reserved();

    const activation = await activateAgentCheckSession<Session, Refusal>(
      admission,
      session,
      async () => {
        throw new Error("LAUNCH_MUST_NOT_RUN");
      },
    );

    expect(activation).toEqual({ active: true, session });
    expect(transitions.current()).toBeNull();
    expect(productAgentOpenAdmitted(transitions)).toBe(true);
  });

  it("lets a Product Agent open through for every cycle of a resumed poll", async () => {
    const { transitions, admission } = reserved();
    const poll = deferred();

    const activation = await activateAgentCheckSession<Session, Refusal>(
      admission,
      session,
      async () => ({
        active: false,
        refusal: { error: "LAUNCH_MUST_NOT_RUN" },
      }),
    );
    expect(activation.active).toBe(true);

    // The poll that follows runs for up to 480 cycles. A rejoin arriving in
    // any of them must reach its own decision, not
    // AUTHORITY_CHANGE_IN_PROGRESS — which is what
    // `openProductAgentSession` throws when this lane is taken.
    const admittedDuringPoll: boolean[] = [];
    const polling = (async () => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        admittedDuringPoll.push(productAgentOpenAdmitted(transitions));
        await Promise.resolve();
      }
      await poll.promise;
    })();
    poll.settle();
    await polling;

    expect(admittedDuringPoll).toEqual([true, true, true]);
  });

  it("closes the window when the launch refuses instead of producing a session", async () => {
    const { transitions, admission } = reserved();
    const refusal: Refusal = { error: "CODEX_HOST_RECHECK_REQUIRED" };

    const activation = await activateAgentCheckSession<Session, Refusal>(
      admission,
      null,
      async () => ({ active: false, refusal }),
    );

    expect(activation).toEqual({ active: false, refusal });
    expect(productAgentOpenAdmitted(transitions)).toBe(true);
  });

  it("closes the window when the launch throws", async () => {
    const { transitions, admission } = reserved();

    await expect(
      activateAgentCheckSession<Session, Refusal>(admission, null, async () => {
        throw new Error("CODEX_HOST_LAUNCH_FAILED");
      }),
    ).rejects.toThrow("CODEX_HOST_LAUNCH_FAILED");
    expect(productAgentOpenAdmitted(transitions)).toBe(true);
  });

  it("holds the window for as long as a first poll's launch takes", async () => {
    const { transitions, admission } = reserved();
    const launch = deferred();

    const activating = activateAgentCheckSession<Session, Refusal>(
      admission,
      null,
      async (): Promise<AgentCheckActivation<Session, Refusal>> => {
        await launch.promise;
        return { active: true, session };
      },
    );

    // Launching the App Server is the part that binds the authority, so the
    // reservation is still the check's while it runs.
    expect(productAgentOpenAdmitted(transitions)).toBe(false);
    launch.settle();
    await activating;
    expect(productAgentOpenAdmitted(transitions)).toBe(true);
  });

  // The arm itself stays inline in `main.ts`, which exports nothing and
  // which no test loads. This guards that it still routes both paths through
  // the function above rather than releasing on one of them, in the same
  // style `product-agent-rejoin.test.ts` guards the start branch's ordering.
  it("routes the check's two paths through one activation", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
      "utf8",
    );
    const start = source.indexOf('case "host.run-codex-agent-check": {');
    const end = source.indexOf('case "host.remove-codex":', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const arm = source.slice(start, end);

    const activate = arm.indexOf("await activateAgentCheckSession<");
    const poll = arm.indexOf("const check = await runCodexNativeAgentCheck(");
    expect(activate).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(activate);
    // Two releases are left in the arm: the one the stale-revision refusal
    // takes before it has a session at all, and the idempotent one in the
    // `finally`. The third — the one only a first poll used to reach — is
    // now the function's own, so no path can skip it.
    expect(arm.match(/agentAdmission\.release\(\)/gu)).toHaveLength(2);
  });
});
