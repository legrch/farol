import { expect, it } from "vitest";
import { ClaudeTaskProcessPeer } from "../../src/modules/computer/infra/peer/claude-task-process-peer";
const request = {
  key: "019b0000-0000-4000-8000-000000000020",
  workspaceId: "writer",
  command: "fixture",
  stdin: "prompt",
  deadlineAt: 100,
};
function fixture(mode = "valid") {
  let releases = 0;
  let quarantines = 0;
  let clears = 0;
  let calls = 0;
  let cleanup: Promise<void> | undefined;
  const snapshot = {
    handle: "owned",
    state: "exited",
    stdoutBase64: Buffer.from("fixture").toString("base64"),
    stdoutBytes: 7,
    stdoutNextOffset: 7,
    exitCode: 0,
    exitSignal: null,
    groupCleanup: "confirmed",
    outputLimitReached: false,
    cancelRequested: false,
    timedOut: false,
    authorityExpired: false,
    errorCode: null,
  };
  const shell = {
    async start(
      _input: unknown,
      _signal: unknown,
      admitted: () => Promise<boolean>,
      fd: number,
      reserve: () => Promise<void>,
    ) {
      calls++;
      expect(fd).toBe(9);
      expect(await admitted()).toBe(true);
      await reserve();
      if (mode === "throw") throw Error("lost start");
      return mode === "refuse"
        ? { ok: false, error: { code: "REFUSED" } }
        : { ok: true, value: snapshot };
    },
    waitForTerminal() {
      return Promise.resolve(mode === "cleanup" ? "unverified" : "confirmed");
    },
    trackTerminalCleanup(work: Promise<void>) {
      cleanup = work;
      void work.catch(() => undefined);
    },
    read() {
      return mode === "read"
        ? { ok: false, error: { code: "UNKNOWN" } }
        : {
            ok: true,
            value: {
              ...snapshot,
              ...(mode === "truncated" ? { stdoutBytes: 65537 } : {}),
              ...(mode === "interrupted" ? { cancelRequested: true } : {}),
              ...(mode === "utf8"
                ? { stdoutBase64: Buffer.from([255]).toString("base64") }
                : {}),
            },
          };
    },
  };
  const fence = {
    async acquireAdmission() {
      return mode === "fence"
        ? { admitted: false, code: "FENCED" }
        : {
            admitted: true,
            fd: 9,
            async release() {
              releases++;
            },
          };
    },
    async reserveShell() {},
    async clearShell() {
      clears++;
      if (mode === "clear") throw Error("clear failure");
    },
    quarantineShell() {
      quarantines++;
    },
  };
  const peer = new ClaudeTaskProcessPeer(
    shell as never,
    fence as never,
    100,
    async () => mode !== "admission",
    () => (mode === "expired" ? 100 : 1),
  );
  return {
    peer,
    get releases() {
      return releases;
    },
    get quarantines() {
      return quarantines;
    },
    get clears() {
      return clears;
    },
    get calls() {
      return calls;
    },
    async drain() {
      return cleanup;
    },
  };
}
it("owned terminal cleanup clears marker and releases lease after actual exit", async () => {
  const f = fixture();
  expect(await f.peer.start(request)).toBe("owned");
  await f.drain();
  expect(f.releases).toBe(1);
  expect(f.clears).toBe(1);
  expect(await f.peer.read("owned")).toMatchObject({
    stdout: "fixture",
    truncated: false,
    interrupted: false,
  });
});
it.each(["admission", "expired", "fence"])(
  "%s fails before shell effects",
  async (mode) => {
    const f = fixture(mode);
    await expect(f.peer.start(request)).rejects.toThrow();
    expect(f.calls).toBe(0);
  },
);
it.each(["cleanup", "clear"])(
  "%s never releases failed cleanup lease",
  async (mode) => {
    const f = fixture(mode);
    await f.peer.start(request);
    await expect(f.drain()).rejects.toThrow();
    expect(f.releases).toBe(0);
    expect(f.quarantines).toBeGreaterThan(0);
  },
);
it("throw retains uncertain lease; pre-spawn refusal clears and releases", async () => {
  const uncertain = fixture("throw");
  await expect(uncertain.peer.start(request)).rejects.toThrow();
  expect(uncertain.releases).toBe(0);
  expect(uncertain.quarantines).toBe(1);
  const refused = fixture("refuse");
  await expect(refused.peer.start(request)).rejects.toThrow();
  expect(refused.clears).toBe(1);
  expect(refused.releases).toBe(1);
});
it.each(["read", "utf8"])(
  "%s does not reinterpret missing/invalid output",
  async (mode) => {
    await expect(fixture(mode).peer.read("owned")).rejects.toThrow();
  },
);
it.each(["truncated", "interrupted"])(
  "%s stays explicitly unqualified",
  async (mode) => {
    const f = fixture(mode);
    expect(await f.peer.read("owned")).toMatchObject({ [mode]: true });
  },
);
