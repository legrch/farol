import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SharedCodexProxyHost } from "../../src/modules/chat/infra/native/shared-codex-proxy-host";

const EXPECTED_HOME = "/fixture/codex-home";
const PROXY_FIXTURE = String.raw`
let pending = "";
let approvalBlockedRequest = null;
if (process.env.FIXTURE_MODE === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\n");
    if (end < 0) break;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (process.env.FIXTURE_MODE === "server-request" && request.id === 999) {
      if (request.error && request.error.code === -32601 && approvalBlockedRequest !== null) {
        process.stdout.write(JSON.stringify({
          id: approvalBlockedRequest,
          result: {approval: "refused"},
        }) + "\n");
      }
      continue;
    }
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        result: {
          codexHome: process.env.FIXTURE_MODE === "wrong-home"
            ? "/other/profile" : "/fixture/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "fixture",
        },
      }) + "\n");
      if (process.env.FIXTURE_MODE === "close-stdin") {
        process.stdin.destroy();
      }
    } else if (process.env.FIXTURE_MODE === "drop") {
      process.exit(0);
    } else if (process.env.FIXTURE_MODE === "wrong-id") {
      process.stdout.write(JSON.stringify({id: request.id + 1, result: {}}) + "\n");
    } else if (process.env.FIXTURE_MODE === "server-request") {
      approvalBlockedRequest = request.id;
      process.stdout.write(JSON.stringify({
        id: 999, method: "item/commandApproval/request", params: {},
      }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({
        method: "thread/status/changed", params: {threadId: "fixture-thread"},
      }) + "\n");
      process.stdout.write(JSON.stringify({
        id: request.id,
        result: {method: request.method, params: request.params},
      }) + "\n");
    }
  }
});
`;

const hosts: SharedCodexProxyHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
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
      const server = createServer((socket) => {
        let pending = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          pending += chunk;
          for (;;) {
            const end = pending.indexOf("\n");
            if (end < 0) break;
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            const message = JSON.parse(line) as {
              id?: number;
              method?: string;
            };
            if (message.id === undefined) continue;
            socket.write(
              `${JSON.stringify({
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
              })}\n`,
            );
          }
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
    await expect(host.request("thread/start", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
    await expect(host.request("thread/start", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });

  it("does not reconnect or replay when the proxy drops an acknowledgement", async () => {
    const host = fixture("drop");
    await expect(
      host.request("turn/start", { threadId: "issued-thread" }),
    ).rejects.toThrow("CODEX_SHARED_HOST_UNAVAILABLE");
    await expect(
      host.request("turn/start", { threadId: "issued-thread" }),
    ).rejects.toThrow("CODEX_SHARED_HOST_UNAVAILABLE");
  });

  it("fails closed when the proxy closes its input pipe", async () => {
    const host = fixture("close-stdin", 200);
    await host.connect();
    await expect(host.request("project/list", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
    await expect(host.request("project/list", {})).rejects.toThrow(
      "CODEX_SHARED_HOST_UNAVAILABLE",
    );
  });

  it("treats an uncorrelated response as a lost transport", async () => {
    const host = fixture("wrong-id");
    await expect(
      host.request("thread/read", { threadId: "issued-thread" }),
    ).rejects.toThrow("CODEX_SHARED_HOST_UNAVAILABLE");
  });

  it("refuses provider approval requests instead of approving them", async () => {
    const host = fixture("server-request");
    expect(await host.request("project/list", { cursor: null })).toEqual({
      approval: "refused",
    });
  });
});
