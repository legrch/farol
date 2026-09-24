// Real App Server + deterministic local synthetic answers, no account/model.
// Default: inventory only, no tool or child. Explicit --lineage: one new
// synthetic child and one wait using the observed exact schemas. Skills are
// recorded as advertised, never invoked; this is not Product Agent acceptance.
// Run from vnext: node tests/e2e/codex-agent-inventory.e2e.mjs [--lineage]
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const model = "chatgpt";
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--lineage"),
  "unsupported probe arguments",
);
const lineage = args[0] === "--lineage";
const report = {
  classification: lineage
    ? "real-host-synthetic-provider-native-lineage"
    : "real-host-synthetic-upstream-inventory-only",
  productAgentQualified: false,
  status: "FAIL",
  startedAt: new Date().toISOString(),
  host: null,
  sourceInputs: [],
  inventories: [],
  responses: 0,
  modelCatalogueRequests: 0,
  dynamicInvocations: 0,
  retainedItemTypes: [],
  cleanup: {
    clientClosed: false,
    serverClosed: false,
    temporaryRemoved: false,
  },
  liveModelUsed: false,
  syntheticActionsAuthorized: lineage
    ? ["multi_agent_v1.spawn_agent", "multi_agent_v1.wait_agent"]
    : [],
  observedActions: [],
  nativeItemShapes: [],
  toolOutputSignals: [],
  catalogueOnly: [],
  child: null,
  error: null,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failCode = (cause) =>
  cause instanceof Error && /^[A-Z][A-Z0-9_]{1,120}$/u.test(cause.message)
    ? cause.message
    : "INVENTORY_PROBE_FAILED";
const requireThat = (condition, code) => {
  if (!condition) throw new Error(code);
};
const temp = await fs.mkdtemp(
  path.join(
    os.tmpdir(),
    lineage ? "farol-agent-lineage-" : "farol-agent-inventory-",
  ),
);
await fs.chmod(temp, 0o700);
let client;
let server;
let threadId;
let turnId;
let terminal;
let removeTerminal;
let removeTool;
let timer;
let terminalObserved = false;
let childId = null;
let observedChildId = null;
let parentStep = 0;
let childRequests = 0;
let removeItem;
const turns = new Map();
const childPrompt =
  "Return only FAROL_INVENTORY_CHILD. Do not invoke any tool, skill or descendant.";
const bundle = path.join(temp, "production.mjs");
const reportDirectory = path.resolve(root, "../_output/evidence");
const reportPath = path.join(reportDirectory, `${path.basename(temp)}.json`);

try {
  report.harnessSha256 = hash(
    await fs.readFile(fileURLToPath(import.meta.url)),
  );
  const compiled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(here, "codex-agent-inventory.e2e.entry.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
    logLevel: "silent",
  });
  for (const file of Object.keys(compiled.metafile.inputs).sort()) {
    report.sourceInputs.push({
      path: file,
      sha256: hash(await fs.readFile(path.resolve(root, file))),
    });
  }
  report.bundleSha256 = hash(await fs.readFile(bundle));
  const production = await import(bundle);
  const discovered = await production.discoverExecutables("codex");
  const offered = discovered.candidates.filter(
    (item) => item.verdict === "offer",
  );
  const selected =
    offered.find((item) => item.source === "chatgpt-app") ?? offered[0];
  requireThat(selected, "CODEX_HOST_NOT_DISCOVERED");
  const dirs = Object.fromEntries(
    ["home", "codex-home", "workspace", "probe"].map((name) => [
      name,
      path.join(temp, name),
    ]),
  );
  for (const directory of Object.values(dirs))
    await fs.mkdir(directory, { mode: 0o700 });
  const probe = await production.probeCodexHost({
    executablePath: selected.path,
    scratchRoot: dirs.probe,
  });
  report.host = {
    version: probe.version,
    protocol: probe.protocol,
    executableSha256: probe.executableSha256,
    schemaSha256: probe.schemaSha256,
  };
  const token = randomBytes(32).toString("hex");
  server = createServer((request, response) => {
    void (async () => {
      requireThat(report.error === null, "PROBE_PROVIDER_STOPPED");
      requireThat(
        request.headers.authorization === `Bearer ${token}`,
        "PROBE_AUTH_REFUSED",
      );
      if (request.method === "GET" && request.url === "/v1/models") {
        requireThat(
          ++report.modelCatalogueRequests <= 8,
          "PROBE_CATALOGUE_BUDGET_EXCEEDED",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [production.modelCatalogue(model)],
          }),
        );
        return;
      }
      requireThat(
        request.method === "POST" && request.url === "/v1/responses",
        "PROBE_ROUTE_REFUSED",
      );
      requireThat(
        ++report.responses <= (lineage ? 4 : 1),
        "PROBE_REQUEST_BUDGET_EXCEEDED",
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        requireThat(size <= 1024 * 1024, "PROBE_INPUT_LIMIT");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requireThat(
        body.model === model && body.stream === true,
        "PROBE_MODEL_MISMATCH",
      );
      requireThat(body.reasoning?.effort === "low", "PROBE_EFFORT_MISMATCH");
      requireThat(Array.isArray(body.input), "PROBE_INPUT_INVALID");
      for (const output of body.input) {
        if (output?.type !== "function_call_output") continue;
        const encoded = JSON.stringify(output.output) ?? "";
        let parsedOutput = null;
        try {
          parsedOutput =
            typeof output.output === "string"
              ? JSON.parse(output.output)
              : output.output;
        } catch {
          /* Metadata only. */
        }
        const outputKeys =
          parsedOutput &&
          typeof parsedOutput === "object" &&
          !Array.isArray(parsedOutput)
            ? Object.keys(parsedOutput).sort()
            : [];
        if (
          lineage &&
          output.call_id === "inventory_call_0" &&
          typeof parsedOutput?.agent_id === "string"
        ) {
          requireThat(
            /^[A-Za-z0-9_-]{1,160}$/u.test(parsedOutput.agent_id),
            "PROBE_SPAWN_ID_INVALID",
          );
          requireThat(
            childId === null || childId === parsedOutput.agent_id,
            "PROBE_SPAWN_RESULT_ID_CHANGED",
          );
          childId = parsedOutput.agent_id;
        }
        report.toolOutputSignals.push({
          objectKeys: outputKeys,
          spawnIdReturned: typeof parsedOutput?.agent_id === "string",
          // This input is the isolated host's response to our fixed synthetic
          // call, never a live user transcript. Redact paths/opaque identifiers.
          diagnostic:
            output.call_id === "inventory_call_0" &&
            parsedOutput === null &&
            typeof output.output === "string"
              ? output.output
                  .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
                  .replace(/[A-Za-z0-9_-]{24,}/gu, "[opaque]")
                  .replace(/\/(?:Users|private)\/[^\s"']+/gu, "[private-path]")
                  .slice(0, 512)
              : null,
          forSpawn: output.call_id === "inventory_call_0",
          forWait: output.call_id === "inventory_call_1",
          outputType: typeof output.output,
          length: encoded.length,
          encrypted: /encrypt/iu.test(encoded),
          unknownTool:
            /unknown (?:tool|function)|unrecognized (?:tool|function)/iu.test(
              encoded,
            ),
          unsupported: /not supported|unsupported/iu.test(encoded),
          unavailable: /not available|unavailable/iu.test(encoded),
          denied: /denied|not permitted|not allowed/iu.test(encoded),
          failed: /error|failed/iu.test(encoded),
        });
      }
      const registry = production.CodexNativeToolRegistry.parse(body.tools);
      const catalogue = registry.describe();
      report.inventories.push({
        fingerprint: catalogue.fingerprint,
        unsupported: catalogue.unsupported,
        // Public interface schemas only; never save prompt, tool arguments,
        // request headers, user input, raw host IDs or private configuration.
        tools: catalogue.tools.map(({ name, namespace, parameters }) => ({
          name,
          namespace,
          parameters,
        })),
      });
      const textItem = (text) => ({
        id: `msg_inventory_${report.responses}`,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      let item = textItem("INVENTORY_RECORDED");
      if (lineage) {
        const currentId = body.client_metadata?.thread_id;
        requireThat(
          typeof currentId === "string" && currentId.length > 0,
          "PROBE_REQUEST_ID_MISSING",
        );
        const currentTurn = body.client_metadata?.turn_id;
        if (typeof currentTurn === "string") turns.set(currentId, currentTurn);
        if (currentId === threadId) {
          const plan = new production.CodexAgentProbePolicy(body.tools);
          report.catalogueOnly = [...plan.catalogueOnly];
          const step = parentStep++;
          if (step === 0 || step === 1) {
            if (step === 1)
              requireThat(childId !== null, "PROBE_CHILD_NOT_OBSERVED");
            const call =
              step === 0 ? plan.spawn(childPrompt) : plan.wait(childId);
            item = {
              id: `fc_inventory_${step}`,
              call_id: `inventory_call_${step}`,
              type: "function_call",
              status: "completed",
              name: call.name,
              namespace: call.namespace,
              arguments: call.encodedArguments,
            };
          } else {
            requireThat(step === 2, "PROBE_PARENT_STEP_LIMIT");
            const output = body.input.findLast(
              (value) =>
                value?.type === "function_call_output" &&
                value.call_id === "inventory_call_1",
            );
            requireThat(
              output &&
                JSON.stringify(output.output).includes("FAROL_INVENTORY_CHILD"),
              "PROBE_WAIT_RESULT_MISSING",
            );
          }
        } else {
          requireThat(++childRequests === 1, "PROBE_MULTIPLE_CHILD_REQUESTS");
          observedChildId = currentId;
          requireThat(
            childId === null || childId === currentId,
            "PROBE_CHILD_REQUEST_MISMATCH",
          );
          item = textItem("FAROL_INVENTORY_CHILD");
        }
      }
      const envelope = {
        id: `resp_inventory_${report.responses}`,
        model,
        status: "in_progress",
        output: [],
      };
      let events = [
        { type: "response.created", response: envelope },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          delta: item.content?.[0]?.text,
        },
        {
          type: "response.output_text.done",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          text: item.content?.[0]?.text,
        },
        {
          type: "response.content_part.done",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          part: item.content?.[0],
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { ...envelope, status: "completed", output: [item] },
        },
      ];
      if (item.type === "function_call") {
        events = [
          { type: "response.created", response: envelope },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: item.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: item.id,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: { ...envelope, status: "completed", output: [item] },
          },
        ];
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.end(
        events
          .map(
            (event, index) =>
              `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
          )
          .join(""),
      );
    })().catch((cause) => {
      report.error ??= failCode(cause);
      if (!response.headersSent)
        response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: report.error } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  requireThat(address && typeof address !== "string", "PROBE_BIND_FAILED");
  client = await production.launchCodexAppServer({
    executablePath: selected.path,
    cwd: dirs.workspace,
    homePath: dirs.home,
    codexHomePath: dirs["codex-home"],
    tempPath: temp,
    clientVersion: "0.1.0-preview.0",
    providerRoute: { baseUrl: `http://127.0.0.1:${address.port}/v1`, token },
    toolProfile: "native-agent",
  });
  removeTool = client.handleServerRequest("item/tool/call", async () => {
    report.dynamicInvocations++;
    throw new Error("PROBE_TOOL_INVOCATION_REFUSED");
  });
  const thread = await client.request("thread/start", {
    model,
    modelProvider: "farol",
    allowProviderModelFallback: false,
    cwd: dirs.workspace,
    sandbox: "read-only",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    ephemeral: false,
    historyMode: "paginated",
    runtimeWorkspaceRoots: [],
    selectedCapabilityRoots: [],
    environments: [],
    dynamicTools: [],
    baseInstructions: lineage
      ? "This is a deterministic synthetic lineage test. Spawn exactly one child on the selected route, wait for it, then return INVENTORY_RECORDED. Never invoke skills, files, web, commands or any other tool; the child must not spawn descendants."
      : "This is an inventory-only synthetic test. No tools, files, skills, child agents or external operations may be invoked. Return only INVENTORY_RECORDED.",
  });
  requireThat(
    thread.model === model && thread.thread?.modelProvider === "farol",
    "PROBE_THREAD_ROUTE_MISMATCH",
  );
  threadId = thread.thread.id;
  removeItem = client.handleNotification("item/completed", (event) => {
    const item = event.item;
    report.nativeItemShapes.push({
      type: item?.type ?? null,
      tool: item?.tool ?? null,
      status: item?.status ?? null,
      keys: item ? Object.keys(item).sort() : [],
    });
    if (item?.type !== "collabAgentToolCall") return;
    const valid =
      lineage &&
      event.threadId === threadId &&
      item.senderThreadId === threadId &&
      item.status === "completed" &&
      item.receiverThreadIds?.length === 1;
    if (!valid || !["spawnAgent", "wait"].includes(item.tool)) {
      report.error ??= "PROBE_UNEXPECTED_COLLAB_ACTION";
      return;
    }
    const id = item.receiverThreadIds[0];
    if (item.tool === "spawnAgent") {
      if (
        (childId !== null && childId !== id) ||
        report.observedActions.includes("spawnAgent") ||
        (observedChildId !== null && observedChildId !== id)
      )
        report.error ??= "PROBE_DUPLICATE_CHILD";
      childId = id;
    } else if (id !== childId) report.error ??= "PROBE_WAIT_CHILD_MISMATCH";
    report.observedActions.push(item.tool);
  });
  terminal = new Promise((resolve, reject) => {
    removeTerminal = client.handleNotification("turn/completed", (event) => {
      if (event.threadId === threadId) {
        terminalObserved = true;
        resolve(event);
      }
    });
    timer = setTimeout(
      () => reject(new Error("PROBE_TERMINAL_TIMEOUT")),
      30000,
    );
  });
  // Install a rejection observer before the request so a start failure cannot
  // leave a rejected terminal promise unobserved.
  void terminal.catch(() => undefined);
  const started = await client.request("turn/start", {
    threadId,
    effort: "low",
    input: [
      {
        type: "text",
        text: lineage
          ? "Complete the bounded synthetic lineage test."
          : "Return only INVENTORY_RECORDED. Do not invoke tools.",
      },
    ],
  });
  turnId = started.turn?.id;
  turns.set(threadId, turnId);
  const ended = await terminal;
  clearTimeout(timer);
  requireThat(
    ended.turn?.id === turnId && ended.turn.status === "completed",
    "PROBE_TURN_NOT_COMPLETED",
  );
  const retained = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const retainedTurn = retained.thread?.turns?.find(
    (turn) => turn.id === turnId,
  );
  requireThat(
    retainedTurn?.status === "completed",
    "PROBE_RETAINED_TURN_MISSING",
  );
  report.retainedItemTypes = retainedTurn.items.map((item) => item.type);
  requireThat(
    report.retainedItemTypes.every((type) =>
      [
        "userMessage",
        "agentMessage",
        ...(lineage ? ["collabAgentToolCall"] : []),
      ].includes(type),
    ),
    "PROBE_UNEXPECTED_ACTION",
  );
  if (lineage) {
    assert.deepEqual(report.observedActions, ["spawnAgent", "wait"]);
    requireThat(
      childId !== null && childId === observedChildId,
      "PROBE_CHILD_IDENTITY_MISSING",
    );
    const child = (
      await client.request("thread/read", {
        threadId: childId,
        includeTurns: true,
      })
    ).thread;
    const parentBinding =
      child.parentThreadId ??
      child.source?.subAgent?.thread_spawn?.parent_thread_id;
    requireThat(
      parentBinding === threadId &&
        child.model === model &&
        child.modelProvider === "farol",
      "PROBE_RETAINED_CHILD_ROUTE_MISMATCH",
    );
    requireThat(
      child.turns.length === 1 && child.turns[0].status === "completed",
      "PROBE_CHILD_NOT_COMPLETED",
    );
    requireThat(
      child.turns[0].items.every((value) =>
        ["userMessage", "agentMessage"].includes(value.type),
      ),
      "PROBE_CHILD_TOOL_EXECUTED",
    );
    report.child = {
      sameParent: true,
      configuredModel: child.model,
      configuredProvider: child.modelProvider,
      turns: 1,
      status: "completed",
      toolActions: 0,
      configuredRouteIsNotLiveModelTelemetry: true,
    };
  }
  assert.equal(report.dynamicInvocations, 0);
  assert.equal(report.responses, lineage ? 4 : 1);
  requireThat(report.error === null, "PROBE_PROVIDER_FAILED");
  report.status = "PASS";
} catch (cause) {
  report.error ??= failCode(cause);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  removeTerminal?.();
  removeTool?.();
  removeItem?.();
  if (client) {
    if (threadId && report.status !== "PASS") {
      const retained = await client
        .request("thread/read", { threadId, includeTurns: true })
        .catch(() => null);
      report.failedParent = retained?.thread
        ? {
            status: retained.thread.status,
            turns: (retained.thread.turns ?? []).map((turn) => ({
              status: turn.status,
              items: turn.items.map((item) => ({
                type: item.type,
                tool: item.tool ?? null,
                status: item.status ?? null,
                keys: Object.keys(item).sort(),
              })),
            })),
          }
        : null;
    }
    if (!terminalObserved || report.status !== "PASS") {
      for (const [ownedThread, ownedTurn] of turns) {
        if (ownedThread && ownedTurn)
          await client
            .request("turn/interrupt", {
              threadId: ownedThread,
              turnId: ownedTurn,
            })
            .catch(() => undefined);
      }
    }
    await client
      .close()
      .then(() => {
        report.cleanup.clientClosed = true;
      })
      .catch((cause) => {
        report.error ??= failCode(cause);
      });
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    report.cleanup.serverClosed = true;
  }
  // Preserve the private runtime if its owned host could not be closed.
  if (!client || report.cleanup.clientClosed) {
    await fs.rm(temp, { recursive: true, force: true });
    report.cleanup.temporaryRemoved = true;
  }
  if (report.error || !Object.values(report.cleanup).every(Boolean)) {
    report.status = "FAIL";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      error: report.error,
      responses: report.responses,
      nativeActions: report.observedActions,
      dynamicInvocations: report.dynamicInvocations,
      cleanup: report.cleanup,
      receipt: reportPath,
    }),
  );
}
