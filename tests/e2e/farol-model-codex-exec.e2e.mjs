// Packet N04 (Decisions.md, run farol-local-completion-0919): end-to-end
// proof that an ordinary, supported Codex can reach a Farol Model endpoint
// through the managed-config-block lifecycle, using a disposable CODEX_HOME
// and the real `codex` binary when one is installed on this machine.
//
// This never touches the owner's ~/.codex, never restarts the owner's
// Codex, and never contacts a live account: the upstream is this process's
// own synthetic SSE responder, reachable only on 127.0.0.1.
//
// Run with: node tests/e2e/farol-model-codex-exec.e2e.mjs [--report=<file>]
//
// Phases (each recorded in the machine-readable report):
//   env-key-overrides     env_key delivery, provider picked per call with
//                         `-c model_provider=… -c model=…`
//   env-key-selection     same delivery, provider picked by the consented
//                         selection region alone, no `-c` at all
//   bearer-token-config   the production delivery: the token literal in a
//                         0600 config.toml, NO token in the environment, no
//                         `-c`; the endpoint must see `Authorization: Bearer
//                         <token>` and serve exactly one request
//   no-retry-on-failure   the upstream fails once; with the block's
//                         request_max_retries = 0 the host must send exactly
//                         one request and fail, never a second submission
//
// S35-TA-3: the four phases above prove the host protocol against pieces
// this script assembles itself — an endpoint it constructs, a spec it
// writes out by hand. That is the protocol claim, not the product claim.
// The phases below drive the SAME journey through the modules the desktop
// itself calls, so what is proven is the route an owner actually takes:
//   app-host-discovery        production executable discovery, then the
//                             read-only presence check that decides the
//                             restart note. Nothing is signalled or killed.
//   app-preview-decline-apply FarolModelLifecycle owns the endpoint; the
//                             spec is built the way main.ts builds it;
//                             preview, a DECLINE that changes nothing, then
//                             apply and the consented selection; then a real
//                             host call with no -c and no token in the
//                             environment.
//   app-rotation-then-host    lifecycle.rotateAndRewrite, then the real host
//                             again: the block and the endpoint agree on the
//                             NEW literal and the old one is refused.
//   app-revocation-no-retry   the token is revoked under a host that still
//                             carries the old literal: exactly one refused
//                             request, no second submission.
//   app-restart-reconnect     a new lifecycle on the same private state
//                             reuses the persisted port, and the config the
//                             owner already has keeps working.
//   app-conflict-and-rollback a foreign entry of the same name is never
//                             overwritten; rollback removes exactly the
//                             managed regions and the host can no longer
//                             reach Farol.
//
// Exit codes: 0 PASS · 1 FAIL · 3 REAL_HOST_UNAVAILABLE (no `codex` on
// PATH: the config+endpoint plumbing is not the real-host claim, so this is
// deliberately not a pass).
//
// The TypeScript modules under test import each other by extensionless
// specifier (this repo's normal style, resolved by `tsc`'s Bundler
// moduleResolution and by Vitest's esbuild transform). Node's own ESM
// loader requires exact, extensioned specifiers even under
// --experimental-transform-types, so this script bundles the same files
// with esbuild — the toolchain already depends on for `tooling/build.mjs`
// — into one temporary ESM module and imports that instead of
// reimplementing or duplicating their logic.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import esbuild from "esbuild";
import {
  assertReportIdentity,
  bundleDigest,
  identityFromRunRecords,
  SUPPORTED_NODE_VERSIONS,
} from "./farol-model-report-identity.mjs";

const execFileAsync = promisify(execFile);

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_REAL_HOST_UNAVAILABLE = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
const reportArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--report="));
const reportPath = path.resolve(
  reportArgument
    ? reportArgument.slice("--report=".length)
    : path.join(
        here,
        "..",
        "..",
        "artifacts",
        "farol-model-codex-exec",
        "report.json",
      ),
);

const bundleEntry = path.join(here, "farol-model-codex-exec.e2e.entry.ts");
const bundleOutput = path.join(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-e2e-bundle-")),
  "bundle.mjs",
);
await esbuild.build({
  entryPoints: [bundleEntry],
  outfile: bundleOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const {
  FarolModelRuntimeState,
  FarolModelEndpoint,
  FAROL_MODEL_HOST_TUNING,
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
  previewFarolModelConfigBlock,
  previewFarolModelProviderSelection,
  rollbackFarolModelConfigBlock,
  rollbackFarolModelProviderSelection,
  ROUTE_B_MODEL,
  FarolModelLifecycle,
  discoverExecutables,
  detectCodexHostPresence,
  psProcessLister,
} = await import(bundleOutput);

const REPLY_TEXT = "farol model e2e reply";
const CODEX_EXEC_TIMEOUT_MS = 45_000;

const report = {
  status: "FAIL",
  startedAtIso: new Date().toISOString(),
  finishedAtIso: null,
  hostBinary: null,
  discoveredHostBinary: null,
  hostVersion: null,
  // S35-TA-5: filled once the host is known; a report without it is refused
  // rather than written (see `writeReport`).
  identity: null,
  model: ROUTE_B_MODEL,
  hostTuning: FAROL_MODEL_HOST_TUNING,
  phases: [],
  error: null,
};

/**
 * Everything this script started that holds a socket. A phase that throws used
 * to leave its endpoint listening, and since an open server keeps Node's event
 * loop alive, a FAILED run never exited: four runs from one afternoon were
 * still holding ports twenty minutes later. Registered on creation, stopped in
 * `main`'s `finally` whatever happened.
 */
const started = [];

function track(stoppable) {
  started.push(stoppable);
  return stoppable;
}

async function stopEverything() {
  for (const stoppable of started.splice(0).reverse()) {
    await stoppable.stop().catch(() => undefined);
  }
}

/** What the synthetic upstream observed and how it should behave next. */
const upstream = {
  calls: 0,
  failNext: false,
  authorizations: [],
  models: [],
  /** The tool inventory the host advertised on each request. */
  toolNames: [],
  /** The full tool inventory of the most recent request. */
  lastTools: [],
  /** Set by the tool-roundtrip phase; see `app-tool-roundtrip`. */
  toolCall: null,
};

const turnHandler = async (request) => {
  upstream.calls += 1;
  upstream.authorizations.push(request.headers.authorization ?? null);
  upstream.models.push(request.body?.model ?? null);
  upstream.toolNames.push(
    (request.body?.tools ?? []).map((tool) => tool?.name ?? tool?.type ?? null),
  );
  upstream.lastTools = request.body?.tools ?? [];
  if (upstream.failNext) {
    upstream.failNext = false;
    return { ok: false, reason: "FAROL_MODEL_E2E_SYNTHETIC_FAILURE" };
  }
  // S35-TA-3: the correlated tool roundtrip. The first turn answers with a
  // function call instead of text; the host runs it and opens a SECOND
  // turn whose input carries the result. `toolCall` records both halves so
  // the phase can assert they are the same call, by id.
  if (upstream.toolCall && !upstream.toolCall.answered) {
    if (upstream.toolCall.requested === null) {
      upstream.toolCall.requested = toolCallItem(upstream.toolCall);
      return {
        ok: true,
        events: functionCallEvents(upstream.toolCall.requested),
      };
    }
    upstream.toolCall.answered = true;
    upstream.toolCall.secondTurnInput = request.body?.input ?? [];
  }
  const itemId = "msg_e2e";
  const message = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
  };
  return {
    ok: true,
    events: [
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_e2e",
            object: "response",
            status: "in_progress",
            output: [],
          },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: REPLY_TEXT,
        },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: 0,
          item: message,
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_e2e",
            object: "response",
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      },
    ],
  };
};

/** The `shell` function call this run asks the host to execute. */
function toolCallItem(plan) {
  return {
    id: "fc_e2e_1",
    call_id: plan.callId,
    type: "function_call",
    name: plan.toolName,
    arguments: JSON.stringify(plan.arguments),
    status: "completed",
  };
}

/** One completed turn whose only output item is that function call. */
function functionCallEvents(item) {
  return [
    {
      event: "response.created",
      data: {
        type: "response.created",
        response: {
          id: "resp_e2e_tool",
          object: "response",
          status: "in_progress",
          output: [],
        },
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", arguments: "" },
      },
    },
    {
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      },
    },
    {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: 0, item },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_e2e_tool",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    },
  ];
}

async function runCodexExec(codexBin, environment, extraArgs) {
  if (activePhaseId) hostRuns.push({ phase: activePhaseId, binary: codexBin });
  return new Promise((resolve, reject) => {
    const child = spawn(
      codexBin,
      ["exec", "--skip-git-repo-check", ...extraArgs, "say hi"],
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FAROL_MODEL_E2E_CODEX_EXEC_TIMEOUT"));
    }, CODEX_EXEC_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // `codex exec` waits for stdin unless it is closed immediately; there
    // is no interactive input for this one-shot prompt.
    child.stdin.end();
  });
}

async function findRealCodex() {
  const override = process.env.FAROL_MODEL_E2E_CODEX_BIN;
  if (override) return override;
  try {
    const { stdout } = await execFileAsync("which", ["codex"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment a phase runs the host in: never the owner's CODEX_HOME,
 * and never the Node the shell happened to have.
 *
 * S35-TA-5: the host was inheriting whatever `node` was first on PATH — on
 * this machine v22.19.0, which this project does not build with — so a run
 * could pass against a runtime the product never ships on and the report
 * would not say so. `pinnedNodeBin` is put first; if the pinned Node cannot
 * be found the script fails loudly rather than quietly using another one.
 */
function hostEnvironment(codexHome, extra = {}) {
  const environment = { ...process.env };
  delete environment.FAROL_MODEL_TOKEN;
  return {
    ...environment,
    PATH: `${pinnedNodeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    CODEX_HOME: codexHome,
    ...extra,
  };
}

/**
 * The directory holding the Node this script itself runs on, required to be
 * one of the project's supported versions. Running the journey on an
 * unsupported Node is a refusal, not a warning: the alternative is a green
 * report about a runtime the product does not ship on.
 */
function resolvePinnedNodeBin() {
  if (!SUPPORTED_NODE_VERSIONS.includes(process.versions.node)) {
    throw new Error(
      `FAROL_MODEL_E2E_NODE_UNSUPPORTED: running on Node ${process.versions.node}, ` +
        `this project builds with ${SUPPORTED_NODE_VERSIONS.join(" or ")}. ` +
        `Re-run with the pinned Node first on PATH.`,
    );
  }
  return path.dirname(process.execPath);
}

const pinnedNodeBin = resolvePinnedNodeBin();

function logRun(label, run) {
  console.log(`--- codex exec (${label}) exit=${run.code} stdout ---`);
  console.log(run.stdout);
  if (run.stderr) {
    console.log(`--- codex exec (${label}) stderr ---`);
    console.log(run.stderr);
  }
}

// S35-TA-12: which binary answered which phase, recorded where the host is
// actually executed rather than inferred from phase names. One journey runs
// two binaries — the located shim and the binary discovery offers — and both
// report the same version, so nothing else distinguishes them.
let activePhaseId = null;
const hostRuns = [];
/**
 * Phases that run no host binary at all. Recorded by the phase itself, to
 * the same standard as the binaries: an unattributed phase and a phase
 * nobody wrote down look identical in a report, and only one is fine.
 */
const hostlessPhases = [];
/** `codex --version` per binary: two binaries can report the same string. */
const hostVersions = new Map();

async function phase(id, body) {
  activePhaseId = id;
  const startedAt = Date.now();
  const entry = { id, status: "FAIL", durationMs: 0, details: {} };
  report.phases.push(entry);
  console.log(`=== phase ${id} ===`);
  try {
    entry.details = (await body()) ?? {};
    entry.status = "PASS";
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    entry.durationMs = Date.now() - startedAt;
  }
}

async function writeReport() {
  report.finishedAtIso = new Date().toISOString();
  // S35-TA-12: built here, not earlier, because only here are BOTH binaries
  // and the full phase list known — discovery runs inside a phase. `hosts`
  // is grouped from what actually executed, so attribution is recorded
  // rather than assumed.
  // S35-TA-14: the construction lives in `identityFromRunRecords`, so the
  // journey's own records are validated by the same rule a report is. It
  // used to be inline here, and it FILTERED the host-less list against the
  // runs — normalising a self-contradictory record set into a clean one, so
  // the ambiguity check could never fire from a real run.
  if (hostRuns.length > 0) {
    report.identity = identityFromRunRecords({
      repositoryRoot: path.resolve(here, "../../.."),
      // U2b: the digest of the bundle this run actually imported, taken
      // from the file on disk, so the descriptor is bound to the bytes
      // rather than merely naming their path.
      loader: {
        kind: "source-level",
        bundlePath: bundleOutput,
        bundleSha256: bundleDigest(bundleOutput),
      },
      hostRuns,
      hostlessPhases,
      hostVersions,
      phaseIds: report.phases.map((phase) => phase.id),
      nodeVersion: process.versions.node,
    });
    console.log(
      `IDENTITY: source ${report.identity.sourceCommit}` +
        `${report.identity.sourceDirty ? " (dirty)" : ""}` +
        ` · ${report.identity.loader.kind}` +
        ` · node ${report.identity.nodeVersion}` +
        report.identity.hosts
          .map((h) => `\n  ${h.binary} -> ${h.phases.join(", ")}`)
          .join(""),
    );
  }
  // S35-TA-5: a run that cannot say which bytes it exercised is not evidence
  // of anything, whatever its phases did. Refused here, not filtered later.
  assertReportIdentity(report);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`REPORT: ${reportPath}`);
  console.log(`STATUS: ${report.status}`);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-e2e-"));
  try {
    const stateRoot = path.join(root, "private", "model-endpoint");
    const state = new FarolModelRuntimeState(stateRoot);
    const endpoint = track(
      new FarolModelEndpoint({
        state,
        model: ROUTE_B_MODEL,
        handler: turnHandler,
      }),
    );
    const { port } = await endpoint.start();
    const token = await state.currentToken();
    assert.ok(token, "endpoint must mint a token on start");
    const baseUrl = `http://127.0.0.1:${port}`;

    const codexBin = await findRealCodex();
    if (!codexBin) {
      console.log(
        "REAL_HOST_UNAVAILABLE: no `codex` binary found on PATH " +
          "(set FAROL_MODEL_E2E_CODEX_BIN to point at one). " +
          "Covering the same path with a stub upstream only proves the " +
          "config+endpoint plumbing, not a real host; this run stops here " +
          "rather than claiming the real-host case.",
      );
      await endpoint.stop();
      report.status = "REAL_HOST_UNAVAILABLE";
      process.exitCode = EXIT_REAL_HOST_UNAVAILABLE;
      return;
    }
    report.hostBinary = codexBin;
    const { stdout: versionOut } = await execFileAsync(codexBin, ["--version"]);
    report.hostVersion = versionOut.trim();
    hostVersions.set(codexBin, report.hostVersion);
    // S35-TA-5: which bytes of Farol this run exercised, derived through the
    // same `sourceIdentity` the ordinary lanes use, plus which host answered
    // and which Node launched it. Deliberately not an evidence attempt: this
    // journey has no lane contract yet and stays a witness note on the Route
    // B rows until one exists.

    /** Runs the host once and returns what the endpoint saw during that run. */
    async function observedRun(label, codexHome, environment, extraArgs) {
      const before = endpoint.evidence();
      const callsBefore = upstream.calls;
      const authBefore = upstream.authorizations.length;
      const run = await runCodexExec(codexBin, environment, extraArgs);
      logRun(label, run);
      const after = endpoint.evidence();
      return {
        run,
        codexHome,
        accepted: after.requestsAccepted - before.requestsAccepted,
        rejected: after.requestsRejected - before.requestsRejected,
        upstreamCalls: upstream.calls - callsBefore,
        authorizations: upstream.authorizations.slice(authBefore),
        models: upstream.models.slice(authBefore),
        lastRejectedReason: after.lastRejectedReason ?? null,
      };
    }

    // ------------------------------------------------------------------
    const envKeyHome = path.join(root, "codex-home-env-key");
    await fs.mkdir(envKeyHome, { recursive: true });
    const envKeyConfig = path.join(envKeyHome, "config.toml");
    const envKeySpec = {
      providerName: "farol",
      displayName: "Farol Model",
      baseUrl,
      model: ROUTE_B_MODEL,
      wireApi: "responses",
      delivery: { mode: "env-key", envKeyName: "FAROL_MODEL_TOKEN" },
    };

    await phase("env-key-overrides", async () => {
      const applied = await applyFarolModelConfigBlock(
        envKeyConfig,
        envKeySpec,
      );
      assert.equal(applied.status, "applied");
      const config = await fs.readFile(envKeyConfig, "utf8");
      console.log("--- managed config.toml (env-key) ---");
      console.log(config);
      assert.ok(
        !config.includes("[profiles."),
        "never a [profiles.<name>] table",
      );
      assert.ok(config.includes("request_max_retries = 0"));
      assert.ok(config.includes("stream_max_retries = 0"));
      assert.ok(config.includes("requires_openai_auth = false"));
      assert.ok(config.includes("stream_idle_timeout_ms = 120000"));

      const observed = await observedRun(
        "env-key, -c overrides",
        envKeyHome,
        hostEnvironment(envKeyHome, { FAROL_MODEL_TOKEN: token }),
        ["-c", "model_provider=farol", "-c", `model=${ROUTE_B_MODEL}`],
      );
      assert.equal(
        observed.run.code,
        0,
        `codex exec must exit 0, exit=${observed.run.code}`,
      );
      assert.ok(
        observed.run.stdout.includes(REPLY_TEXT),
        "codex must print the model's reply",
      );
      assert.equal(
        observed.accepted,
        1,
        `exactly one served request, saw ${observed.accepted}`,
      );
      assert.equal(
        observed.rejected,
        0,
        `no rejected request, saw ${observed.rejected}`,
      );
      assert.deepEqual(observed.authorizations, [`Bearer ${token}`]);
      assert.deepEqual(observed.models, [ROUTE_B_MODEL]);
      return {
        exitCode: observed.run.code,
        accepted: observed.accepted,
        rejected: observed.rejected,
        authorizationMatched: true,
        model: observed.models[0],
      };
    });

    await phase("env-key-selection", async () => {
      // N04 addendum: selecting the provider is a second, separately
      // consented root-table region — `model_provider` and `model` — so a
      // plain `codex exec` needs no per-call `-c` override at all.
      const selected = await applyFarolModelProviderSelection(
        envKeyConfig,
        envKeySpec,
      );
      assert.equal(selected.status, "applied");
      const config = await fs.readFile(envKeyConfig, "utf8");
      console.log("--- config.toml with provider selection (env-key) ---");
      console.log(config);
      assert.ok(config.includes('model_provider = "farol"'));
      assert.ok(config.includes(`model = "${ROUTE_B_MODEL}"`));

      const observed = await observedRun(
        "env-key, consented selection",
        envKeyHome,
        hostEnvironment(envKeyHome, { FAROL_MODEL_TOKEN: token }),
        [],
      );
      assert.equal(
        observed.run.code,
        0,
        `codex exec must exit 0, exit=${observed.run.code}`,
      );
      assert.ok(
        observed.run.stdout.includes(REPLY_TEXT),
        "codex must print the model's reply using the consented selection alone",
      );
      assert.equal(observed.accepted, 1);
      assert.equal(observed.rejected, 0);
      assert.deepEqual(observed.models, [ROUTE_B_MODEL]);
      return {
        exitCode: observed.run.code,
        accepted: observed.accepted,
        rejected: observed.rejected,
      };
    });

    // ------------------------------------------------------------------
    const bearerHome = path.join(root, "codex-home-bearer-token");
    await fs.mkdir(bearerHome, { recursive: true });
    const bearerConfig = path.join(bearerHome, "config.toml");
    const bearerSpec = {
      ...envKeySpec,
      delivery: { mode: "bearer-token", token },
    };

    await phase("bearer-token-config", async () => {
      // The production delivery (the Setup control builds exactly this
      // spec): the literal in a file this module creates 0600, nothing in
      // the environment, and the consented selection so no `-c` is needed.
      const applied = await applyFarolModelConfigBlock(
        bearerConfig,
        bearerSpec,
      );
      assert.equal(applied.status, "applied");
      const selected = await applyFarolModelProviderSelection(
        bearerConfig,
        bearerSpec,
      );
      assert.equal(selected.status, "applied");
      const mode = (await fs.stat(bearerConfig)).mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `config.toml must be 0600, was ${mode.toString(8)}`,
      );
      const config = await fs.readFile(bearerConfig, "utf8");
      console.log(
        "--- managed config.toml (bearer-token; token redacted in this log) ---",
      );
      console.log(config.split(token).join("<token>"));
      assert.ok(config.includes(`experimental_bearer_token = "${token}"`));
      assert.ok(!config.includes("env_key"));

      const environment = hostEnvironment(bearerHome);
      assert.equal(
        environment.FAROL_MODEL_TOKEN,
        undefined,
        "no token in the environment",
      );
      const observed = await observedRun(
        "bearer-token, no env, no -c",
        bearerHome,
        environment,
        [],
      );
      assert.equal(
        observed.run.code,
        0,
        `codex exec must exit 0, exit=${observed.run.code}`,
      );
      assert.ok(
        observed.run.stdout.includes(REPLY_TEXT),
        "codex must print the fixture reply",
      );
      assert.equal(
        observed.accepted,
        1,
        `exactly one served request, saw ${observed.accepted}`,
      );
      assert.equal(
        observed.rejected,
        0,
        `no rejected request, saw ${observed.rejected}`,
      );
      assert.equal(observed.upstreamCalls, 1);
      assert.deepEqual(
        observed.authorizations,
        [`Bearer ${token}`],
        "the host must present exactly Authorization: Bearer <token>",
      );
      assert.deepEqual(observed.models, [ROUTE_B_MODEL]);
      return {
        exitCode: observed.run.code,
        configMode: mode.toString(8),
        tokenInEnvironment: false,
        overrides: [],
        accepted: observed.accepted,
        rejected: observed.rejected,
        authorizationMatched: true,
        model: observed.models[0],
      };
    });

    await phase("no-retry-on-failure", async () => {
      // The upstream fails exactly once. With request_max_retries = 0 in the
      // block, the host must give up after one request; a retry would show
      // up here as a second request that the (now healthy) upstream would
      // happily serve.
      upstream.failNext = true;
      const observed = await observedRun(
        "bearer-token, upstream fails once",
        bearerHome,
        hostEnvironment(bearerHome),
        [],
      );
      assert.notEqual(
        observed.run.code,
        0,
        "codex exec must fail when the one request fails",
      );
      assert.equal(
        observed.accepted + observed.rejected,
        1,
        `the endpoint must see exactly one request, saw accepted=${observed.accepted} rejected=${observed.rejected}`,
      );
      assert.equal(observed.rejected, 1);
      assert.equal(observed.upstreamCalls, 1);
      assert.equal(
        observed.lastRejectedReason,
        "FAROL_MODEL_E2E_SYNTHETIC_FAILURE",
      );
      assert.equal(upstream.failNext, false);
      assert.ok(
        !observed.run.stdout.includes(REPLY_TEXT),
        "no reply may be printed for a failed turn",
      );
      return {
        exitCode: observed.run.code,
        requestsSeen: observed.accepted + observed.rejected,
        rejected: observed.rejected,
        lastRejectedReason: observed.lastRejectedReason,
      };
    });

    // ==================================================================
    // S35-TA-3 — the application's own journey, through the modules the
    // desktop calls. From here the endpoint is owned by a real
    // `FarolModelLifecycle`, not built by this script, and every config
    // operation goes through the production preview/apply/rollback pair.
    // ==================================================================

    // Set by `app-host-discovery` to the path the PRODUCT offered.
    let discoveredHostBin = codexBin;

    /** Runs the host once and reports what THIS lifecycle's endpoint saw. */
    async function observedAppRun(label, lifecycle, environment, extraArgs) {
      const live = lifecycle.endpoint;
      assert.ok(live, "the lifecycle must own a live endpoint");
      const before = live.evidence();
      const callsBefore = upstream.calls;
      const authBefore = upstream.authorizations.length;
      const run = await runCodexExec(discoveredHostBin, environment, extraArgs);
      logRun(label, run);
      const after = live.evidence();
      return {
        run,
        accepted: after.requestsAccepted - before.requestsAccepted,
        rejected: after.requestsRejected - before.requestsRejected,
        upstreamCalls: upstream.calls - callsBefore,
        authorizations: upstream.authorizations.slice(authBefore),
        models: upstream.models.slice(authBefore),
        lastRejectedReason: after.lastRejectedReason ?? null,
      };
    }

    /** The spec `main.ts` builds: lifecycle status plus the live token. */
    async function appSpec(lifecycle) {
      const status = lifecycle.status();
      if (status.state !== "listening" && status.state !== "connected") {
        return null;
      }
      const currentToken = await lifecycle.runtimeState.currentToken();
      if (!currentToken) return null;
      return {
        providerName: "farol",
        displayName: "Farol Model",
        baseUrl: `http://127.0.0.1:${status.port}`,
        model: ROUTE_B_MODEL,
        wireApi: "responses",
        delivery: { mode: "bearer-token", token: currentToken },
      };
    }

    const appHome = path.join(root, "codex-home-app");
    await fs.mkdir(appHome, { recursive: true });
    const appConfig = path.join(appHome, "config.toml");
    // An owner's own config the product must preserve untouched.
    const OWNER_PREAMBLE =
      '# the owner\'s own file\nmodel_reasoning_effort = "low"\n\n';
    await fs.writeFile(appConfig, OWNER_PREAMBLE, { mode: 0o600 });

    const appLifecycle = track(
      new FarolModelLifecycle({
        stateRoot: path.join(root, "private", "app-model-endpoint"),
        model: ROUTE_B_MODEL,
        handler: turnHandler,
      }),
    );

    await phase("app-host-discovery", async () => {
      // Declared, not inferred: this phase executes no `codex` binary — it
      // reads the filesystem through the product's discovery and the process
      // table through its presence check.
      hostlessPhases.push("app-host-discovery");
      // The product's own discovery, not this script's `which`.
      const discovered = await discoverExecutables("codex");
      const realBin = await fs.realpath(codexBin).catch(() => codexBin);
      const offers = discovered.candidates.filter(
        (candidate) => candidate.verdict === "offer",
      );
      const match = discovered.candidates.find(
        (candidate) => candidate.path === realBin,
      );
      console.log(
        `discovery searched ${discovered.searched.length} paths, ` +
          `${discovered.candidates.length} candidate(s), ` +
          `${offers.length} offered`,
      );
      for (const candidate of discovered.candidates) {
        console.log(
          `  ${candidate.verdict.padEnd(18)} ${candidate.origin.padEnd(14)} ${candidate.path}`,
        );
      }
      // The presence check that decides the restart note: read-only, and
      // it never signals or kills anything.
      const presence = await detectCodexHostPresence({
        executablePath: realBin,
        listProcesses: psProcessLister,
      });
      console.log(`host presence: ${JSON.stringify(presence)}`);
      assert.ok(
        Array.isArray(discovered.candidates),
        "discovery must return a well-formed result",
      );
      assert.ok(
        ["running", "not_running", "unknown"].includes(presence.state),
        `presence state must be a closed value, saw ${presence.state}`,
      );
      if (match) {
        assert.equal(
          match.verdict,
          "offer",
          `the installed host must be offered, not ${match.verdict}` +
            `${match.refusalReason ? ` (${match.refusalReason})` : ""}`,
        );
      }
      // `which codex` finds a Node shim whose realpath is a `.js` file;
      // discovery resolves the vendor binary behind it, which is why the
      // two paths differ and why the phases below run what the PRODUCT
      // offered rather than what this script found. A machine with no
      // offer is recorded as a discovery limit — the journey then keeps
      // the located binary rather than claiming a discovery that did not
      // happen.
      if (offers.length > 0) {
        discoveredHostBin = offers[0].path;
        report.discoveredHostBinary = discoveredHostBin;
        // Its own `--version`: the two binaries can report the same string,
        // which is exactly why the binary is recorded and not just this.
        const discoveredVersion = await execFileAsync(discoveredHostBin, [
          "--version",
        ]).catch(() => null);
        if (discoveredVersion) {
          hostVersions.set(discoveredHostBin, discoveredVersion.stdout.trim());
        }
        console.log(`application journey will run: ${discoveredHostBin}`);
      }
      return {
        searchedPaths: discovered.searched.length,
        candidates: discovered.candidates.length,
        offered: offers.length,
        offeredPaths: offers.map((candidate) => candidate.path),
        offeredOrigins: offers.map((candidate) => candidate.origin),
        locatedHostAmongCandidates: Boolean(match),
        journeyRunsDiscoveredHost: discoveredHostBin !== codexBin,
        presenceState: presence.state,
      };
    });

    await phase("app-preview-decline-apply", async () => {
      await appLifecycle.start();
      const status = appLifecycle.status();
      assert.equal(status.state, "listening");
      const spec = await appSpec(appLifecycle);
      assert.ok(spec, "the application must be able to describe its endpoint");

      // Preview: the owner sees the exact block before anything is written.
      const preview = await previewFarolModelConfigBlock(appConfig, spec);
      assert.equal(preview.status, "install");
      const beforeDecline = await fs.readFile(appConfig, "utf8");

      // Decline: previewing changes nothing at all.
      assert.equal(beforeDecline, OWNER_PREAMBLE);

      const applied = await applyFarolModelConfigBlock(appConfig, spec);
      assert.equal(applied.status, "applied");
      const selection = await previewFarolModelProviderSelection(
        appConfig,
        spec,
      );
      assert.ok(
        selection.status === "install" || selection.status === "update",
        `selection must be offerable, saw ${selection.status}`,
      );
      const selected = await applyFarolModelProviderSelection(appConfig, spec);
      assert.equal(selected.status, "applied");

      const config = await fs.readFile(appConfig, "utf8");
      console.log("--- managed config.toml (application journey) ---");
      console.log(config.replace(spec.delivery.token, "<token>"));
      assert.ok(
        config.startsWith(OWNER_PREAMBLE),
        "the owner's own lines must be preserved byte for byte",
      );
      assert.ok(!config.includes("[profiles."), "never a [profiles.] table");
      assert.ok(config.includes("request_max_retries = 0"));
      const mode = (await fs.stat(appConfig)).mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `config.toml must stay 0600, saw ${mode.toString(8)}`,
      );

      // The real host, with no -c and no token in the environment.
      const observed = await observedAppRun(
        "application journey, consented selection",
        appLifecycle,
        hostEnvironment(appHome),
        [],
      );
      assert.equal(observed.run.code, 0, "codex exec must exit 0");
      assert.ok(observed.run.stdout.includes(REPLY_TEXT));
      assert.equal(observed.accepted, 1, "exactly one served request");
      assert.equal(observed.rejected, 0);
      assert.deepEqual(observed.authorizations, [
        `Bearer ${spec.delivery.token}`,
      ]);
      assert.deepEqual(observed.models, [ROUTE_B_MODEL]);
      assert.equal(appLifecycle.status().state, "connected");
      return {
        previewStatus: preview.status,
        declineChangedNothing: true,
        requestedModel: ROUTE_B_MODEL,
        observedModel: observed.models[0],
        accepted: observed.accepted,
        configMode: "600",
      };
    });

    await phase("app-tool-roundtrip", async () => {
      // One correlated tool roundtrip on the real host: Farol answers the
      // first turn with a function call, the host runs it and opens a
      // SECOND turn carrying the result. What is asserted is the
      // correlation — the same call_id comes back with its output —
      // because that is what makes a roundtrip a roundtrip rather than
      // two unrelated requests.
      const advertised = upstream.toolNames.at(-1) ?? [];
      console.log(`host advertises tools: ${JSON.stringify(advertised)}`);
      const shellTool = advertised.find(
        (name) =>
          typeof name === "string" &&
          (name === "exec_command" || name === "shell"),
      );
      assert.ok(
        shellTool,
        `the host must advertise a command tool, saw ${JSON.stringify(advertised)}`,
      );
      const schema = upstream.lastTools.find(
        (tool) => (tool?.name ?? tool?.type) === shellTool,
      );
      console.log(`tool schema: ${JSON.stringify(schema)}`);

      upstream.toolCall = {
        toolName: shellTool,
        callId: "call_farol_e2e_roundtrip",
        // Measured from the host's own advertised schema (logged above):
        // `exec_command` takes one required string `cmd`.
        arguments:
          shellTool === "exec_command"
            ? { cmd: "/bin/echo farol-roundtrip-ok" }
            : { command: ["/bin/echo", "farol-roundtrip-ok"] },
        requested: null,
        answered: false,
        secondTurnInput: null,
      };

      const observed = await observedAppRun(
        "application journey, one tool roundtrip",
        appLifecycle,
        hostEnvironment(appHome),
        [],
      );
      assert.equal(observed.run.code, 0, "the roundtrip turn must complete");
      // Two served requests, not one: the call and the turn carrying its
      // result. A host that never ran the tool would show only one.
      assert.equal(
        observed.accepted,
        2,
        `the roundtrip is exactly two served requests, saw ${observed.accepted}`,
      );
      assert.equal(observed.rejected, 0);
      assert.ok(upstream.toolCall.answered, "the host must open a second turn");

      const followUp = upstream.toolCall.secondTurnInput ?? [];
      const outputs = followUp.filter(
        (item) => item?.type === "function_call_output",
      );
      assert.equal(
        outputs.length,
        1,
        `exactly one tool result must come back, saw ${outputs.length}`,
      );
      assert.equal(
        outputs[0].call_id,
        upstream.toolCall.callId,
        "the result must carry the call_id Farol issued",
      );
      const rendered = JSON.stringify(outputs[0].output ?? "");
      assert.ok(
        rendered.includes("farol-roundtrip-ok"),
        `the tool's real output must come back, saw ${rendered.slice(0, 200)}`,
      );
      // And the second turn still went to the same model on the same
      // authenticated endpoint.
      assert.deepEqual(observed.models, [ROUTE_B_MODEL, ROUTE_B_MODEL]);
      const result = {
        toolName: shellTool,
        servedRequests: observed.accepted,
        callId: outputs[0].call_id,
        correlated: true,
      };
      upstream.toolCall = null;
      return result;
    });

    await phase("app-rotation-then-host", async () => {
      const staleToken = await appLifecycle.runtimeState.currentToken();
      const rotated = await appLifecycle.rotateAndRewrite({
        configPath: appConfig,
        spec: () => appSpec(appLifecycle),
        preview: previewFarolModelConfigBlock,
        apply: applyFarolModelConfigBlock,
      });
      assert.deepEqual(rotated, {
        ok: true,
        providerBlockUpdated: true,
        providerBlockStatus: "update",
      });
      const freshToken = await appLifecycle.runtimeState.currentToken();
      assert.ok(freshToken && freshToken !== staleToken);
      const config = await fs.readFile(appConfig, "utf8");
      assert.ok(
        config.includes(freshToken),
        "the block must carry the new literal",
      );
      assert.ok(!config.includes(staleToken), "and no longer the old one");

      // The endpoint refuses the literal the owner's config no longer
      // has. The body is irrelevant: an unauthenticated caller is refused
      // before any route is dispatched or any body is read.
      const stale = await fetch(
        `http://127.0.0.1:${appLifecycle.status().port}/responses`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${staleToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      assert.equal(stale.status, 401);
      await stale.text();

      const observed = await observedAppRun(
        "application journey, after rotation",
        appLifecycle,
        hostEnvironment(appHome),
        [],
      );
      assert.equal(observed.run.code, 0);
      assert.equal(observed.accepted, 1);
      assert.deepEqual(observed.authorizations, [`Bearer ${freshToken}`]);
      return {
        blockUpdated: true,
        staleLiteralRefused: 401,
        accepted: observed.accepted,
      };
    });

    await phase("app-revocation-no-retry", async () => {
      // The owner revokes the token while the host still carries the
      // literal the config was written with: every request must be refused
      // ONCE, with no second submission of an unknown effect.
      await appLifecycle.runtimeState.clearToken();
      const observed = await observedAppRun(
        "application journey, token revoked",
        appLifecycle,
        hostEnvironment(appHome),
        [],
      );
      assert.notEqual(observed.run.code, 0, "the host must fail, not retry");
      assert.equal(observed.accepted, 0, "nothing may be served");
      assert.equal(
        observed.rejected,
        1,
        `exactly one refused request, saw ${observed.rejected}`,
      );
      assert.equal(observed.upstreamCalls, 0, "no turn may reach the upstream");
      assert.equal(observed.lastRejectedReason, "FAROL_MODEL_TOKEN_UNSET");
      assert.ok(!observed.run.stdout.includes(REPLY_TEXT));
      return {
        exitCode: observed.run.code,
        rejected: observed.rejected,
        upstreamCalls: observed.upstreamCalls,
        lastRejectedReason: observed.lastRejectedReason,
      };
    });

    await phase("app-restart-reconnect", async () => {
      // Put the connection back the way an owner would: mint, re-apply the
      // block (idempotent), then restart the app on the same private state.
      await appLifecycle.runtimeState.ensureToken();
      const reSpec = await appSpec(appLifecycle);
      assert.ok(reSpec);
      const reapplied = await applyFarolModelConfigBlock(appConfig, reSpec);
      assert.equal(reapplied.status, "applied");
      const portBefore = appLifecycle.status().port;
      await appLifecycle.stop();
      assert.deepEqual(appLifecycle.status(), { state: "not_running" });

      const restarted = track(
        new FarolModelLifecycle({
          stateRoot: path.join(root, "private", "app-model-endpoint"),
          model: ROUTE_B_MODEL,
          handler: turnHandler,
        }),
      );
      await restarted.start();
      const portAfter = restarted.status().port;
      assert.equal(
        portAfter,
        portBefore,
        `the persisted port must be reused, ${portBefore} -> ${portAfter}`,
      );

      const observed = await observedAppRun(
        "application journey, after restart",
        restarted,
        hostEnvironment(appHome),
        [],
      );
      assert.equal(
        observed.run.code,
        0,
        "the unchanged config must work again",
      );
      assert.equal(observed.accepted, 1);
      await restarted.stop();
      return { portBefore, portAfter, accepted: observed.accepted };
    });

    await phase("app-conflict-and-rollback", async () => {
      // A provider entry of the same name that Farol did not write.
      const foreignHome = path.join(root, "codex-home-foreign");
      await fs.mkdir(foreignHome, { recursive: true });
      const foreignConfig = path.join(foreignHome, "config.toml");
      const foreignBytes =
        '[model_providers.farol]\nname = "someone else"\n' +
        'base_url = "http://127.0.0.1:9/v1"\n';
      await fs.writeFile(foreignConfig, foreignBytes, { mode: 0o600 });
      const conflictSpec = {
        providerName: "farol",
        displayName: "Farol Model",
        baseUrl: "http://127.0.0.1:1/v1",
        model: ROUTE_B_MODEL,
        wireApi: "responses",
        delivery: { mode: "bearer-token", token: "a".repeat(43) },
      };
      const conflictPreview = await previewFarolModelConfigBlock(
        foreignConfig,
        conflictSpec,
      );
      assert.equal(conflictPreview.status, "conflict");
      const conflictApply = await applyFarolModelConfigBlock(
        foreignConfig,
        conflictSpec,
      );
      assert.notEqual(conflictApply.status, "applied");
      assert.equal(
        await fs.readFile(foreignConfig, "utf8"),
        foreignBytes,
        "a foreign entry leaves the file byte-identical",
      );

      // Rollback removes exactly the managed regions.
      const selectionBack =
        await rollbackFarolModelProviderSelection(appConfig);
      assert.equal(selectionBack.status, "restored");
      const blockBack = await rollbackFarolModelConfigBlock(appConfig);
      assert.equal(blockBack.status, "restored");
      const after = await fs.readFile(appConfig, "utf8");
      assert.ok(!after.includes("model_providers.farol"));
      assert.ok(!after.includes("BEGIN FAROL"));
      assert.ok(
        after.includes('model_reasoning_effort = "low"'),
        "the owner's own lines survive the rollback",
      );

      // And the host can no longer reach Farol through that config.
      const run = await runCodexExec(
        discoveredHostBin,
        hostEnvironment(appHome),
        [],
      );
      logRun("application journey, after rollback", run);
      assert.notEqual(
        run.code,
        0,
        "a rolled-back config must not still reach Farol",
      );
      assert.ok(!run.stdout.includes(REPLY_TEXT));
      return {
        conflictStatus: conflictPreview.status,
        foreignFileUnchanged: true,
        selectionRollback: selectionBack.status,
        blockRollback: blockBack.status,
        hostExitAfterRollback: run.code,
      };
    });

    console.log(
      "OBSERVED_RESULT: endpoint evidence =",
      JSON.stringify(endpoint.evidence()),
    );
    await endpoint.stop();
    report.status = "PASS";
    process.exitCode = EXIT_PASS;
  } finally {
    // Whatever happened above, nothing this script started may outlive it.
    await stopEverything();
    // The host copies a plugins tree into `<CODEX_HOME>/.tmp` and removes
    // it as it exits, so a recursive remove issued at the same instant can
    // see ENOTEMPTY. That is the host tidying its own scratch directory,
    // not a result: retry briefly rather than fail a finished run on it.
    await removeTree(root);
  }
}

async function removeTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = EXIT_FAIL;
} finally {
  await writeReport();
  await fs.rm(path.dirname(bundleOutput), { recursive: true, force: true });
}
