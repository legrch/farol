// Closed-contour controller contract: no build, app, VM, network or child
// execution in this test. Every external effect is an injected stub.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseVMDevOptions,
  existingDevInputs,
  requireBuildSuccess,
  buildDevInputs,
  pythonDevArguments,
  runVMDev,
  VMDevRefusal,
} from "../vm-dev.mjs";

const digest = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-vm-dev-controller-"),
  );
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "_output/vm-dev/run-dev1");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const receipt = path.join(output, "vm-dev-artifact.json");
  const artifact = path.join(output, "Farol-Dev.zip");
  const selected = {
    schema: "farol.vm-dev-artifact/1",
    kind: "local-dev-derivative",
    appName: "Farol Dev.app",
    bundleId: "local.farol.dev",
    environment: "dev",
    artifactPath: path.join(output, "Farol Dev.app"),
    artifactSha256: "e".repeat(64),
    officialRelease: false,
    hostLaunch: false,
    profileImport: false,
  };
  const data = Buffer.from(JSON.stringify(selected));
  await fs.writeFile(receipt, data, { mode: 0o600, flag: "wx" });
  await fs.writeFile(artifact, Buffer.from("504b03040000", "hex"), {
    mode: 0o600,
    flag: "wx",
  });
  return {
    root,
    output,
    receipt,
    artifact,
    receiptSHA256: digest(data),
    selected,
  };
}

test("parse: only explicit all-or-none approved options; no arbitrary CLI or app path", () => {
  assert.deepEqual(parseVMDevOptions([]), {
    visible: false,
    artifact: null,
    receipt: null,
    expectedReceiptSHA256: null,
    config: null,
    goInputs: null,
  });
  const good = parseVMDevOptions([
    "--visible",
    "--config",
    "/private/test/vm-smoke.json",
    "--artifact",
    "/private/output/Farol-Dev.zip",
    "--receipt",
    "/private/output/vm-dev-artifact.json",
    "--expected-receipt-sha256",
    "a".repeat(64),
  ]);
  assert.equal(good.visible, true);
  assert.equal(good.config, "/private/test/vm-smoke.json");
  for (const invalid of [
    ["--artifact", "/tmp/Farol-Dev.zip"],
    ["--receipt", "/tmp/receipt"],
    ["--artifact", "/tmp/a", "--receipt", "/tmp/b"],
    ["--expected-receipt-sha256", "a".repeat(64)],
    ["--visible", "--visible"],
    ["--unknown"],
    ["--base", "untrusted-base"],
    [
      "--artifact",
      "/tmp/a",
      "--receipt",
      "/tmp/b",
      "--expected-receipt-sha256",
      "NOT-HEX",
    ],
    ["--go-inputs", "relative.json"],
    ["--go-inputs", "/safe/../unsafe"],
    ["--config", "relative.json"],
    ["--config", "/safe/../unsafe"],
  ])
    assert.throws(() => parseVMDevOptions(invalid), VMDevRefusal);
});

test("selected existing derivative is source-bound and does not self-accept ZIP", async (t) => {
  const f = await fixture(t);
  const input = await existingDevInputs(f.root, {
    artifact: f.artifact,
    receipt: f.receipt,
    expectedReceiptSHA256: f.receiptSHA256,
  });
  assert.equal(input.artifact, f.artifact);
  assert.equal(input.artifactSHA256, f.selected.artifactSha256);
  await assert.rejects(
    existingDevInputs(f.root, {
      artifact: f.artifact,
      receipt: f.receipt,
      expectedReceiptSHA256: "a".repeat(64),
    }),
    /VM_DEV_RECEIPT_CHANGED/,
  );
  await assert.rejects(
    existingDevInputs(f.root, {
      artifact: f.artifact + "/../Farol-Dev.zip",
      receipt: f.receipt,
      expectedReceiptSHA256: f.receiptSHA256,
    }),
    /VM_DEV_ARTIFACT_PATH_INVALID/,
  );
});

test("symlink archive, outer profile path and unsupported receipt cannot pass", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.output, "alias.zip");
  await fs.symlink(f.artifact, alias);
  await assert.rejects(
    existingDevInputs(f.root, {
      artifact: alias,
      receipt: f.receipt,
      expectedReceiptSHA256: f.receiptSHA256,
    }),
    /VM_DEV_ARTIFACT_PATH_INVALID/,
  );
  const badOutput = path.join(f.root, "foreign");
  await fs.mkdir(badOutput, { mode: 0o700 });
  await assert.rejects(
    existingDevInputs(f.root, {
      artifact: path.join(badOutput, "Farol-Dev.zip"),
      receipt: path.join(badOutput, "vm-dev-artifact.json"),
      expectedReceiptSHA256: f.receiptSHA256,
    }),
    /VM_DEV_ARTIFACT_PATH_INVALID/,
  );
  // Even a well-formed digest does not authorize an official stable receipt.
  const raw = JSON.parse(await fs.readFile(f.receipt, "utf8"));
  raw.officialRelease = true;
  await fs.writeFile(f.receipt, JSON.stringify(raw));
  await assert.rejects(
    existingDevInputs(f.root, {
      artifact: f.artifact,
      receipt: f.receipt,
      expectedReceiptSHA256: digest(JSON.stringify(raw)),
    }),
    /VM_DEV_RECEIPT_INVALID/,
  );
});

test("build-only is one exact-source invocation; never dev.mjs, package.mjs or npm ci", () => {
  const calls = [];
  const env = { HOME: "/synthetic", PATH: "/usr/bin" };
  requireBuildSuccess(
    (binary, args, opts) => {
      calls.push({ binary, args, opts });
      return { status: 0, signal: null };
    },
    "/bin/node-approved",
    "/checkout",
    env,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "/checkout/tooling/build.mjs",
    "--go-inputs=/checkout/_output/go-build-inputs.json",
  ]);
  assert.deepEqual(calls[0].opts.stdio, ["ignore", 2, 2]);
  assert.equal(calls[0].opts.env, env);
  assert.throws(
    () => requireBuildSuccess(() => ({ status: 1 }), "/node", "/checkout", env),
    /VM_DEV_BUILD_UNQUALIFIED/,
  );
  for (const result of [
    { status: null, signal: "SIGTERM" },
    { status: null, error: Error("synthetic") },
  ]) {
    assert.throws(
      () => requireBuildSuccess(() => result, "/node", "/checkout", env),
      /VM_DEV_BUILD_OUTCOME_UNKNOWN/,
    );
  }
});

test("producer output is accepted before archive; build failure cannot assemble", async (t) => {
  const f = await fixture(t);
  let assembly = 0;
  await assert.rejects(
    buildDevInputs(f.root, {
      run: () => ({ status: 1 }),
      assemble: async () => {
        assembly++;
      },
      archive: async () => {
        assembly++;
      },
    }),
    /VM_DEV_BUILD_UNQUALIFIED/,
  );
  assert.equal(assembly, 0);
});

test("python handoff contains only exact four accepted fields and optional config", async (t) => {
  const f = await fixture(t);
  const opts = parseVMDevOptions([
    "--visible",
    "--config",
    "/private/test/vm.json",
  ]);
  const args = pythonDevArguments(
    {
      artifact: f.artifact,
      receipt: f.receipt,
      expectedReceiptSHA256: f.receiptSHA256,
    },
    opts,
  );
  assert.deepEqual(args.slice(0, 3), [
    "-I",
    "-B",
    path.join(
      path.resolve(import.meta.dirname, "../.."),
      "tooling/vm-dev-session.py",
    ),
  ]);
  assert.deepEqual(args.slice(3, 9), [
    "--artifact",
    f.artifact,
    "--receipt",
    f.receipt,
    "--expected-receipt-sha256",
    f.receiptSHA256,
  ]);
  assert.deepEqual(args.slice(-3), [
    "--visible",
    "--config",
    "/private/test/vm.json",
  ]);
  assert.equal(args.includes("--owner"), false);
});

test("explicit artifact route skips build and transfers raw MCP stdio unchanged", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const opts = [
    "--artifact",
    f.artifact,
    "--receipt",
    f.receipt,
    "--expected-receipt-sha256",
    f.receiptSHA256,
    "--visible",
  ];
  const exitCode = await runVMDev(opts, {
    root: f.root,
    run: () => {
      throw Error("must not build");
    },
    assemble: () => {
      throw Error("must not assemble");
    },
    archive: () => {
      throw Error("must not rearchive");
    },
    python: (binary, argv, options) => {
      calls.push({ binary, argv, options });
      return { status: 7, error: null, signal: null };
    },
  });
  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, "/usr/bin/python3");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(
    calls[0].options.env.FAROL_VM_TESTING_DIRECTORY,
    "Farol Testing",
  );
  assert.ok(calls[0].argv.includes("--visible"));
  assert.equal(calls[0].argv.includes("--terminal-point"), false);
});

test("MCP process publication ambiguity is not retried, nor converted to exit0", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    runVMDev(
      [
        "--artifact",
        f.artifact,
        "--receipt",
        f.receipt,
        "--expected-receipt-sha256",
        f.receiptSHA256,
      ],
      {
        root: f.root,
        python: () => {
          calls++;
          return { status: null, signal: null, error: Error("unknown") };
        },
      },
    ),
    /VM_DEV_SESSION_OUTCOME_UNKNOWN/,
  );
  assert.equal(calls, 1);
});
