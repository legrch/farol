import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  BUDGETS,
  Peer,
  WitnessDiagnostics,
  diagnosticCode,
} from "./go-computer-mcp.diagnostics.ts";
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

export async function run(input: {
  artifactRoot: string;
  build: BuildIdentity;
  artifact: unknown;
  output: string;
  report: Record<string, unknown>;
}) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const diagnostics = new WitnessDiagnostics(
    input.report,
    async (serialized) => {
      // Same-directory rename prevents a crash leaving partial JSON. Writes are serialized.
      const pending = path.join(input.output, "report.pending.json");
      await fs.writeFile(pending, serialized, { mode: 0o600 });
      await fs.rename(pending, path.join(input.output, "report.json"));
    },
  );
  await diagnostics.checkpoint("journey-before");
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
  Object.defineProperty(input.report, "requests", {
    enumerable: true,
    get: () => peers.map((peer) => peer.snapshot()),
  });
  const go = {
    start: "not-requested",
    close: "not-requested",
    retirement: "unobserved",
    terminal: "not-exposed-by-host",
  };
  input.report.go = go;
  const spawnPeer = (launch: string) => {
    const child = spawn(
      process.execPath,
      [
        path.join(input.artifactRoot, "computer-mcp.cjs"),
        "--launch-contract",
        launch,
      ],
      {
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home },
        stdio: "pipe",
      },
    );
    const peer = new Peer(child, diagnostics);
    peers.push(peer);
    return peer;
  };
  let hostCloseResult: Promise<void> | undefined;
  const closeHost = (): Promise<void> => {
    hostCloseResult ??= (async () => {
      assert.ok(host);
      go.close = "requested-outcome-unknown";
      await diagnostics.stage(
        "go-close",
        BUDGETS.hostCleanup,
        "HOST_CLEANUP_UNCONFIRMED",
        async () => {
          await host!.close();
          hostClosed = true;
          go.close = "returned";
          // Public host close aggregates retirement and child drain. It exposes no
          // individual ACK/terminal facts; do not manufacture them from MCP EOF.
          go.retirement = "host-close-returned-no-separate-receipt";
        },
        true,
      );
    })();
    return hostCloseResult;
  };
  Object.defineProperty(input.report, "unresolvedEffects", {
    enumerable: true,
    get: () => {
      const unresolved: unknown[] = peers.flatMap((peer, index) => [
        ...peer.requests
          .filter(
            (request) =>
              request.state === "failed-outcome-unknown" &&
              request.stdinWrite !== "not-submitted" &&
              request.response === "unobserved",
          )
          .map((request) => ({
            peer: index,
            id: request.id,
            method: request.method,
            ...(request.tool ? { tool: request.tool } : {}),
            state: "reply-unknown-never-retry",
          })),
        ...(peer.terminalFacts
          ? []
          : [{ peer: index, state: "mcp-terminal-unknown" }]),
      ]);
      if (host && !hostClosed)
        unresolved.push({
          state: "go-close-unconfirmed",
        });
      if (go.start === "requested-outcome-unknown")
        unresolved.push({ state: "go-start-unconfirmed" });
      return unresolved;
    },
  });
  let primary: unknown;
  const save = () => diagnostics.checkpoint("journey-final");
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
    await diagnostics.stage(
      "settings-initialize",
      BUDGETS.initialize,
      "WITNESS_PHASE_UNKNOWN",
      () => configuration.initialize(),
    );
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
    go.start = "requested-outcome-unknown";
    host = await diagnostics.stage(
      "go-start",
      BUDGETS.initialize,
      "HOST_STARTUP_UNKNOWN",
      async () => {
        // Retain the returned owner even if its after-checkpoint cannot persist.
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
        go.start = "returned";
        return host;
      },
    );
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
    const opened = await diagnostics.stage(
      "go-connector-open",
      BUDGETS.initialize,
      "HOST_OPEN_UNKNOWN",
      () =>
        host!.openComputerConnector(
          randomUUID(),
          hash("synthetic-launch"),
          hash(challenge),
          lifecycleRoot,
        ),
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
    await diagnostics.stage(
      "mcp-lifecycle-prepare",
      BUDGETS.initialize,
      "WITNESS_PHASE_UNKNOWN",
      () =>
        new PrivateMcpLifecycle(lifecycleRoot).prepare(opened.launchSha256!),
    );
    const connect = async () => {
      await diagnostics.checkpoint("mcp-spawn-before");
      const peer = spawnPeer(opened.launchFile!);
      await diagnostics.checkpoint("mcp-spawn-after");
      await peer.initialize();
      await diagnostics.checkpoint("mcp-initialize-returned", {
        stdioReady: "initialize-response-observed",
        socketHandshake: "not-separately-observed",
      });
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
    await diagnostics.stage(
      "go-withdraw",
      BUDGETS.request,
      "HOST_WITHDRAW_UNKNOWN",
      () => host!.withdraw(),
    );
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
    await closeHost();
    // One new connection to a known closed selected backend must fail. No tool
    // request/effect is submitted, and the legacy adapter cannot replace it.
    await diagnostics.checkpoint("mcp-unavailable-spawn-before");
    const unavailable = spawnPeer(opened.launchFile);
    await diagnostics.checkpoint("mcp-unavailable-spawn-after");
    await diagnostics.stage(
      "mcp-startup-refusal",
      BUDGETS.initialize,
      "MCP_STARTUP_TERMINAL_UNKNOWN",
      () => unavailable.requireStartupFailure(),
    );
    await unavailable.close(1);
    assert.equal(providerCalls, 0);
    observations.push({
      stage: "closed-backend-refused-no-fallback",
      providerCalls,
    });
    passed = true;
  } catch (error) {
    primary = error;
    input.report.journeyError = diagnosticCode(error);
  } finally {
    // Persist the first failure before touching cleanup, even if a close hangs.
    input.report.cleanup = "pending";
    let cleanup: unknown;
    const cleanupFailures: string[] = [];
    const noteCleanup = (error: unknown) => {
      cleanup ??= error;
      cleanupFailures.push(diagnosticCode(error));
      input.report.cleanupErrors = cleanupFailures;
    };
    try {
      await diagnostics.checkpoint("cleanup-before");
    } catch (error) {
      noteCleanup(error);
    }
    for (const peer of peers) {
      try {
        await peer.close();
      } catch (error) {
        noteCleanup(error);
      }
    }
    if (host && !hostClosed) {
      try {
        await closeHost();
      } catch (error) {
        noteCleanup(error);
      }
    }
    // Terminal events are retained by Peer independently of close validation.
    // Do not spend another timeout or call close again to obtain these facts.
    input.report.terminals = peers.map((peer) => ({
      pid: peer.child.pid,
      ...(peer.terminalFacts ?? { terminal: "unknown" }),
    }));
    input.report.hostClosed = hostClosed;
    input.report.cleanup = "retained";
    if (passed && !cleanup && hostClosed) {
      try {
        await diagnostics.stage(
          "fixture-remove",
          BUDGETS.mcpCleanup,
          "WITNESS_PHASE_UNKNOWN",
          async () => {
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
          },
        );
        input.report.cleanup = "confirmed";
      } catch (error) {
        noteCleanup(error);
      }
    }
    if (cleanup) input.report.cleanupError = diagnosticCode(cleanup);
    try {
      await save();
    } catch (error) {
      noteCleanup(error);
    }
    if (cleanup) input.report.cleanupError = diagnosticCode(cleanup);
    if (primary) throw primary;
    if (cleanup) throw cleanup;
  }
}
