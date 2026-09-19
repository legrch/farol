// Packet N04 (Decisions.md, run farol-local-completion-0919): end-to-end
// proof that an ordinary, supported Codex can reach a Farol Model endpoint
// through the managed-config-block lifecycle, using a disposable CODEX_HOME
// and the real `codex` binary when one is installed on this machine.
//
// This never touches the owner's ~/.codex, never restarts the owner's
// Codex, and never contacts a live account: the upstream is this process's
// own synthetic SSE responder, reachable only on 127.0.0.1.
//
// Run with: node tests/e2e/farol-model-codex-exec.e2e.mjs
//
// The three TypeScript modules under test import each other by
// extensionless specifier (this repo's normal style, resolved by `tsc`'s
// Bundler moduleResolution and by Vitest's esbuild transform). Node's own
// ESM loader requires exact, extensioned specifiers even under
// --experimental-transform-types, so this script bundles the same three
// files with esbuild — the toolchain already depends on for `tooling/
// build.mjs` — into one temporary ESM module and imports that instead of
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

const here = path.dirname(fileURLToPath(import.meta.url));
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
});
const {
  FarolModelRuntimeState,
  FarolModelEndpoint,
  applyFarolModelConfigBlock,
} = await import(bundleOutput);

const spec = {
  providerName: "farol",
  profileName: "farol",
  displayName: "Farol Model",
  baseUrl: "",
  envKeyName: "FAROL_MODEL_TOKEN",
  model: "farol-model",
  wireApi: "responses",
};

const turnHandler = async (request) => {
  const auth = request.headers.authorization;
  assert.ok(auth?.startsWith("Bearer "), "codex must send a bearer token");
  const text = "farol model e2e reply";
  const itemId = "msg_e2e";
  const events = [
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
        item: {
          id: itemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      },
    },
    {
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: itemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
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
          output: [
            {
              id: itemId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    },
  ];
  return { ok: true, events };
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
    }, 30_000);
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

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-e2e-"));
  try {
    const stateRoot = path.join(root, "private", "model-endpoint");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome, { recursive: true });

    const state = new FarolModelRuntimeState(stateRoot);
    const endpoint = new FarolModelEndpoint({ state, handler: turnHandler });
    const { port } = await endpoint.start();
    const token = await state.currentToken();
    assert.ok(token, "endpoint must mint a token on start");

    const configPath = path.join(codexHome, "config.toml");
    const appliedSpec = { ...spec, baseUrl: `http://127.0.0.1:${port}` };
    const applyResult = await applyFarolModelConfigBlock(
      configPath,
      appliedSpec,
    );
    assert.equal(applyResult.status, "applied");

    const configContents = await fs.readFile(configPath, "utf8");
    console.log("--- managed config.toml ---");
    console.log(configContents);

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
      process.exitCode = 0;
      return;
    }

    console.log(`Using real host binary: ${codexBin}`);
    const { stdout: versionOut } = await execFileAsync(codexBin, ["--version"]);
    console.log(`Host version: ${versionOut.trim()}`);

    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      [appliedSpec.envKeyName]: token,
    };

    const beforeEvidence = endpoint.evidence();
    assert.equal(beforeEvidence.requestsAccepted, 0);

    // Selecting the provider via `-c` overrides (the way a one-shot
    // invocation, or a Setup UI that shells out per-call, would pick
    // Farol) exercises the model_providers entry itself — the part of the
    // managed block this host version fully supports.
    const { code, stdout, stderr } = await runCodexExec(codexBin, environment, [
      "-c",
      `model_provider=${appliedSpec.providerName}`,
      "-c",
      `model=${appliedSpec.model}`,
    ]);
    console.log("--- codex exec stdout ---");
    console.log(stdout);
    if (stderr) {
      console.log("--- codex exec stderr ---");
      console.log(stderr);
    }
    assert.equal(code, 0, `codex exec must exit 0, exit=${code}`);

    const afterEvidence = endpoint.evidence();
    assert.ok(
      afterEvidence.requestsAccepted >= 1,
      `expected the endpoint to have served at least one request, evidence=${JSON.stringify(afterEvidence)}`,
    );
    assert.ok(
      stdout.includes("farol model e2e reply"),
      "codex must print the model's reply",
    );

    console.log(
      "OBSERVED_RESULT: endpoint evidence =",
      JSON.stringify(afterEvidence),
    );

    // Documented schema gap: the design's "one profile that selects it"
    // means a `[profiles.<name>]` table inside the managed config.toml
    // block, selected with `--profile`. codex-cli 0.153.4 rejects exactly
    // that combination. This assertion pins the exact host-reported reason
    // rather than leaving it as an unexplained failure.
    const profileAttempt = await runCodexExec(codexBin, environment, [
      "--profile",
      appliedSpec.profileName,
    ]);
    assert.notEqual(profileAttempt.code, 0);
    assert.match(
      profileAttempt.stderr,
      /cannot be used while .* contains legacy .*\[profiles\./u,
    );
    console.log(
      "CONFIRMED_SCHEMA_GAP: --profile with an in-file [profiles.<name>] table is rejected:",
      profileAttempt.stderr.trim(),
    );

    await endpoint.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
