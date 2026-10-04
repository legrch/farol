import { websocketFixturePrelude } from "../fixtures/proxy-websocket";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedCodexProxyHost } from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { HandoffNotSubmittedError } from "../../src/modules/chat/app/service/persistent-codex-handoff";

const EXPECTED_HOME = "/fixture/codex-home";
const PROXY_FIXTURE =
  websocketFixturePrelude +
  String.raw`
let pending = "";
let approvalBlockedRequest = null;
let experimentalApi = false;
let initializeParams = null;
let initializeCount = 0;
let initializedCount = 0;
let closeInputRequested = false;
function closeInputWhenReady() {
  if (!closeInputRequested || initializedCount !== 1) return;
  process.stdin.once("close", () => process.send({
    kind: "input-closed", token: process.env.FIXTURE_TOKEN,
  }));
  process.stdin.destroy();
}
if (process.env.FIXTURE_MODE === "close-stdin") {
  process.once("message", (message) => {
    if (message?.kind !== "close-input" ||
        message.token !== process.env.FIXTURE_TOKEN) {
      throw new Error("FIXTURE_CONTROL_INVALID");
    }
    closeInputRequested = true;
    // Keep this owned child alive after its one-shot IPC listener is removed.
    // The test exercises a closed input pipe, not process exit; exact host
    // cleanup below remains responsible for terminal observation.
    process.channel.ref();
    closeInputWhenReady();
  });
}
if (process.env.FIXTURE_MODE === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
fixtureInput.setEncoding("utf8");
fixtureInput.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\n");
    if (end < 0) break;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const request = JSON.parse(line);
    if (process.env.FIXTURE_MODE === "initialize-refused") {
      process.stderr.write(JSON.stringify({method: request.method}) + "\n");
    }
    if (request.id === undefined) {
      if (request.method === "initialized") {
        initializedCount++;
        closeInputWhenReady();
      }
      continue;
    }
    if (process.env.FIXTURE_MODE === "server-request" && request.id === 999) {
      if (request.error && request.error.code === -32601 && approvalBlockedRequest !== null) {
        fixtureOutput.write(JSON.stringify({
          id: approvalBlockedRequest,
          result: {approval: "refused"},
        }) + "\n");
      }
      continue;
    }
    if (request.method === "initialize") {
      if (process.env.FIXTURE_MODE === "initialize-refused") {
        fixtureOutput.write(JSON.stringify({
          id: request.id, error: {code: -32600, message: "Fixture initialization refused"},
        }) + "\n");
        continue;
      }
      initializeParams = request.params;
      initializeCount++;
      experimentalApi = request.params?.capabilities?.experimentalApi === true;
      fixtureOutput.write(JSON.stringify({
        id: request.id,
        result: {
          codexHome: process.env.FIXTURE_MODE === "wrong-home"
            ? "/other/profile" : "/fixture/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "fixture",
        },
      }) + "\n");
    } else if (process.env.FIXTURE_MODE === "experimental-api" &&
        ["project/list", "thread/turns/list", "thread/items/list"].includes(request.method) &&
        (!experimentalApi || initializedCount !== 1)) {
      fixtureOutput.write(JSON.stringify({
        id: request.id,
        error: {code: -32600, message: "Experimental API negotiation required"},
      }) + "\n");
    } else if (process.env.FIXTURE_MODE === "drop") {
      process.exit(0);
    } else if (process.env.FIXTURE_MODE === "wrong-id") {
      fixtureOutput.write(JSON.stringify({id: request.id + 1, result: {}}) + "\n");
    } else if (process.env.FIXTURE_MODE === "hang") {
      // Deliberately keep this request pending without a response.
    } else if (process.env.FIXTURE_MODE === "server-request") {
      approvalBlockedRequest = request.id;
      fixtureOutput.write(JSON.stringify({
        id: 999, method: "item/commandApproval/request", params: {},
      }) + "\n");
    } else {
      fixtureOutput.write(JSON.stringify({
        method: "thread/status/changed", params: {threadId: "fixture-thread"},
      }) + "\n");
      fixtureOutput.write(JSON.stringify({
        id: request.id,
        result: {
          method: request.method,
          params: request.params,
          ...(process.env.FIXTURE_MODE === "experimental-api" ? {
            initializeParams, initializeCount, initializedCount,
          } : {}),
        },
      }) + "\n");
    }
  }
});
`;

// This control channel is separate from the transport under test. Receipt is
// emitted only after this child's stdin closes, not after sending the command.
function closeFixtureInput(
  child: ChildProcessWithoutNullStreams,
  token: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("kind" in message) ||
        message.kind !== "input-closed" ||
        !("token" in message) ||
        message.token !== token
      )
        finish(new Error("FIXTURE_INPUT_CLOSE_RECEIPT_INVALID"));
      else finish();
    };
    const onError = () => finish(new Error("FIXTURE_CONTROL_FAILED"));
    const onExit = () => finish(new Error("FIXTURE_EXITED_BEFORE_INPUT_CLOSE"));
    const timer = setTimeout(
      () => finish(new Error("FIXTURE_INPUT_CLOSE_UNCONFIRMED")),
      1_000,
    );
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    try {
      child.send({ kind: "close-input", token }, (error) => {
        if (error) onError();
      });
    } catch {
      onError();
    }
  });
}

const hosts: SharedCodexProxyHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0))
    expect(await host.closeAndWait(), "OWNED_PROXY_TERMINAL_REQUIRED").toBe(
      true,
    );
});

function fixture(mode = "normal", timeoutMs = 1_000): SharedCodexProxyHost {
  const host = new SharedCodexProxyHost(
    () =>
      spawn(process.execPath, ["-e", PROXY_FIXTURE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { FIXTURE_MODE: mode },
      }),
    EXPECTED_HOME,
    timeoutMs,
  );
  hosts.push(host);
  return host;
}

describe("shared Codex proxy transport fixture", () => {
  it("negotiates experimental API before saved project and paged task reads", async () => {
    // The selected handoff protocol uses experimental project and pagination
    // methods. This pipe-only fixture reproduces the documented opt-in gate;
    // it never contacts an installed Codex server or an owner profile.
    const host = fixture("experimental-api");
    try {
      for (const method of [
        "project/list",
        "thread/turns/list",
        "thread/items/list",
      ]) {
        const params =
          method === "project/list"
            ? { cursor: null }
            : { threadId: "fixture-thread" };
        expect(await host.request(method, params)).toEqual({
          method,
          params,
          initializeParams: {
            clientInfo: { name: "farol-shared-handoff", version: "1" },
            capabilities: { experimentalApi: true },
          },
          initializeCount: 1,
          initializedCount: 1,
        });
      }
      await expect(host.request("thread/delete", {})).rejects.toThrow(
        "CODEX_SHARED_METHOD_DENIED",
      );
    } finally {
      expect(await host.closeAndWait()).toBe(true);
    }
  });

  it("sends no task frame or replacement connection after initialization refusal", async () => {
    let observed = "";
    const launch = vi.fn(() => {
      const child = spawn(process.execPath, ["-e", PROXY_FIXTURE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { FIXTURE_MODE: "initialize-refused" },
      });
      child.stderr.on("data", (chunk: Buffer) => {
        observed += chunk.toString();
      });
      return child;
    });
    const host = new SharedCodexProxyHost(launch, EXPECTED_HOME);
    hosts.push(host);
    try {
      await expect(host.request("thread/start", {})).rejects.toMatchObject({
        diagnostic: {
          phase: "initialize",
          method: "initialize",
          result: "rpc_error",
          rpcCode: -32600,
        },
      });
      await expect(host.request("thread/start", {})).rejects.toBeInstanceOf(
        HandoffNotSubmittedError,
      );
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      expect(await host.closeAndWait()).toBe(true);
    }
    expect(
      observed
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method),
    ).toEqual(["initialize"]);
  });

  it("forwards scoped database-only task metadata without creating work", async () => {
    const host = fixture();
    const params = {
      projectId: "project",
      cwd: "/fixture/writer",
      cursor: null,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    };
    expect(await host.request("thread/list", params)).toEqual({
      method: "thread/list",
      params,
    });
    expect(await host.closeAndWait()).toBe(true);
  });
  it("forwards only the supported title setter on the owned proxy fixture", async () => {
    const host = fixture();
    expect(
      await host.request("thread/name/set", {
        threadId: "fixture",
        name: "Title",
      }),
    ).toEqual({
      method: "thread/name/set",
      params: { threadId: "fixture", name: "Title" },
    });
    expect(await host.closeAndWait()).toBe(true);
  });
  it("does not write a read frame when admission expires while connection completes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    let child: ChildProcessWithoutNullStreams | undefined;
    const host = new SharedCodexProxyHost(() => {
      child = spawn(process.execPath, ["-e", PROXY_FIXTURE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { FIXTURE_MODE: "normal" },
      });
      return child;
    }, EXPECTED_HOME);
    hosts.push(host);
    try {
      await host.connect();
      if (!child) throw new Error("Owned fixture process missing");
      const writes = vi.spyOn(child.stdin, "write");
      const connect = host.connect.bind(host);
      vi.spyOn(host, "connect").mockImplementation(async () => {
        await connect();
        clock.mockReturnValue(3000);
      });
      await expect(
        host.request("thread/read", { threadId: "selected" }, 2000),
      ).rejects.toThrow("CODEX_SHARED_DEADLINE_EXPIRED");
      expect(writes).not.toHaveBeenCalled();
      expect(await host.closeAndWait()).toBe(true);
    } finally {
      clock.mockRestore();
      await host.closeAndWait();
    }
  });
  it.skipIf(!process.env.FAROL_CODEX_PROXY_BINARY)(
    "uses the installed CLI proxy against only a disposable owned socket",
    async () => {
      const binary = process.env.FAROL_CODEX_PROXY_BINARY;
      if (!binary) throw new Error("CODEX_BINARY_REQUIRED");
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-proxy-fixture-"),
      );
      const canonicalRoot = await fs.realpath(root);
      const socketPath = path.join(canonicalRoot, "control.sock");
      const server = createServer();
      const websocket = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) => {
        expect(request.url).toBe("/rpc");
        websocket.handleUpgrade(request, socket, head, (peer) => {
          peer.on("message", (data) => {
            const message = JSON.parse(data.toString()) as {
              id?: number;
              method?: string;
            };
            if (message.id === undefined) return;
            peer.send(
              JSON.stringify({
                id: message.id,
                result:
                  message.method === "initialize"
                    ? {
                        codexHome: EXPECTED_HOME,
                        platformFamily: "unix",
                        platformOs: "macos",
                        userAgent: "fixture",
                      }
                    : {
                        data: [{ id: "saved-project", roots: [] }],
                        nextCursor: null,
                      },
              }),
            );
          });
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        const digest = createHash("sha256")
          .update(await fs.readFile(binary))
          .digest("hex");
        const host = await SharedCodexProxyHost.attach({
          executablePath: binary,
          executableSha256: digest,
          socketPath,
          cwd: canonicalRoot,
          expectedCodexHome: EXPECTED_HOME,
        });
        hosts.push(host);
        expect(await host.request("project/list", { cursor: null })).toEqual({
          data: [{ id: "saved-project", roots: [] }],
          nextCursor: null,
        });
        expect(await host.closeAndWait()).toBe(true);
      } finally {
        for (const peer of websocket.clients) peer.terminate();
        await new Promise<void>((resolve) => websocket.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
  it("initializes one client and reads through it despite notifications", async () => {
    const host = fixture();
    expect(await host.request("project/list", { cursor: null })).toEqual({
      method: "project/list",
      params: { cursor: null },
    });
    expect(
      await host.request("thread/read", { threadId: "fixture-thread" }),
    ).toEqual({
      method: "thread/read",
      params: { threadId: "fixture-thread" },
    });
    await expect(host.request("thread/delete", {})).rejects.toThrow(
      "CODEX_SHARED_METHOD_DENIED",
    );
  });

  it("waits for its exact proxy process to exit before confirming shutdown", async () => {
    let ownedChild: ChildProcessWithoutNullStreams | undefined;
    const host = new SharedCodexProxyHost(() => {
      ownedChild = spawn(process.execPath, ["-e", PROXY_FIXTURE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { FIXTURE_MODE: "normal" },
      });
      return ownedChild;
    }, EXPECTED_HOME);
    hosts.push(host);
    await host.connect();
    expect(ownedChild?.pid).toBeDefined();
    expect(await host.closeAndWait()).toBe(true);
    expect(
      ownedChild?.exitCode !== null || ownedChild?.signalCode !== null,
    ).toBe(true);
    expect(await host.closeAndWait()).toBe(true);
  });

  it("escalates only its own unresponsive proxy and waits for exit", async () => {
    const host = fixture("ignore-term");
    await host.connect();
    expect(await host.closeAndWait()).toBe(true);
  });

  it("confirms shutdown when no proxy was ever launched", async () => {
    const host = fixture();
    expect(await host.closeAndWait()).toBe(true);
  });

  it("refuses a different serving profile before a task request", async () => {
    const host = fixture("wrong-home");
    await expect(host.request("thread/start", {})).rejects.toBeInstanceOf(
      HandoffNotSubmittedError,
    );
    await expect(host.request("thread/start", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });

  it("does not reconnect or replay when the proxy drops an acknowledgement", async () => {
    const host = fixture("drop");
    await expect(
      host.request("turn/start", { threadId: "issued-thread" }),
    ).rejects.not.toBeInstanceOf(HandoffNotSubmittedError);
    await expect(
      host.request("turn/start", { threadId: "issued-thread" }),
    ).rejects.toThrow("CODEX_SHARED_HOST_UNAVAILABLE");
  });

  it("classifies capacity refusal before write without reclassifying pending requests", async () => {
    const host = fixture("hang", 1_000);
    await host.connect();
    const pending = Array.from({ length: 8 }, (_, index) =>
      host.request("thread/read", { threadId: `pending-${index}` }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      host.request("turn/steer", {
        threadId: "issued-thread",
        expectedTurnId: "issued-turn",
        input: [{ type: "text", text: "one" }],
      }),
    ).rejects.toBeInstanceOf(HandoffNotSubmittedError);
    host.close();
    const outcomes = await Promise.allSettled(pending);
    expect(outcomes).toHaveLength(8);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          !(outcome.reason instanceof HandoffNotSubmittedError),
      ),
    ).toBe(true);
  });

  it("fails closed when the proxy closes its input pipe", async () => {
    const token = randomUUID();
    let child: ChildProcessWithoutNullStreams | undefined;
    const launch = vi.fn(() => {
      // The first three descriptors are pipes; the fourth is fixture-only IPC.
      child = spawn(process.execPath, ["-e", PROXY_FIXTURE], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { FIXTURE_MODE: "close-stdin", FIXTURE_TOKEN: token },
      }) as ChildProcessWithoutNullStreams;
      return child;
    });
    const host = new SharedCodexProxyHost(launch, EXPECTED_HOME);
    hosts.push(host);
    try {
      await host.connect();
      if (!child) throw new Error("Owned fixture process missing");
      await closeFixtureInput(child, token);
      const failure = await host
        .request("project/list", {})
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        message: "CODEX_SHARED_HOST_UNAVAILABLE",
        diagnostic: { phase: "request", method: "project/list" },
      });
      // Closing the peer's Node input stream does not promise an immediate
      // kernel EPIPE. Buffered writes may instead reach the bounded response
      // timeout. Neither observation proves that the request was not submitted.
      expect(failure).not.toBeInstanceOf(HandoffNotSubmittedError);
      expect(["pipe_failed", "timeout"]).toContain(
        (failure as { diagnostic: { result: string } }).diagnostic.result,
      );
      await expect(host.request("project/list", {})).rejects.toThrow(
        "CODEX_SHARED_HOST_UNAVAILABLE",
      );
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      expect(await host.closeAndWait()).toBe(true);
    }
  });

  it("treats an uncorrelated response as a lost transport", async () => {
    const host = fixture("wrong-id");
    await expect(
      host.request("thread/read", { threadId: "issued-thread" }),
    ).rejects.toThrow("CODEX_SHARED_HOST_UNAVAILABLE");
  });

  it("refuses an unsupported provider method without approving it", async () => {
    const host = fixture("server-request");
    expect(await host.request("project/list", { cursor: null })).toEqual({
      approval: "refused",
    });
  });
});
