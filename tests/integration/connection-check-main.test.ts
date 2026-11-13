import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import {
  runExplicitConnectionCheck,
  ConnectionCheckRefusal,
  connectionCheckDigest,
  connectionCheckRuntimeReady,
  type ExplicitConnectionCheck,
} from "../../apps/desktop/connection-check-command.ts";
import { prepareConnectorCheckDocument } from "../../apps/desktop/bridge/connector-check-readiness.ts";
import { connectorVerificationProof } from "../../src/apps/desktop/connector-verification-proof.ts";
import { currentConnectorAttachment } from "../../src/apps/desktop/connector-app-receipt-wait.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import { createGoComputerMcpServer } from "../../apps/desktop/bridge/computer-mcp.ts";
import { selectedConnectorApp } from "../../src/pkg/product-settings/connector-app-selection.ts";
import { connectorWorkspaceSelection } from "../../src/pkg/product-settings/connector-workspace-selection.ts";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../src/pkg/product-settings/contract.ts";
import type { ChatGptTaskObserver } from "../../src/apps/desktop/chatgpt-route.ts";
import type {
  ComputerCheckPrepareRequest,
  ComputerCheckAdvanceRequest,
  ComputerCheckObserveResponse,
} from "../../apps/desktop/bridge/wire.ts";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding.ts";

// Execute the ACTUAL Main function plus actual coordinator/readiness/parser
// seams. Go IPC, Electron and Settings persistence are scripted ports here;
// native Store and real public socket qualification remain separate gates.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const declaration = ["connectorAppBindingCurrent", "testConnectionCommand"]
  .map((name) => {
    const node = tree.program.body.find(
      (x) => x.type === "FunctionDeclaration" && x.id?.name === name,
    );
    if (!node || node.start == null || node.end == null)
      throw Error(`Missing actual Main seam: ${name}`);
    return source.slice(node.start, node.end);
  })
  .join("\n");
const setupNode = tree.program.body.find(
  (node) =>
    node.type === "FunctionDeclaration" &&
    node.id?.name === "verifySecureMcpApp",
)!;
const setupDeclaration = source.slice(setupNode.start!, setupNode.end!);
const originalId = "0311add3-b03c-4f89-b916-aea6a0a39242";
const checkId = "49a0cb44-5c67-4aae-9b56-41db024507d3";
const digest = "d".repeat(64);
const command: ExplicitConnectionCheck = {
  kind: "connector.test-connection",
  operationId: originalId,
  taskId: "",
};
function fixture(mode: "bootstrap" | "status" = "bootstrap", empty = false) {
  const settings = guidedSettingsFixture();
  if (empty) settings.computer.workspaces = [];
  const connector = settings.connectors.secureMcp;
  connector.chatgptApp = {
    name: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: connector.generation,
  };
  connector.challenge = {
    value: "00000000-0000-4000-8000-000000000003",
    challengeSha256: connectionCheckDigest(
      "00000000-0000-4000-8000-000000000003",
    ),
    runtimeGeneration: "b".repeat(64),
    computerGeneration: 1,
    buildId: fixtureBuildId,
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  if (mode === "bootstrap") connector.attachment = null;
  else
    connector.attachment = {
      ...connector.attachment!,
      challengeSha256: connector.challenge.challengeSha256,
      workspaceId: empty ? null : fixtureWorkspaceId,
    };
  connector.appVerificationPending = false;
  settings.setup.connect.outcomeUnknown = false;
  settings.setup.journey.dismissed = true; // historical setup completion is not current attachment
  const events: string[] = [];
  let phase: ComputerCheckObserveResponse["phase"] = "claimed";
  let first = true,
    receiptAvailable = false;
  let sends = 0;
  let armedCheckId: string | undefined;
  const authenticated = {
    state: "authenticated" as const,
    binding: { sequence: 1, documentGeneration: 1 },
  };
  const route = {
    open: async () => ({ status: "opened" as const }),
    openTemporaryChat: async () => ({ status: "opened" as const }),
    captureManualTaskTarget: vi.fn(() => () => true),
    hasPendingReadinessDocument: () => false,
    observeSignInStatus: vi.fn(async () => authenticated),
    isCurrentSignInStatus: (value: unknown) => value === authenticated,
    openConnectionCheckChat: vi.fn(async () => {
      events.push("temporary-document");
      return { status: "opened" };
    }),
    captureConnectionCheckDocument: vi.fn(() => ({
      identity: "retained-physical-document",
      current: () => true,
    })),
    runReadonlyTask: vi.fn(
      async (
        prompt: string,
        attachments: unknown[],
        observer: ChatGptTaskObserver,
      ) => {
        events.push("browser");
        expect(attachments).toEqual([]);
        expect(observer.connectionCheck).toBe(true);
        expect(prompt).toContain(
          mode === "status" ? checkId : "bootstrap-original",
        );
        await observer.onDispatchIntent!();
        if (!observer.beforeSend!())
          return {
            state: "failed_before_submit",
            code: "CHATGPT_APP_SELECTION_LOST",
          };
        sends++;
        events.push("send");
        await observer.onSendAcknowledged!();
        receiptAvailable = true;
        expect(await observer.readConnectorReceipt!()).toBe(true);
        return { state: "completed", code: null };
      },
    ),
  };
  const binding = {
    buildId: fixtureBuildId,
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: "1",
  };
  const proof = {
    binding,
    ...(mode === "bootstrap"
      ? {}
      : empty
        ? {
            catalogueReceipt: {
              binding,
              challengeSha256: connector.challenge.challengeSha256,
              workspaceCount: 0,
            },
          }
        : {
            receipt: {
              binding,
              challengeSha256: connector.challenge.challengeSha256,
              workspaceId: fixtureWorkspaceId,
            },
          }),
  };
  const core = {
    observeComputerConnectorVerification: vi.fn(async () => proof),
    claimConnectionCheck: vi.fn(async () => {
      events.push("claim");
      const fresh = first;
      first = false;
      return { operationId: originalId, phase, first: fresh };
    }),
    prepareConnectionCheck: vi.fn(
      async (input: ComputerCheckPrepareRequest) => {
        events.push("prepare");
        phase = "prepared";
        expect(input.mode).toBe(mode);
        const prompt =
          mode === "status"
            ? `computer_connection_status ONCE with the exact argument checkId "${checkId}"`
            : "bootstrap-original";
        return {
          operationId: originalId,
          phase,
          mode,
          ...(mode === "status" ? { checkId } : {}),
          prompt,
          promptDigest: connectionCheckDigest(prompt),
          scopeDigest: digest,
          documentDigest: input.documentDigest,
        };
      },
    ),
    advanceConnectionCheck: vi.fn(
      async (input: ComputerCheckAdvanceRequest) => {
        events.push(input.stage);
        phase =
          input.stage === "dispatch"
            ? "dispatch_intent"
            : input.stage === "sent"
              ? "send_acknowledged"
              : input.stage === "confirm"
                ? "verified"
                : input.stage === "refuse"
                  ? "refused_before_send"
                  : "outcome_unknown";
        if (input.stage === "dispatch" && mode === "status")
          armedCheckId = checkId;
        return {
          operationId: originalId,
          phase,
          sendAuthorized: input.stage === "dispatch",
          ...(phase === "verified" ? { receiptDigest: digest } : {}),
        };
      },
    ),
    observeConnectionCheck: vi.fn(
      async (): Promise<ComputerCheckObserveResponse> => ({
        operationId: originalId,
        phase,
        ...(phase === "claimed"
          ? {}
          : { mode, ...(mode === "status" ? { checkId } : {}) }),
        ...(phase === "verified" ? { receiptDigest: digest } : {}),
        delivery: "not_recorded",
        receiptAvailable,
      }),
    ),
  };
  const snapshot = () => ({ status: "ready" as const, settings });
  const publish = vi.fn(async () => {
    events.push("settings");
    expect(phase).toBe("verified");
    return { ok: true, snapshot: snapshot() };
  });
  const legacyExists = vi.fn(async () => false);
  const context = vm.createContext({
    runExplicitConnectionCheck,
    ConnectionCheckRefusal,
    connectionCheckDigest,
    connectionCheckRuntimeReady,
    prepareConnectorCheckDocument,
    connectorVerificationProof,
    currentConnectorAttachment,
    randomUUID: () => originalId,
    selectedConnectorApp,
    connectorWorkspaceSelection,
    ProductConfigurationResultSchema,
    desktopGoCore: core,
    configuration: { snapshot },
    chatGptRoute: route,
    window: { isDestroyed: () => false },
    selectedTaskId: "",
    liveTaskRoutes: new Map(),
    embeddedBrowserEnabled: () => true,
    chatGptTaskAdmissionReady: () => true,
    chatGptTaskAdmission: false,
    connectorTaskAdmission: false,
    quitInProgress: false,
    installedUpdateAdmission: false,
    buildIdentity: { buildId: fixtureBuildId },
    runtimeEnvironment: "test",
    secureMcpConnectorRuntime: {
      isRunning: () => true,
      hasUnresolvedEffect: () => false,
    },
    secureMcpLaunchRoot: () => "/synthetic-c8-no-filesystem",
    connectorAppVerificationAttemptExists: legacyExists,
    connectorConnection: { sample: async () => {} },
    currentConnectionStatus: () => {},
    checkSecureMcpAttachment: publish,
    configurationFailure: (error: string) => ({
      ok: false,
      error,
      snapshot: snapshot(),
    }),
  });
  const run = vm.runInContext(
    stripTypeScriptTypes(declaration + "\ntestConnectionCommand;", {
      mode: "strip",
    }),
    context,
  ) as (input: ExplicitConnectionCheck) => Promise<ProductConfigurationResult>;
  return {
    run: () => run(command),
    context,
    route,
    core,
    settings,
    events,
    publish,
    legacyExists,
    sends: () => sends,
    runSetup: () =>
      vm.runInContext(
        stripTypeScriptTypes(setupDeclaration + "\nverifySecureMcpApp();", {
          mode: "strip",
        }),
        context,
      ) as Promise<ProductConfigurationResult>,
    providerStatus: (id?: string) => {
      if (id === undefined || id !== armedCheckId) {
        receiptAvailable = false;
        return { binding };
      }
      receiptAvailable = true;
      return { binding, checkId: id };
    },
  };
}

it.each(["exact", "wrong", "missing"] as const)(
  "existing-attachment Setup Verify accepts only the armed provider status ID: %s",
  async (correlation) => {
    const f = fixture("status");
    f.settings.connectors.secureMcp.challenge = null;
    expect(
      currentConnectorAttachment(f.settings, fixtureBuildId),
    ).not.toBeNull();
    // Actual Setup/Main + coordinator + public MCP tool. Go persistence and
    // arming are scripted ports; boot race tests qualify the Go slot contract.
    const server = createGoComputerMcpServer(
      new ComputerBridge({
        request: async () => {
          throw Error("unexpected workspace IO");
        },
      }),
      {
        ownerId: "owner",
        sessionId: "session",
        taskId: "task",
        taskEpoch: "1",
        participantId: "participant",
        turnId: "turn",
        generation: "1",
      },
      { profileId: "profile", backendGeneration: "backend" },
      {
        fence: {
          acquireAdmission: async () => ({
            admitted: true,
            release: async () => {},
          }),
        },
        connectionStatus: { observe: async (id) => f.providerStatus(id) },
      },
    );
    const client = new Client({
      name: "setup-status-regression",
      version: "1.0.0",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    let sends = 0;
    try {
      f.route.runReadonlyTask.mockImplementation(
        async (prompt, _attachments, observer) => {
          expect(prompt).toContain("computer_connection_status");
          const requestedId = prompt.match(/checkId "([^"]+)"/u)?.[1];
          expect(requestedId).toBe(checkId);
          await observer.onDispatchIntent!();
          expect(observer.beforeSend!()).toBe(true);
          sends++;
          await observer.onSendAcknowledged!();
          const suppliedId =
            correlation === "exact"
              ? requestedId
              : correlation === "wrong"
                ? originalId
                : undefined;
          await client.callTool({
            name: "computer_connection_status",
            arguments: suppliedId === undefined ? {} : { checkId: suppliedId },
          });
          expect(await observer.readConnectorReceipt!()).toBe(
            correlation === "exact",
          );
          return { state: "completed", code: null };
        },
      );
      const result = await f.runSetup();
      expect(result).toMatchObject(
        correlation === "exact"
          ? {
              ok: true,
              evidence: { kind: "connector.connection-check", retained: false },
            }
          : { ok: false, error: "CONNECTION_CHECK_OUTCOME_UNKNOWN" },
      );
      expect(sends).toBe(1);
      expect(f.publish).toHaveBeenCalledTimes(correlation === "exact" ? 1 : 0);
      expect(f.core.prepareConnectionCheck).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "status" }),
      );
      // Repeated observation of this original operation cannot Send again.
      expect(await f.run()).toMatchObject(
        correlation === "exact"
          ? { ok: true, evidence: { retained: true } }
          : { ok: false, error: "CONNECTION_CHECK_OUTCOME_UNKNOWN" },
      );
      expect(sends).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  },
);
it("Setup verification keeps its main browser route while a task is selected", async () => {
  const f = fixture("status");
  f.settings.connectors.secureMcp.challenge = null;
  f.context.selectedTaskId = "selected-task";
  // No task browser is available: Setup must retain its own route.
  expect(await f.runSetup()).toMatchObject({ ok: true });
  expect(f.sends()).toBe(1);
  expect(f.publish).toHaveBeenCalledTimes(1);
});
it("real Main dispatch selects the new explicit handler, not Deep Test or repair", () => {
  const node = tree.program.body.find(
    (x) =>
      x.type === "FunctionDeclaration" &&
      x.id?.name === "configureAdmittedProduct",
  );
  if (!node || node.start == null || node.end == null)
    throw Error("Missing active configuration dispatcher");
  expect(source.slice(node.start, node.end)).toContain(
    'if (command.kind === "connector.test-connection")\n    return testConnectionCommand(command);',
  );
  expect(declaration).not.toContain("verifySecureMcpApp(");
  expect(declaration).not.toContain('kind: "connector.repair"');
});
it("Main refuses before Send when connector start remains unresolved", async () => {
  const f = fixture("bootstrap");
  f.context.secureMcpConnectorRuntime = {
    isRunning: () => true,
    hasUnresolvedEffect: () => true,
  };
  expect(await f.run()).toMatchObject({
    ok: false,
    error: "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
  });
  expect(f.sends()).toBe(0);
  expect(f.publish).not.toHaveBeenCalled();
});
it.each([false, true])(
  "Main bootstraps without attachment, empty catalogue=%s, one Send and later Settings",
  async (empty) => {
    const f = fixture("bootstrap", empty);
    expect(f.settings.setup.journey.dismissed).toBe(true);
    expect(f.settings.connectors.secureMcp.attachment).toBeNull();
    expect(await f.run()).toMatchObject({
      ok: true,
      evidence: {
        kind: "connector.connection-check",
        operationId: originalId,
        retained: false,
      },
    });
    expect(f.sends()).toBe(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("claim")).toBeLessThan(
      f.events.indexOf("temporary-document"),
    );
    expect(f.events.indexOf("dispatch")).toBeLessThan(f.events.indexOf("send"));
    expect(f.events.indexOf("confirm")).toBeLessThan(
      f.events.indexOf("settings"),
    );
    const input = f.core.prepareConnectionCheck.mock.calls[0]![0];
    expect(input.challenge).toBe(
      f.settings.connectors.secureMcp.challenge!.value,
    );
    expect(input.workspaceId).toBe(empty ? undefined : fixtureWorkspaceId);
    expect(input.documentDigest).toBe(
      connectionCheckDigest("retained-physical-document"),
    );
  },
);
it("Main status uses the new Go-owned nonce and never a bootstrap fuse or old status helper", async () => {
  const f = fixture("status");
  expect(await f.run()).toMatchObject({ ok: true });
  expect(f.legacyExists).not.toHaveBeenCalled();
  expect(f.sends()).toBe(1);
  expect(f.core.prepareConnectionCheck.mock.calls[0]![0]).not.toHaveProperty(
    "challenge",
  );
});
it.each([
  "legacy-claim",
  "pending-original",
  "draft-unavailable",
  "changed-app-before-send",
])("Main %s preserves source custody and performs no Send", async (kind) => {
  const f = fixture();
  if (kind === "legacy-claim") f.legacyExists.mockResolvedValue(true);
  if (kind === "pending-original")
    f.settings.setup.connect.outcomeUnknown = true;
  if (kind === "draft-unavailable")
    f.route.openConnectionCheckChat.mockResolvedValue({
      status: "unreachable",
    });
  if (kind === "changed-app-before-send") {
    const original = f.core.advanceConnectionCheck.getMockImplementation()!;
    f.core.advanceConnectionCheck.mockImplementation(async (input) => {
      const result = await original(input);
      if (input.stage === "dispatch")
        f.settings.connectors.secureMcp.chatgptApp!.name = "Other";
      return result;
    });
  }
  expect(await f.run()).toMatchObject({
    ok: false,
    // An unconfirmed Setup step is persistent: name it, never "still finishing".
    ...(kind === "pending-original"
      ? { error: "CONNECTION_CHECK_SETUP_UNRESOLVED" }
      : kind === "legacy-claim"
        ? { error: "CONNECTION_CHECK_ALREADY_ATTEMPTED" }
        : {}),
  });
  expect(f.sends()).toBe(0);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.context.chatGptTaskAdmission).toBe(false);
  expect(f.context.connectorTaskAdmission).toBe(false);
});
it("lost Main reply observes original result without resolving a new page or publishing Settings again", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ ok: true });
  f.context.chatGptRoute = null;
  f.context.selectedTaskId = "different";
  expect(await f.run()).toMatchObject({
    ok: true,
    evidence: { retained: true, operationId: originalId },
  });
  expect(f.sends()).toBe(1);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.route.openConnectionCheckChat).toHaveBeenCalledTimes(1);
});
// Go's claim supersedes every unsettled earlier attempt, so Main must refuse a
// second check BEFORE it claims while the first is still live (for example
// after a renderer reload). Otherwise the newcomer settles the live check as
// unknown and is then refused itself.
it("a second check while one is live is refused before any Go claim", async () => {
  const f = fixture("status");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = f.route.runReadonlyTask.getMockImplementation()!;
  f.route.runReadonlyTask.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  const live = f.run();
  await vi.waitFor(() =>
    expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(1),
  );
  expect(await f.run()).toMatchObject({
    ok: false,
    error: "CHATGPT_TASK_IN_PROGRESS",
  });
  expect(f.core.claimConnectionCheck).toHaveBeenCalledTimes(1);
  release();
  expect(await live).toMatchObject({ ok: true });
  expect(f.sends()).toBe(1);
  expect(f.context.chatGptTaskAdmission).toBe(false);
  expect(f.context.connectorTaskAdmission).toBe(false);
});
it("two checks started together claim in Go only once", async () => {
  const f = fixture("status");
  const [first, second] = await Promise.all([f.run(), f.run()]);
  expect(first).toMatchObject({ ok: true });
  expect(second).toMatchObject({
    ok: false,
    error: "CHATGPT_TASK_IN_PROGRESS",
  });
  expect(f.core.claimConnectionCheck).toHaveBeenCalledTimes(1);
  expect(f.sends()).toBe(1);
});
it("a check refuses before claiming while another ChatGPT task holds admission", async () => {
  const f = fixture("status");
  f.context.chatGptTaskAdmission = true;
  expect(await f.run()).toMatchObject({
    ok: false,
    error: "CHATGPT_TASK_IN_PROGRESS",
  });
  expect(f.core.claimConnectionCheck).not.toHaveBeenCalled();
  // The other task still owns its admission; the refused check never released it.
  expect(f.context.chatGptTaskAdmission).toBe(true);
});
