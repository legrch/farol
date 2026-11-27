import { describe, expect, it } from "vitest";
import type {
  HandoffAuthority,
  HandoffRecord,
  HandoffWorkspace,
} from "../port/handoff";
import {
  HandoffNotSubmittedError,
  adoptedReadStillAllowed,
  dispatchStillAllowed,
  readHost,
  readStillAllowed,
  resultReadStillAllowed,
  supportsDispatchAttempts,
  type HandoffFlowDeps,
} from "./handoffdeps";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

const workspace: HandoffWorkspace = {
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project: {
    root: "/work/root/app",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/work/root/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
};

const record = (extra: Partial<HandoffRecord> = {}): HandoffRecord => ({
  requestDigest: "d",
  workspaceId: "w1",
  workspace,
  projectId: "p1",
  threadIntent: true,
  turnIntent: true,
  ...extra,
});

function deps(
  over: {
    now?: number;
    expiresAt?: number;
    resolved?: HandoffWorkspace | null;
    journal?: Record<string, unknown>;
    requests?: unknown[][];
  } = {},
): HandoffFlowDeps {
  const authority: HandoffAuthority = {
    resolve: async () =>
      over.resolved === undefined ? workspace : over.resolved,
  };
  return {
    authority,
    host: {
      request: async (...args) => {
        over.requests?.push(args);
        return { ok: true };
      },
    },
    journal: (over.journal ?? {}) as never,
    digester: {} as never,
    mutationExpiresAt: over.expiresAt ?? 100,
    mutationGate: {} as never,
    now: () => over.now ?? 10,
    selectedOwnerThreadId: THREAD_ID,
  };
}

describe("HandoffNotSubmittedError", () => {
  it("is an Error subclass that callers can tell apart", () => {
    const error = new HandoffNotSubmittedError("CODE");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("CODE");
  });
});

describe("supportsDispatchAttempts", () => {
  it("needs both attempt claiming and pre-effect refusal recording", () => {
    expect(supportsDispatchAttempts(deps())).toBe(false);
    expect(
      supportsDispatchAttempts(
        deps({ journal: { claimDispatchAttempt: () => null } }),
      ),
    ).toBe(false);
    expect(
      supportsDispatchAttempts(
        deps({
          journal: {
            claimDispatchAttempt: () => 1,
            recordPreEffectRefusal: () => {},
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("read and dispatch admission", () => {
  it("follows the read deadline and the mutation window", () => {
    expect(readStillAllowed(deps(), { deadlineAt: 11 })).toBe(true);
    expect(readStillAllowed(deps(), { deadlineAt: 10 })).toBe(false);
    expect(dispatchStillAllowed(deps(), {})).toBe(true);
    expect(dispatchStillAllowed(deps({ now: 100 }), {})).toBe(false);
    expect(dispatchStillAllowed(deps(), { deadlineAt: 5 })).toBe(false);
  });
});

describe("readHost", () => {
  it("forwards the read deadline and returns the response", async () => {
    const requests: unknown[][] = [];
    const host = readHost(deps({ requests }), { deadlineAt: 50 });
    expect(await host.request("thread/read", { a: 1 })).toEqual({ ok: true });
    expect(requests).toEqual([["thread/read", { a: 1 }, 50]]);
  });

  it("refuses before sending once admission has ended", async () => {
    const requests: unknown[][] = [];
    const host = readHost(deps({ requests }), { deadlineAt: 5 });
    await expect(host.request("thread/read", {})).rejects.toThrow(
      "HANDOFF_READ_ADMISSION_ENDED",
    );
    expect(requests).toEqual([]);
  });

  it("discards a response that arrives after admission ended", async () => {
    let clock = 10;
    const base = deps();
    const host = readHost(
      {
        ...base,
        now: () => clock,
        host: { request: async () => ((clock = 99), 1) },
      },
      { deadlineAt: 50 },
    );
    await expect(host.request("m", {})).rejects.toThrow(
      "HANDOFF_READ_ADMISSION_ENDED",
    );
  });
});

describe("adoptedReadStillAllowed", () => {
  it("requires an adopted record on the selected thread inside the window", async () => {
    const adopted = record({ adopted: true, threadId: THREAD_ID });
    expect(await adoptedReadStillAllowed(deps(), adopted)).toBe(true);
    expect(await adoptedReadStillAllowed(deps(), record())).toBe(false);
    expect(
      await adoptedReadStillAllowed(
        deps(),
        record({ adopted: true, threadId: "other" }),
      ),
    ).toBe(false);
    expect(await adoptedReadStillAllowed(deps({ now: 100 }), adopted)).toBe(
      false,
    );
  });

  it("refuses when the workspace is no longer approved or moved", async () => {
    const adopted = record({ adopted: true, threadId: THREAD_ID });
    expect(
      await adoptedReadStillAllowed(deps({ resolved: null }), adopted),
    ).toBe(false);
    expect(
      await adoptedReadStillAllowed(
        deps({ resolved: { ...workspace, inode: "9" } }),
        adopted,
      ),
    ).toBe(false);
  });
});

describe("resultReadStillAllowed", () => {
  it("checks the physical workspace for an ordinary record", async () => {
    expect(await resultReadStillAllowed(deps(), record())).toBe(true);
    expect(
      await resultReadStillAllowed(
        deps({ resolved: { ...workspace, device: "7" } }),
        record(),
      ),
    ).toBe(false);
  });

  it("delegates an adopted record to the adopted check", async () => {
    expect(
      await resultReadStillAllowed(deps(), record({ adopted: true })),
    ).toBe(false);
    expect(
      await resultReadStillAllowed(
        deps(),
        record({ adopted: true, threadId: THREAD_ID }),
      ),
    ).toBe(true);
  });
});
