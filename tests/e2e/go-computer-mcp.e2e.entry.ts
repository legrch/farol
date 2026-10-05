import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../apps/desktop/go-core-host.ts";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser.ts";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration.ts";
import { PrivateMcpLifecycle } from "../../src/modules/computer/infra/mcp/private-mcp-lifecycle.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity.ts";

type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type RecordValue = { [key: string]: JSONValue };
function object(value: unknown): RecordValue {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as RecordValue;
}
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function bounded<T>(
  promise: Promise<T>,
  code: string,
  ms = 8000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A bounded test client speaks ordinary legacy MCP JSON-RPC lines. It owns one
// exact child and ends stdin once. No SDK negotiation sibling, signals, numeric
// process lookup, automatic restart or TERM/KILL escalation is used.
class Peer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly terminal: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private buffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private stderr = Buffer.alloc(0);
  private closed = false;
  private sequence = 0;
  private stopped: Promise<void> | undefined;
  private failure: Error | undefined;
  readonly requests: {
    id: number;
    method: string;
    tool?: string;
    state: string;
  }[] = [];
  private readonly pending = new Map<
    number,
    { resolve(value: RecordValue): void; reject(error: Error): void }
  >();
  constructor(entry: string, launch: string, home: string) {
    this.child = spawn(process.execPath, [entry, "--launch-contract", launch], {
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home },
      stdio: "pipe",
    });
    this.terminal = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.closed = true;
        for (const waiter of this.pending.values())
          waiter.reject(new Error("MCP_CHILD_CLOSED"));
        this.pending.clear();
        resolve({ code, signal });
      }),
    );
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 65536) this.fail(new Error("MCP_STDERR_LIMIT"));
      else this.stderr = Buffer.concat([this.stderr, chunk]);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        assert.ok(
          this.buffer.length + chunk.length <= 2 * 1024 * 1024,
          "MCP_FRAME_LIMIT",
        );
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const end = this.buffer.indexOf(10);
          if (end < 0) break;
          const message = object(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                this.buffer.subarray(0, end),
              ),
            ),
          );
          this.buffer = this.buffer.subarray(end + 1);
          assert.equal(message.jsonrpc, "2.0");
          assert.equal(
            typeof message.id,
            "number",
            "UNEXPECTED_MCP_NOTIFICATION",
          );
          const waiter = this.pending.get(message.id as number);
          assert.ok(waiter, "MCP_CROSSED_RESPONSE");
          this.pending.delete(message.id as number);
          waiter.resolve(message);
        }
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("MCP_INVALID_OUTPUT"),
        );
      }
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  async request(method: string, params: RecordValue): Promise<RecordValue> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("MCP_CHILD_CLOSED");
    assert.ok(!this.stopped);
    const id = ++this.sequence;
    const observation = {
      id,
      method,
      ...(method === "tools/call" && typeof params.name === "string"
        ? { tool: params.name }
        : {}),
      state: "submitted-outcome-unknown",
    };
    this.requests.push(observation);
    const response = new Promise<RecordValue>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    const result = await bounded(response, "MCP_REPLY_UNKNOWN");
    observation.state =
      result.error === undefined ? "response" : "protocol-error";
    assert.equal(result.error, undefined);
    return object(result.result);
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "farol-go-native-fixture", version: "1" },
    });
    assert.equal(result.protocolVersion, "2025-06-18");
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  }
  async call(name: string, args: RecordValue, error = false) {
    const result = await this.request("tools/call", { name, arguments: args });
    assert.equal(result.isError === true, error, name);
    return object(result.structuredContent);
  }
  close(expectedCode = 0): Promise<void> {
    this.stopped ??= (async () => {
      this.child.stdin.end();
      assert.deepEqual(
        await bounded(this.terminal, "MCP_CLEANUP_UNCONFIRMED"),
        { code: expectedCode, signal: null },
      );
      assert.equal(this.buffer.length, 0, "MCP_TRUNCATED_OUTPUT");
      if (this.failure) throw this.failure;
    })();
    return this.stopped;
  }
  async requireStartupFailure(): Promise<void> {
    // Observe spontaneous failure before any request or EOF can cause it.
    // Timeout and protocol failure never count as backend-refusal evidence.
    assert.equal(this.sequence, 0);
    assert.equal(this.child.stdin.writableEnded, false);
    assert.deepEqual(
      await bounded(this.terminal, "MCP_STARTUP_TERMINAL_UNKNOWN"),
      { code: 1, signal: null },
    );
    assert.equal(this.buffer.length, 0);
    assert.equal(
      this.stderr.toString("utf8"),
      "Farol Next Computer MCP failed to start.\n",
    );
    if (this.failure) throw this.failure;
  }
}

export async function run(input: {
  artifactRoot: string;
  build: BuildIdentity;
  artifact: unknown;
  output: string;
  report: Record<string, unknown>;
}) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  // Profile qualification rejects writable ancestors such as /private/tmp.
  // Reuse the established host-integration fixture parent under this checkout.
  const parent = path.resolve(input.output, "../../tmp");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(parent, "go-mcp-journey-")),
  );
  await fs.chmod(temporary, 0o700);
  const home = path.join(temporary, "home"),
    stateRoot = path.join(temporary, "state"),
    workspace = path.join(temporary, "workspace"),
    lifecycleRoot = path.join(temporary, "connector");
  for (const root of [home, stateRoot, workspace, lifecycleRoot])
    await fs.mkdir(root, { mode: 0o700 });
  const initialRoot = await fs.lstat(temporary, { bigint: true });
  const peers: Peer[] = [];
  let host: DesktopGoCore | undefined,
    hostClosed = false,
    providerCalls = 0,
    passed = false;
  const observations: Record<string, unknown>[] = [];
  input.report.journey = { temporary, observations };
  let primary: unknown;
  const save = () =>
    fs.writeFile(
      path.join(input.output, "report.json"),
      JSON.stringify(input.report, null, 2) + "\n",
      { mode: 0o600 },
    );
  let socketRoot: string | undefined,
    socketIdentity: import("node:fs").BigIntStats | undefined;
  try {
    await fs.writeFile(
      path.join(workspace, "AGENTS.md"),
      "Synthetic repository instructions.\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(workspace, "note space 日本語.md"),
      "computer-route-synthetic\n",
      { mode: 0o600 },
    );
    const configuration = new ProductConfigurationService(
      new ProductSettingsStore({ root: stateRoot }),
      { homeDirectory: home },
    );
    await configuration.initialize();
    const settings = () => {
      const snapshot = configuration.snapshot();
      assert.equal(snapshot.status, "ready");
      if (snapshot.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
      return snapshot.settings;
    };
    const stat = await fs.lstat(workspace, { bigint: true });
    assert.equal(
      (
        await configuration.addReadonlyWorkspace({
          root: workspace,
          label: "Synthetic MCP workspace",
          rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
        })
      ).ok,
      true,
    );
    const workspaceId = settings().computer.workspaces[0]!.workspaceId;
    assert.equal(
      (await configuration.updateWorkspaceAccess(workspaceId, "write")).ok,
      true,
    );
    const forbidden = async (): Promise<never> => {
      providerCalls++;
      throw new Error("PROVIDER_FORBIDDEN");
    };
    const driver: BrowserDriver = {
      prepare: forbidden,
      verifySend: forbidden,
      send: forbidden,
      observe: forbidden,
      cancel: forbidden,
      dispose: forbidden,
    };
    host = await startDesktopGoCore({
      previousHostDrainConfirmed: true,
      artifactRoot: input.artifactRoot,
      compiledArtifact: input.artifact,
      build: input.build,
      stateRoot,
      home,
      settings,
      browser: () => ({ driver, withdraw: () => undefined }),
    });
    // Match normal main's required storage transport before retirement can read
    // Settings. This is the existing document owner, not a fixture answer port.
    host.connectSettingsStore((profileId) => {
      const store = configuration.attachSettingsDeliveryStore({
        profileId,
        ownerId: "owner-desktop",
      });
      return {
        read: (request) => store.read(request.deadlineMillis),
        replace: (request) =>
          store.replace(request.change, request.deadlineMillis),
        fence: () => store.fence(),
      };
    });
    const challenge = randomUUID();
    const opened = await host.openComputerConnector(
      randomUUID(),
      hash("synthetic-launch"),
      hash(challenge),
      lifecycleRoot,
    );
    assert.ok(opened.launchFile && opened.launchSha256);
    assert.equal(opened.endpoint.binding.buildId, input.build.buildId);
    socketRoot = path.dirname(opened.endpoint.socketPath);
    socketIdentity = await fs.lstat(socketRoot, { bigint: true });
    observations.push({
      stage: "go-published",
      binding: opened.endpoint.binding,
      execution: opened.execution,
      launchSha256: opened.launchSha256,
    });
    await new PrivateMcpLifecycle(lifecycleRoot).prepare(opened.launchSha256);
    const connect = async () => {
      const peer = new Peer(
        path.join(input.artifactRoot, "computer-mcp.cjs"),
        opened.launchFile!,
        home,
      );
      peers.push(peer);
      await peer.initialize();
      return peer;
    };
    let peer = await connect();
    const tools = await peer.request("tools/list", {});
    assert.ok(Array.isArray(tools.tools));
    const names = tools.tools.map((value) => object(value).name);
    for (const name of [
      "computer_workspace_catalogue",
      "computer_workspace_bootstrap",
      "computer_workspace_list",
      "computer_workspace_read",
      "computer_workspace_search",
      "computer_workspace_write",
      "computer_workspace_edit",
      "computer_mutation_read",
    ])
      assert.ok(names.includes(name), name);
    assert.ok(!names.includes("computer_workspace_shell_start"));
    const catalogue = await peer.call("computer_workspace_catalogue", {});
    assert.equal(catalogue.status, "ok");
    assert.deepEqual(catalogue.context, {
      profileId: opened.endpoint.binding.profileId,
      backendGeneration: opened.endpoint.binding.backendGeneration,
    });
    const list = await peer.call("computer_workspace_list", {
      workspaceId,
      relativePath: ".",
    });
    assert.deepEqual(object(list.data).entries, [
      "AGENTS.md",
      "note space 日本語.md",
    ]);
    const bootstrap = await peer.call("computer_workspace_bootstrap", {
      workspaceId,
      relativeDirectory: ".",
    });
    assert.equal(object(bootstrap.data).complete, true);
    const read = await peer.call("computer_workspace_read", {
      workspaceId,
      relativePath: "note space 日本語.md",
    });
    assert.equal(object(read.data).text, "computer-route-synthetic\n");
    const search = await peer.call("computer_workspace_search", {
      workspaceId,
      relativePath: ".",
      pattern: "computer-route-synthetic",
    });
    assert.ok(
      Array.isArray(object(search.data).matches) &&
        (object(search.data).matches as JSONValue[]).length === 1,
    );
    const verified = await peer.call("farol_next_connector_verify", {
      workspaceId,
      challenge,
    });
    assert.equal(
      object(object(verified.data).receipt).workspaceId,
      workspaceId,
    );
    const createId = randomUUID(),
      target = "round trip.md",
      original = "old synthetic content\n";
    const created = await peer.call("computer_workspace_write", {
      operationId: createId,
      workspaceId,
      relativePath: target,
      content: original,
      expectedSha256: null,
    });
    assert.equal(object(created.data).phase, "completed");
    assert.equal(object(created.data).publication, "durable");
    assert.equal(
      await fs.readFile(path.join(workspace, target), "utf8"),
      original,
    );
    await peer.call(
      "computer_workspace_write",
      {
        operationId: createId,
        workspaceId,
        relativePath: target,
        content: "duplicate",
        expectedSha256: null,
      },
      true,
    );
    assert.equal(
      await fs.readFile(path.join(workspace, target), "utf8"),
      original,
    );
    const edited = await peer.call("computer_workspace_edit", {
      operationId: randomUUID(),
      workspaceId,
      relativePath: target,
      expectedSha256: hash(original),
      edits: [{ oldText: "old", newText: "new" }],
    });
    assert.equal(object(edited.data).phase, "completed");
    const finalBytes = await fs.readFile(path.join(workspace, target));
    assert.equal(finalBytes.toString(), "new synthetic content\n");
    await peer.close();
    peer = await connect();
    const replay = await peer.call("computer_mutation_read", {
      operationId: createId,
      workspaceId,
      relativePath: target,
    });
    const { callId: originalCall, ...originalResult } = object(created.data);
    const { callId: observationCall, ...observedResult } = object(replay.data);
    assert.notEqual(observationCall, originalCall);
    assert.deepEqual(observedResult, originalResult);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, target)),
      finalBytes,
    );
    observations.push({
      stage: "catalogue-bootstrap-read-search-create-edit-reconnect",
      tools: names,
      createOperationId: createId,
      finalSha256: hash(finalBytes),
      retainedOrigin: object(created.data).origin,
    });
    await host.withdraw();
    const revoked = await peer.call(
      "computer_workspace_read",
      {
        workspaceId,
        relativePath: target,
      },
      true,
    );
    assert.equal(revoked.status, "refused");
    assert.equal(revoked.code, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE");
    assert.equal(revoked.retry, "never");
    assert.deepEqual(revoked.context, catalogue.context);
    observations.push({
      stage: "current-authority-withdrawal",
      status: revoked.status,
      code: revoked.code,
    });
    await peer.close();
    await host.close();
    hostClosed = true;
    // One new connection to a known closed selected backend must fail. No tool
    // request/effect is submitted, and the legacy adapter cannot replace it.
    const unavailable = new Peer(
      path.join(input.artifactRoot, "computer-mcp.cjs"),
      opened.launchFile,
      home,
    );
    peers.push(unavailable);
    await unavailable.requireStartupFailure();
    await unavailable.close(1);
    assert.equal(providerCalls, 0);
    observations.push({
      stage: "closed-backend-refused-no-fallback",
      providerCalls,
    });
    passed = true;
  } catch (error) {
    primary = error;
    input.report.journeyError =
      error instanceof Error ? error.message : "unknown_failure";
  } finally {
    // Content-free correlation survives a timeout; never record tool payloads.
    input.report.requests = peers.map((peer) => ({
      pid: peer.child.pid,
      requests: peer.requests,
    }));
    let cleanup: unknown;
    for (const peer of peers) {
      try {
        await peer.close();
      } catch (error) {
        cleanup ??= error;
      }
    }
    if (host && !hostClosed) {
      try {
        await host.close();
        hostClosed = true;
      } catch (error) {
        cleanup ??= error;
      }
    }
    input.report.terminals = await Promise.all(
      peers.map(async (peer) => {
        try {
          return {
            pid: peer.child.pid,
            ...(await bounded(peer.terminal, "MCP_TERMINAL_UNKNOWN")),
          };
        } catch (error) {
          cleanup ??= error;
          return { pid: peer.child.pid, terminal: "unknown" };
        }
      }),
    );
    input.report.hostClosed = hostClosed;
    if (passed && !cleanup && hostClosed) {
      const current = await fs.lstat(temporary, { bigint: true });
      assert.equal(current.dev, initialRoot.dev);
      assert.equal(current.ino, initialRoot.ino);
      if (socketRoot && socketIdentity) {
        const selected = await fs.lstat(socketRoot, { bigint: true });
        assert.equal(selected.dev, socketIdentity.dev);
        assert.equal(selected.ino, socketIdentity.ino);
        // Native close intentionally retains an inert socket and launch file.
        // Only this successful fixture owns their removal after all exact waits.
        await fs.rm(socketRoot, { recursive: true });
      }
      await fs.rm(temporary, { recursive: true });
      input.report.cleanup = "confirmed";
    } else input.report.cleanup = "retained";
    if (cleanup)
      input.report.cleanupError =
        cleanup instanceof Error ? cleanup.message : "unknown_cleanup";
    await save();
    if (primary) throw primary;
    if (cleanup) throw cleanup;
  }
}
