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
  ROUTE_B_MODEL,
} = await import(bundleOutput);

const REPLY_TEXT = "farol model e2e reply";
const CODEX_EXEC_TIMEOUT_MS = 45_000;

const report = {
  status: "FAIL",
  startedAtIso: new Date().toISOString(),
  finishedAtIso: null,
  hostBinary: null,
  hostVersion: null,
  model: ROUTE_B_MODEL,
  hostTuning: FAROL_MODEL_HOST_TUNING,
  phases: [],
  error: null,
};

/** What the synthetic upstream observed and how it should behave next. */
const upstream = {
  calls: 0,
  failNext: false,
  authorizations: [],
  models: [],
};

const turnHandler = async (request) => {
  upstream.calls += 1;
  upstream.authorizations.push(request.headers.authorization ?? null);
  upstream.models.push(request.body?.model ?? null);
  if (upstream.failNext) {
    upstream.failNext = false;
    return { ok: false, reason: "FAROL_MODEL_E2E_SYNTHETIC_FAILURE" };
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

async function runCodexExec(codexBin, environment, extraArgs) {
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

/** The environment a phase runs the host in: never the owner's CODEX_HOME. */
function hostEnvironment(codexHome, extra = {}) {
  const environment = { ...process.env };
  delete environment.FAROL_MODEL_TOKEN;
  return { ...environment, CODEX_HOME: codexHome, ...extra };
}

function logRun(label, run) {
  console.log(`--- codex exec (${label}) exit=${run.code} stdout ---`);
  console.log(run.stdout);
  if (run.stderr) {
    console.log(`--- codex exec (${label}) stderr ---`);
    console.log(run.stderr);
  }
}

async function phase(id, body) {
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
    const endpoint = new FarolModelEndpoint({
      state,
      model: ROUTE_B_MODEL,
      handler: turnHandler,
    });
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
    console.log(`Using real host binary: ${codexBin}`);
    console.log(`Host version: ${report.hostVersion}`);

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

    console.log(
      "OBSERVED_RESULT: endpoint evidence =",
      JSON.stringify(endpoint.evidence()),
    );
    await endpoint.stop();
    report.status = "PASS";
    process.exitCode = EXIT_PASS;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
