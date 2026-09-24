// Local, no-account proof for the visible DEV "Test model" route.
//
// The installed supported Codex executable is launched as an owned App
// Server through the production launcher. Its HOME and CODEX_HOME are both
// disposable private directories, its only model provider is the product's
// loopback farol endpoint, and that endpoint is backed by a synthetic
// Route B conversation. No personal Codex state or live model is involved.
//
// Run with:
//   node tests/e2e/dev-route-b-host.e2e.mjs [--visible-output] [--report=<absolute path>]
// --visible-output proves status/commentary/final output against the real host,
// still with synthetic upstream content and no browser/model/account access.

// Exit codes: 0 PASS, 1 FAIL, 3 REAL_HOST_UNAVAILABLE.

// This is deliberately separate from farol-model-codex-exec.e2e.mjs. That
// older journey exercises the external `codex exec` config-block contract;
// DEV's visible check uses an app-owned App Server child instead.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_REAL_HOST_UNAVAILABLE = 3;
const CLIENT_VERSION = "0.1.0-preview.0";
const visibleOutput = process.argv.includes("--visible-output");
const FIXTURE_COMMENTARY = "Fixture commentary.";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const reportArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--report="));
const reportPath = reportArgument
  ? path.resolve(reportArgument.slice("--report=".length))
  : path.join(
      repositoryRoot,
      "_output",
      "evidence",
      visibleOutput ? "dev-route-b-visible-host.json" : "dev-route-b-host.json",
    );

const report = {
  schemaVersion: 1,
  status: "FAIL",
  classification: "real-host-synthetic-upstream",
  outputMode: visibleOutput ? "semantic" : "text",
  startedAtIso: new Date().toISOString(),
  finishedAtIso: null,
  host: null,
  isolation: {
    privateHome: true,
    privateCodexHome: true,
    personalCodexStateUsed: false,
    liveModelUsed: false,
  },
  result: null,
  diagnostics: {
    checked: null,
    promptCount: 0,
    routeFailure: null,
    hostTrace: [],
    provider: null,
    prepareTurn: null,
  },
  error: null,
};

let workRoot;
let bundleRoot;
let routeRuntime;
let callerRelay;
let callerRelayRoot;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identifierDigest(value) {
  return typeof value === "string" && value.length > 0 ? sha256(value) : null;
}

function responseTrace(method, value) {
  if (!value || typeof value !== "object") return { method, shape: "invalid" };
  if (method === "thread/start") {
    return {
      method,
      model: value.model ?? null,
      provider: value.thread?.modelProvider ?? null,
      threadIdSha256: identifierDigest(value.thread?.id),
    };
  }
  if (method === "turn/start") {
    return {
      method,
      status: value.turn?.status ?? null,
      turnIdSha256: identifierDigest(value.turn?.id),
    };
  }
  if (method === "thread/read") {
    return {
      method,
      model: value.thread?.model ?? null,
      provider: value.thread?.modelProvider ?? null,
      turns: Array.isArray(value.thread?.turns)
        ? value.thread.turns.map((turn) => ({
            turnIdSha256: identifierDigest(turn?.id),
            status: turn?.status ?? null,
            itemTypes: Array.isArray(turn?.items)
              ? turn.items.map((item) => item?.type ?? null)
              : [],
          }))
        : [],
    };
  }
  return { method, shape: "object" };
}

function notificationTrace(method, value) {
  if (!value || typeof value !== "object") return { method, shape: "invalid" };
  if (method === "item/agentMessage/delta") {
    return {
      method,
      turnIdSha256: identifierDigest(value.turnId),
      itemIdSha256: identifierDigest(value.itemId),
      deltaCharacters:
        typeof value.delta === "string" ? value.delta.length : null,
    };
  }
  if (method === "turn/completed") {
    return {
      method,
      turnIdSha256: identifierDigest(value.turn?.id),
      status: value.turn?.status ?? null,
      errorCode:
        typeof value.turn?.error?.code === "string"
          ? value.turn.error.code
          : null,
      errorMessage:
        typeof value.turn?.error?.message === "string"
          ? value.turn.error.message.slice(0, 240)
          : null,
    };
  }
  return { method, shape: "object" };
}

async function writeReport() {
  report.finishedAtIso = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`REPORT: ${reportPath}`);
  console.log(`STATUS: ${report.status}`);
}

async function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

function summaryRoute(surface) {
  return {
    ...surface,
    currentConversationUrl: () => "https://chatgpt.com/c/synthetic-route-b",
    retainedConversationUrl: () => "https://chatgpt.com/c/synthetic-route-b",
    resetConversation: () => undefined,
    dispose: () => undefined,
  };
}

async function main() {
  bundleRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-dev-route-b-bundle-"),
  );
  workRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-route-b-host-")),
  );
  await fs.chmod(workRoot, 0o700);

  const bundlePath = path.join(bundleRoot, "bundle.mjs");
  await esbuild.build({
    entryPoints: [path.join(here, "dev-route-b-host.e2e.entry.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const production = await import(bundlePath);

  const discovered = await production.discoverExecutables("codex");
  const offered = discovered.candidates.filter(
    (candidate) => candidate.verdict === "offer",
  );
  const selected =
    offered.find((candidate) => candidate.source === "chatgpt-app") ??
    offered[0];
  if (!selected) {
    report.status = "REAL_HOST_UNAVAILABLE";
    report.error = "CODEX_HOST_NOT_DISCOVERED";
    process.exitCode = EXIT_REAL_HOST_UNAVAILABLE;
    return;
  }

  const probe = await production.probeCodexHost({
    executablePath: selected.path,
    scratchRoot: await privateDirectory(workRoot, "probe"),
  });
  assert.equal(probe.executablePath, selected.path);
  report.host = {
    executablePath: selected.path,
    discoverySource: selected.source,
    discoveryOrigin: selected.origin,
    version: probe.version,
    protocol: probe.protocol,
    executableSha256: probe.executableSha256,
    schemaSha256: probe.schemaSha256,
  };

  const prompts = [];
  const surface = {
    runReadonlyTask: async (prompt, _attachments = [], observer = {}) => {
      prompts.push(prompt);
      if (visibleOutput) {
        assert.equal(typeof observer.onVisibleItem, "function");
        await observer.onVisibleItem({
          sequence: 1,
          id: "status",
          channel: "status",
          text: "Inspecting synthetic files",
        });
        await observer.onVisibleItem({
          sequence: 2,
          id: "commentary",
          channel: "commentary",
          text: FIXTURE_COMMENTARY,
        });
        await observer.onVisibleItem({
          sequence: 3,
          id: "answer",
          channel: "answer",
          text: "READY",
        });
      } else {
        await observer.onTextDelta?.({
          sequence: 1,
          delta: "RE",
          text: "RE",
          observedCharacters: 2,
        });
        await observer.onTextDelta?.({
          sequence: 2,
          delta: "ADY",
          text: "READY",
          observedCharacters: 5,
        });
      }
      return {
        state: "completed",
        code: null,
        deltaCount: visibleOutput ? 3 : 2,
        observedCharacters: 5,
        outputText: "READY",
      };
    },
  };
  const retained = summaryRoute(surface);
  const stateRoot = await privateDirectory(workRoot, "route-b-state");
  const controller = production.createCodexContextController({
    ownerId: "owner-dev-e2e",
    providerProfileId: "profile-dev-e2e",
    stateRoot: path.join(stateRoot, "context-continuity"),
    summaryRoutes: {
      retained: () => retained,
      createFallback: () => retained,
    },
  });
  let prepareTurnTrace = null;
  // The installed host always advertises its inert `skills` helper even with
  // an empty private skill inventory. Production Route B has an owned caller
  // relay, so compose the E2E the same way; the assertions below prove the
  // check never invokes that helper. A short /tmp anchor is required by the
  // Unix-domain socket's platform path limit and is removed in `finally`.
  callerRelayRoot = await fs.realpath(await fs.mkdtemp("/tmp/fr-dev-host-"));
  await fs.chmod(callerRelayRoot, 0o700);
  callerRelay = await production.startCodexCallerRelay({
    root: callerRelayRoot,
  });
  routeRuntime = await production.startRouteBRuntime({
    stateRoot,
    surfaces: {
      surfaceFor: async () => ({ ok: true, surface }),
    },
    compaction: {
      compact: (input) => controller.continuity.compact(input),
      prepareTurn: async (input) => {
        const prepared = await controller.continuity.prepareTurn(input);
        prepareTurnTrace = prepared.ok
          ? {
              ok: true,
              trustedContextPresent: prepared.value.trustedContext !== null,
            }
          : { ok: false, code: prepared.error.code };
        return prepared;
      },
    },
    relay: callerRelay,
  });

  const runtimeRoot = await privateDirectory(workRoot, "host-runtime");
  const processHome = await privateDirectory(workRoot, "process-home");
  const tempPath = await privateDirectory(workRoot, "tmp");
  let routed = null;
  let routeFailure = null;
  const hostTrace = [];
  const hostItems = [];
  const checked = await production.runRouteBHostCheck(
    {
      executablePath: selected.path,
      runtimeRoot,
      homePath: processHome,
      tempPath,
      clientVersion: CLIENT_VERSION,
      endpoint: routeRuntime.endpoint,
      timeoutMs: 60_000,
    },
    {
      launch: production.launchCodexAppServer,
      route: async (client, input) => {
        const removeItems = client.handleNotification(
          "item/completed",
          (value) => {
            if (!value || typeof value !== "object" || !value.item) return;
            hostItems.push({
              threadIdSha256: identifierDigest(value.threadId),
              turnIdSha256: identifierDigest(value.turnId),
              type: value.item.type ?? null,
              phase: value.item.phase ?? null,
              textCharacters:
                typeof value.item.text === "string"
                  ? value.item.text.length
                  : null,
            });
          },
        );
        const peer = {
          request: async (method, params) => {
            const response = await client.request(method, params);
            hostTrace.push(responseTrace(method, response));
            return response;
          },
          handleNotification: (method, handler) =>
            client.handleNotification(method, (params) => {
              hostTrace.push(notificationTrace(method, params));
              handler(params);
            }),
        };
        try {
          routed = await production.runCodexChatGptHostRoute(peer, input);
          return routed;
        } catch (error) {
          routeFailure = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          removeItems();
        }
      },
    },
  );

  report.diagnostics = {
    checked,
    promptCount: prompts.length,
    routeFailure,
    hostTrace,
    hostItems,
    provider: routeRuntime.provider.diagnostics(),
    prepareTurn: prepareTurnTrace,
  };
  console.log(`HOST TRACE: ${JSON.stringify(report.diagnostics)}`);

  assert.deepEqual(checked, {
    status: "completed",
    deltaCount: routed?.deltaCount,
    observedCharacters: routed?.observedCharacters,
  });
  assert.ok(routed, "the real host route must complete");
  assert.equal(routed.requestedProvider, "farol");
  assert.equal(routed.observedProvider, "farol");
  assert.equal(routed.requestedModel, production.ROUTE_B_MODEL);
  assert.equal(routed.observedModel, production.ROUTE_B_MODEL);
  assert.equal(routed.retainedResult, true);
  assert.ok(
    routed.deltaCount >= 1,
    "the host must deliver an incremental delta",
  );
  assert.equal(
    routed.observedCharacters,
    5 + (visibleOutput ? FIXTURE_COMMENTARY.length : 0),
  );
  if (visibleOutput) {
    const currentItems = hostItems.filter(
      (item) =>
        item.threadIdSha256 === identifierDigest(routed.threadId) &&
        item.turnIdSha256 === identifierDigest(routed.turnId),
    );
    assert.ok(
      currentItems.some((item) => item.type === "reasoning"),
      "visible status must reach the native host",
    );
    assert.deepEqual(
      currentItems
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.phase),
      ["commentary", "final_answer"],
    );
  }
  assert.equal(prompts.length, 1);
  assert.ok(
    prompts[0].includes(production.ROUTE_B_CHECK_PROMPT),
    "the routed prompt must contain the fixed check prompt",
  );
  assert.equal(
    routeRuntime.provider.diagnostics().toolCalls,
    0,
    "the check must not invoke an advertised host tool",
  );

  const codexHome = path.join(runtimeRoot, "route-b-codex-home");
  const codexHomeMode = (await fs.stat(codexHome)).mode & 0o777;
  assert.equal(codexHomeMode, 0o700);
  assert.ok(codexHome.startsWith(`${workRoot}${path.sep}`));
  assert.ok(processHome.startsWith(`${workRoot}${path.sep}`));

  report.result = {
    provider: routed.observedProvider,
    model: routed.observedModel,
    retainedSameTurn: routed.retainedResult,
    deltaCount: routed.deltaCount,
    observedCharacters: routed.observedCharacters,
    promptSha256: sha256(production.ROUTE_B_CHECK_PROMPT),
    promptCount: prompts.length,
    codexHomeMode: codexHomeMode.toString(8),
  };
  report.status = "PASS";
  process.exitCode = EXIT_PASS;
}

try {
  await main();
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = EXIT_FAIL;
  console.error(error);
} finally {
  await routeRuntime?.close().catch(() => undefined);
  await callerRelay?.close().catch(() => undefined);
  if (callerRelayRoot) {
    await fs
      .rm(callerRelayRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
  if (workRoot) {
    await fs
      .rm(workRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
  if (bundleRoot) {
    await fs
      .rm(bundleRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
  await writeReport();
}
