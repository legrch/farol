import {
  clientMessages,
  websocketFixturePrelude,
} from "../fixtures/proxy-websocket";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexProxyFailure,
  SharedCodexProxyHost,
} from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import {
  codexTaskRouteFailureCode,
  codexTaskRouteFailureRecord,
  codexTaskRouteRefusalRecord,
} from "../../src/apps/desktop/codex-task-route-error";
import { HandoffNotSubmittedError } from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract";

// Disposable Node child only. No Codex binary, socket, account, or owner app.
const SCRIPT =
  websocketFixturePrelude +
  String.raw`
let input = "";
process.stderr.write("private stderr /Users/owner/account\n");
fixtureInput.setEncoding("utf8");
fixtureInput.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) return;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      if (process.env.MODE === "timeout") continue;
      if (process.env.MODE === "exit") process.exit(7);
      if (process.env.MODE === "malformed") {
        fixtureOutput.write("{private invalid frame\n");
        continue;
      }
      if (process.env.MODE === "rpc-init") {
        fixtureOutput.write(JSON.stringify({id: request.id, error: {
          code: -32601, message: "private /Users/owner/account"
        }}) + "\n");
        continue;
      }
      fixtureOutput.write(JSON.stringify({id: request.id, result: {
        codexHome: process.env.MODE === "identity" ? "/private/home" : "/fixture/home",
        platformFamily: "unix", platformOs: "macos", userAgent: "fixture"
      }}) + "\n");
    } else if (request.id !== undefined && process.env.MODE === "rpc-request") {
      fixtureOutput.write(JSON.stringify({id: request.id, error: {
        code: -32001, message: "private request payload"
      }}) + "\n");
    }
  }
});
`;

const hosts: SharedCodexProxyHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0))
    expect(await host.closeAndWait()).toBe(true);
});

function fixture(mode: string) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let launches = 0;
  const host = new SharedCodexProxyHost(
    () => {
      launches++;
      child = spawn(process.execPath, ["-e", SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { MODE: mode },
      });
      return child;
    },
    "/fixture/home",
    // Only the explicit timeout scenario needs a short deadline. Other cases
    // must allow the disposable process to start under full-CI contention.
    mode === "timeout" ? 200 : 2000,
  );
  hosts.push(host);
  return { host, child: () => child, launches: () => launches };
}

describe("shared proxy closed diagnostics", () => {
  it.each([
    "model_policy",
    "workspace_identity",
    "project_root",
    "git_identity",
    "project_catalogue",
  ] as const)(
    "records the refused %s predicate without owner data",
    (phase) => {
      expect(JSON.parse(codexTaskRouteRefusalRecord(phase))).toEqual({
        code: "CODEX_TASK_ROUTE_REFUSED",
        phase,
        result: "refused",
      });
    },
  );
  it("records the phase and numeric RPC code without private exception details", () => {
    expect(
      JSON.parse(
        codexTaskRouteFailureRecord(
          new CodexProxyFailure({
            phase: "request",
            method: "project/list",
            result: "rpc_error",
            rpcCode: -32600,
          }),
        ),
      ),
    ).toEqual({
      code: "CODEX_SHARED_PROXY_RPC_ERROR",
      phase: "request",
      method: "project/list",
      result: "rpc_error",
      rpcCode: -32600,
    });
    expect(
      codexTaskRouteFailureRecord(new Error("private /Users/account")),
    ).not.toMatch(/private|account/);
    expect(
      codexTaskRouteFailureRecord(
        new CodexProxyFailure({
          phase: "request",
          method: "private payload",
          result: "rpc_error",
        }),
      ),
    ).not.toContain("private");
  });
  it("classifies a launcher exception without retaining it or retrying", async () => {
    const launch = vi.fn((): ChildProcessWithoutNullStreams => {
      throw new Error("private executable path /Users/owner/codex");
    });
    const host = new SharedCodexProxyHost(launch, "/fixture/home");
    hosts.push(host);
    const error = await host.connect().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexProxyFailure);
    expect((error as CodexProxyFailure).diagnostic).toEqual({
      phase: "initialize",
      method: "initialize",
      result: "launch_failed",
    });
    expect(codexTaskRouteFailureCode(error)).toBe(
      "CODEX_SHARED_PROXY_LAUNCH_FAILED",
    );
    expect(JSON.stringify(error)).not.toMatch(/private|owner|codex/u);
    await expect(host.request("thread/start", {})).rejects.toBeInstanceOf(
      HandoffNotSubmittedError,
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("classifies a pipe error and cleans the one owned child", async () => {
    const f = fixture("timeout");
    const connection = f.host.connect().catch((cause: unknown) => cause);
    f.child()?.stdin.emit("error", new Error("private pipe path"));
    const error = await connection;
    expect(error).toBeInstanceOf(CodexProxyFailure);
    expect((error as CodexProxyFailure).diagnostic).toEqual({
      phase: "initialize",
      method: "initialize",
      result: "pipe_failed",
    });
    expect(codexTaskRouteFailureCode(error)).toBe(
      "CODEX_SHARED_PROXY_PIPE_FAILED",
    );
    expect(JSON.stringify(error)).not.toContain("private");
    expect(f.launches()).toBe(1);
    expect(await f.host.closeAndWait()).toBe(true);
  });

  it.each([
    ["timeout", "timeout", "CODEX_SHARED_PROXY_TIMEOUT"],
    ["exit", "exited", "CODEX_SHARED_PROXY_EXITED"],
    ["malformed", "invalid_protocol", "CODEX_SHARED_PROXY_PROTOCOL_ERROR"],
    ["identity", "invalid_identity", "CODEX_SHARED_PROXY_INVALID_IDENTITY"],
    ["rpc-init", "rpc_error", "CODEX_SHARED_PROXY_RPC_ERROR"],
  ] as const)(
    "classifies %s initialization and cleans the child",
    async (mode, result, code) => {
      const f = fixture(mode);
      const error = await f.host.connect().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CodexProxyFailure);
      expect((error as CodexProxyFailure).diagnostic).toMatchObject({
        phase: "initialize",
        method: "initialize",
        result,
        ...(mode === "rpc-init" ? { rpcCode: -32601 } : {}),
      });
      expect(codexTaskRouteFailureCode(error)).toBe(code);
      expect(
        ProductConfigurationResultSchema.safeParse({
          ok: false,
          error: code,
          snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
        }).success,
      ).toBe(true);
      expect(JSON.stringify(error)).not.toMatch(/private|owner|account/u);
      await expect(f.host.request("thread/start", {})).rejects.toBeInstanceOf(
        HandoffNotSubmittedError,
      );
      expect(f.launches()).toBe(1);
      expect(await f.host.closeAndWait()).toBe(true);
      expect(
        f.child()?.exitCode !== null || f.child()?.signalCode !== null,
      ).toBe(true);
    },
  );

  it("surfaces an idle child exit without submitting or relaunching", async () => {
    const f = fixture("hang-request");
    await f.host.connect();
    const child = f.child();
    if (!child) throw new Error("Disposable child missing");
    const writes = vi.spyOn(child.stdin, "write");
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await exited;
    const error = await f.host
      .request("project/list", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HandoffNotSubmittedError);
    expect(JSON.parse(codexTaskRouteFailureRecord(error))).toEqual({
      code: "CODEX_SHARED_PROXY_EXITED",
      phase: "idle",
      method: "none",
      result: "exited",
    });
    expect(writes).not.toHaveBeenCalled();
    expect(f.launches()).toBe(1);
  });

  it("keeps a sent RPC refusal distinct from a pre-send refusal", async () => {
    const f = fixture("rpc-request");
    const error = await f.host
      .request("thread/read", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexProxyFailure);
    expect((error as CodexProxyFailure).diagnostic).toEqual({
      phase: "request",
      method: "thread/read",
      result: "rpc_error",
      rpcCode: -32001,
    });
    expect(error).not.toBeInstanceOf(HandoffNotSubmittedError);
    expect(JSON.stringify(error)).not.toMatch(/private|payload|owner/u);
    expect(f.launches()).toBe(1);
  });

  it("keeps a sent timeout outcome unknown and never replays", async () => {
    const f = fixture("hang-request");
    await f.host.connect();
    const child = f.child();
    if (!child) throw new Error("Disposable child missing");
    const writes = vi.spyOn(child.stdin, "write");
    const error = await f.host
      .request("turn/start", {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexProxyFailure);
    expect(error).not.toBeInstanceOf(HandoffNotSubmittedError);
    expect((error as CodexProxyFailure).diagnostic).toEqual({
      phase: "request",
      method: "turn/start",
      result: "timeout",
    });
    expect(f.host.terminalDiagnostic()).toEqual(
      (error as CodexProxyFailure).diagnostic,
    );
    await expect(f.host.request("turn/start", {})).rejects.toBeInstanceOf(
      HandoffNotSubmittedError,
    );
    expect(clientMessages(writes.mock.calls.map(([bytes]) => bytes))).toEqual([
      { id: 2, method: "turn/start", params: {} },
    ]);
    expect(f.launches()).toBe(1);
    expect(await f.host.closeAndWait()).toBe(true);
  });
});
