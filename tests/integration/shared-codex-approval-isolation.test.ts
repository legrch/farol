import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SharedCodexProxyHost } from "../../src/modules/chat/infra/native/shared-codex-proxy-host";

// Two owned Node protocol clients share only this deterministic fixture state.
// Native Desktop, serving provider behavior and owner decisions are NOT qualified.
// IPC transports the fixture server; stdin/stdout carry actual proxy frames.
const CLIENT = String.raw`
let input = "";
process.on("message", frame => process.stdout.write(JSON.stringify(frame) + "\n"));
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) break;
    const frame = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (frame.method === "initialize") {
      process.stdout.write(JSON.stringify({ id:frame.id, result:{codexHome:"/fixture/home",platformFamily:"unix",platformOs:"macos",userAgent:"fixture"}}) + "\n");
    } else process.send(frame);
  }
});
`;
const consentMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
];
const owned: Array<{
  host: SharedCodexProxyHost;
  peer: ChildProcessWithoutNullStreams;
}> = [];
async function verifyBothExits(
  closeHost: () => Promise<boolean>,
  waitPeer: Promise<boolean>,
): Promise<void> {
  // Each verification settles even if the other rejects. Assertions come last.
  const [host, peer] = await Promise.allSettled([
    Promise.resolve().then(closeHost),
    waitPeer,
  ]);
  if (peer.status !== "fulfilled" || !peer.value)
    throw Error("OWNED_PEER_EXIT_UNVERIFIED");
  if (host.status === "rejected") throw host.reason;
  expect(host.value).toBe(true);
}
afterEach(async () => {
  const cleanup = await Promise.allSettled(
    owned.splice(0).map(async ({ host, peer }) => {
      const peerExit = new Promise<boolean>((resolve) => {
        if (peer.exitCode !== null || peer.signalCode !== null)
          return resolve(true);
        const finished = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          peer.off("exit", finished);
          resolve(false);
        }, 2000);
        peer.once("exit", finished);
      });
      let killFailure: unknown;
      try {
        peer.kill("SIGTERM");
      } catch (error) {
        killFailure = error;
      }
      await verifyBothExits(() => host.closeAndWait(), peerExit);
      if (killFailure !== undefined) throw killFailure;
      expect(peer.exitCode !== null || peer.signalCode !== null).toBe(true);
    }),
  );
  for (const result of cleanup)
    if (result.status === "rejected") throw result.reason;
});
function launch(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["-e", CLIENT], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {},
  });
  if (!child.stdin || !child.stdout || !child.stderr)
    throw Error("Owned fixture pipes missing");
  return child as ChildProcessWithoutNullStreams;
}
async function fixture(method: string, id: string | number) {
  const native = launch();
  let nativeInput = "";
  let observed: (value: unknown) => void = () => {};
  const nativeRequest = new Promise<unknown>((resolve) => {
    observed = resolve;
  });
  native.stdout.setEncoding("utf8");
  native.stdout.on("data", (chunk: string) => {
    nativeInput += chunk;
    const end = nativeInput.indexOf("\n");
    if (end >= 0) observed(JSON.parse(nativeInput.slice(0, end)));
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending = true;
  let nativeReplies = 0;
  const farolReplies: unknown[] = [];
  let reads = 0;
  const host = new SharedCodexProxyHost(
    () => {
      child = launch();
      child.on("message", (raw: unknown) => {
        const value = raw as {
          id?: string | number;
          method?: string;
          error?: unknown;
          result?: unknown;
        };
        if (value.method === "thread/read") {
          reads++;
          if (reads === 1) {
            // Same request is visible to both clients. Numeric ID 2 collides
            // with Farol's client request namespace without fulfilling it.
            const request = {
              id,
              method,
              params: {
                threadId: "native-thread",
                turnId: "native-turn",
                itemId: "native-item",
                startedAtMs: 1,
                command: "NEVER_EXECUTE",
              },
            };
            native.send(request);
            child!.send({
              method: "thread/status/changed",
              params: { threadId: "native-thread" },
            });
            child!.send(request);
          }
          // stdin order is a causal barrier: any automatic response written by
          // receive() precedes this next thread/read and is already recorded.
          child!.send({
            id: value.id,
            result: {
              pending,
              nativeReplies,
              farolReplies: [...farolReplies],
              reads,
            },
          });
        } else if (value.id !== undefined && !value.method) {
          farolReplies.push(raw);
          pending = false; // Model a provider that treats error replies as denial.
        }
      });
      return child;
    },
    "/fixture/home",
    2000,
  );
  owned.push({ host, peer: native });
  native.on("message", (value: unknown) => {
    const frame = value as { id?: unknown; result?: unknown };
    if (frame.id !== id || frame.result === undefined) return;
    nativeReplies++;
    pending = false;
    child!.send({
      method: "serverRequest/resolved",
      params: { threadId: "native-thread", requestId: id },
    });
  });
  await host.connect();
  return { host, native, nativeRequest, farolReplies };
}
describe("unqualified shared observer does not decide another client's consent", () => {
  it.each(consentMethods)(
    "leaves %s to its authorized client",
    async (method) => {
      const { host, native, nativeRequest, farolReplies } = await fixture(
        method,
        "native_一",
      );
      await host.request("thread/read", { threadId: "observed" });
      expect(
        await host.request("thread/read", { threadId: "observed" }),
      ).toEqual({
        pending: true,
        nativeReplies: 0,
        farolReplies: [],
        reads: 2,
      });
      expect(await nativeRequest).toMatchObject({
        id: "native_一",
        method,
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          itemId: "native-item",
        },
      });
      // Fixture-only native owner declines exactly once. No executable command,
      // model, account, live approval or Farol control request is involved.
      const done = new Promise<void>((resolve) =>
        native.once("message", () => resolve()),
      );
      native.stdin.write(
        JSON.stringify({ id: "native_一", result: { decision: "decline" } }) +
          "\n",
      );
      await done;
      expect(
        await host.request("thread/read", { threadId: "observed" }),
      ).toEqual({
        pending: false,
        nativeReplies: 1,
        farolReplies: [],
        reads: 3,
      });
      expect(farolReplies).toEqual([]);
    },
  );
  it.each([2, "2", ""])(
    "keeps request identity %j separate across clients and namespaces",
    async (id) => {
      const { host } = await fixture(consentMethods[0]!, id);
      await host.request("thread/read", {});
      expect(await host.request("thread/read", {})).toEqual({
        pending: true,
        nativeReplies: 0,
        farolReplies: [],
        reads: 2,
      });
    },
  );
  it.each([
    "unsupported/request",
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "currentTime/read",
    "item/commandExecution/requestApproval/other",
  ])("still refuses %s without pretending to approve it", async (method) => {
    const { host } = await fixture(method, "unknown");
    await host.request("thread/read", {});
    expect(await host.request("thread/read", {})).toMatchObject({
      pending: false,
      nativeReplies: 0,
      farolReplies: [
        {
          id: "unknown",
          error: { code: -32601, message: "Method not available" },
        },
      ],
    });
  });
});

describe("owned fixture cleanup failure evidence", () => {
  it("awaits the other exit even when host close rejects", async () => {
    let observed = false;
    const peerExit = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        observed = true;
        resolve(true);
      }, 10),
    );
    await expect(
      verifyBothExits(async () => {
        throw Error("OWNED_HOST_CLOSE_FAILED");
      }, peerExit),
    ).rejects.toThrow("OWNED_HOST_CLOSE_FAILED");
    expect(observed).toBe(true);
  });
  it("does not turn a bounded unverified peer exit into cleanup success", async () => {
    await expect(
      verifyBothExits(async () => true, Promise.resolve(false)),
    ).rejects.toThrow("OWNED_PEER_EXIT_UNVERIFIED");
  });
});
