// Tests for the vm-e2e driver bundling prototype (farol.vm-e2e/1).
//
// Scope: these tests prove the host-side bundling/staging shape only. They
// run as plain host node processes: nothing here starts or inspects a VM or
// guest, so this is NOT guest evidence, NOT network containment evidence, and
// claims no VM qualification. The synthetic prototype entry is a shape
// prototype, not a real Farol scenario.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  TOOL_VERSION,
  assertNoHostImports,
  bundleDriver,
  selectDeclaredRuntime,
} from "./bundle-driver.mjs";
import {
  RESULT_FILE,
  resultDirectory,
  writeResult,
} from "./driver-runtime.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = path.join(REPO_ROOT, "tooling", "vm-e2e", "prototype-entry.mjs");
const RUN_TIMEOUT = 30000;

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectStrings(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

function probeSocket(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.on("connect", () => {
      socket.destroy();
      resolve("CONNECTED");
    });
    socket.on("error", (error) => resolve(error.code ?? "ERROR"));
    socket.on("timeout", () => {
      socket.destroy();
      resolve("TIMEOUT");
    });
  });
}

function runBundle(nodePath, bundlePath, cwd) {
  return spawnSync(nodePath, [bundlePath], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: RUN_TIMEOUT,
  });
}

test("bundles the prototype entry into a self-contained guest driver", (t) => {
  const output = makeTempDir(t, "farol-vm-e2e-bundle");
  const manifest = bundleDriver({
    entry: ENTRY,
    outputDir: output,
    root: REPO_ROOT,
  });
  const written = JSON.parse(
    fs.readFileSync(path.join(output, MANIFEST_FILE), "utf8"),
  );
  assert.deepEqual(written, manifest);
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.tool, TOOL_VERSION);
  assert.equal(manifest.entry, "prototype-entry.mjs");
  assert.ok(
    ["esbuild", "inline"].includes(manifest.bundler),
    "manifest records the bundler actually used",
  );

  const bundleBytes = fs.readFileSync(path.join(output, BUNDLE_FILE));
  assert.equal(sha256Hex(bundleBytes), manifest.bundle.sha256);
  assert.equal(bundleBytes.length, manifest.bundle.bytes);

  const expectedNode = selectDeclaredRuntime(REPO_ROOT);
  assert.equal(manifest.node.path, expectedNode);
  assert.equal(manifest.node.size, fs.statSync(expectedNode).size);
  assert.equal(manifest.node.sha256, sha256Hex(fs.readFileSync(expectedNode)));

  // The manifest carries only digests and names; any absolute path it records
  // must be the declared runtime itself.
  const strings = collectStrings(manifest);
  for (const value of strings) {
    if (path.isAbsolute(value)) {
      assert.equal(value, manifest.node.path);
    }
  }

  const bundleText = bundleBytes.toString("utf8");
  assert.doesNotThrow(
    () => assertNoHostImports(bundleText),
    "the staged bundle imports node: builtins only",
  );
  assert.ok(!bundleText.includes(REPO_ROOT), "no repo path in the bundle");
  assert.ok(
    !bundleText.includes(os.homedir()),
    "no host home path in the bundle",
  );
});

test("bundled driver runs from a temp cwd without node_modules or repo access", async (t) => {
  const output = makeTempDir(t, "farol-vm-e2e-bundle2");
  const run = makeTempDir(t, "farol-vm-e2e-run");
  const manifest = bundleDriver({
    entry: ENTRY,
    outputDir: output,
    root: REPO_ROOT,
  });
  const bundleCopy = path.join(run, BUNDLE_FILE);
  fs.copyFileSync(path.join(output, BUNDLE_FILE), bundleCopy);

  const child = runBundle(manifest.node.path, bundleCopy, run);
  assert.equal(child.status, 0, "driver exit: " + child.stderr);
  assert.equal(child.stderr, "");

  const resultPath = path.join(run, "results", RESULT_FILE);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.status, "PASS");
  assert.equal(result.scenario, "vm-e2e-prototype");
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
  assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600);

  // The loopback server socket is released once the driver process exited.
  const outcome = await probeSocket(Number(new URL(result.url).port));
  assert.notEqual(outcome, "CONNECTED");
});

test("bundle refuses an unresolvable bare import", (t) => {
  const source = makeTempDir(t, "farol-vm-e2e-bare");
  const output = makeTempDir(t, "farol-vm-e2e-bareout");
  const entry = path.join(source, "bad-entry.mjs");
  fs.writeFileSync(
    entry,
    'import shuffle from "left-pad";\nconsole.log(shuffle);\n',
    { mode: 0o600 },
  );
  assert.throws(
    () => bundleDriver({ entry, outputDir: output, root: REPO_ROOT }),
    /^Error: E2E_BUNDLE_UNRESOLVED_IMPORT: left-pad$/u,
  );
  assert.deepEqual(
    fs.readdirSync(output),
    [],
    "a refused bundle leaves no residue",
  );
});

test("writeResult publishes with the durable fsync ordering", (t) => {
  const source = fs.readFileSync(
    new URL("./driver-runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("fs.constants.O_EXCL"), "exclusive temp create");
  assert.ok(source.includes("O_NOFOLLOW"), "no-symlink-traversal flags");
  assert.ok(source.includes("0o600"), "0o600 file perms");
  assert.ok(source.includes("0o700"), "0o700 result directory perms");
  const mkdir = source.indexOf("fs.mkdirSync(directory");
  const open = source.indexOf("fs.openSync(temp");
  const write = source.indexOf("fs.writeFileSync(handle,");
  const fileFsync = source.indexOf("fs.fsyncSync(handle)");
  const replace = source.indexOf("fs.renameSync(temp, target)");
  const dirFsync = source.lastIndexOf("fsyncDirectory(directory);");
  for (const [name, position] of [
    ["mkdir", mkdir],
    ["open", open],
    ["write", write],
    ["fileFsync", fileFsync],
    ["replace", replace],
    ["dirFsync", dirFsync],
  ]) {
    assert.ok(position >= 0, name + " present in driver-runtime source");
  }
  // Mirror of vm-smoke.py write_durable_json: create, write, fsync the file,
  // atomic replace, then fsync the directory entry.
  assert.ok(mkdir < open, "directory created before the temp file");
  assert.ok(open < write, "temp opened before writing");
  assert.ok(write < fileFsync, "write fsynced before the replace");
  assert.ok(fileFsync < replace, "file fsynced before the atomic replace");
  assert.ok(replace < dirFsync, "directory fsynced after the replace");
});

test("writeResult replaces atomically without temp residue", (t) => {
  const dir = makeTempDir(t, "farol-vm-e2e-writer");
  const savedEnv = process.env.VM_E2E_RESULT_DIR;
  const savedCwd = process.cwd();
  delete process.env.VM_E2E_RESULT_DIR;
  try {
    process.chdir(dir);
    assert.equal(resultDirectory(), "results");
    const target = writeResult({ attempt: 1 });
    assert.equal(target, path.join("results", RESULT_FILE));
    assert.deepEqual(fs.readdirSync(path.join(dir, "results")), [RESULT_FILE]);
    const second = writeResult({ attempt: 2 });
    assert.equal(second, target);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "results")),
      [RESULT_FILE],
      "replace leaves no temp residue",
    );
    const resultFile = path.join(dir, "results", RESULT_FILE);
    assert.equal(fs.statSync(resultFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), {
      attempt: 2,
    });
  } finally {
    process.chdir(savedCwd);
    if (savedEnv === undefined) delete process.env.VM_E2E_RESULT_DIR;
    else process.env.VM_E2E_RESULT_DIR = savedEnv;
  }
});

test("VM_E2E_RESULT_DIR overrides the result directory", (t) => {
  const dir = makeTempDir(t, "farol-vm-e2e-override");
  const override = path.join(dir, "custom-results");
  const savedEnv = process.env.VM_E2E_RESULT_DIR;
  process.env.VM_E2E_RESULT_DIR = override;
  try {
    assert.equal(resultDirectory(), override);
    const target = writeResult({ ok: true });
    assert.equal(target, path.join(override, RESULT_FILE));
    assert.deepEqual(fs.readdirSync(override), [RESULT_FILE]);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
  } finally {
    if (savedEnv === undefined) delete process.env.VM_E2E_RESULT_DIR;
    else process.env.VM_E2E_RESULT_DIR = savedEnv;
  }
});

test("bounded inline bundler produces a runnable self-contained bundle", async (t) => {
  const output = makeTempDir(t, "farol-vm-e2e-inline");
  const run = makeTempDir(t, "farol-vm-e2e-inline-run");
  const manifest = bundleDriver({
    entry: ENTRY,
    outputDir: output,
    root: REPO_ROOT,
    bundler: "inline",
  });
  assert.equal(manifest.bundler, "inline");
  assert.equal(manifest.esbuild, undefined);
  const bundleText = fs.readFileSync(path.join(output, BUNDLE_FILE), "utf8");
  assert.ok(bundleText.includes("E2E_BUNDLE_MODULE_MISSING"));
  assert.equal(
    sha256Hex(fs.readFileSync(path.join(output, BUNDLE_FILE))),
    manifest.bundle.sha256,
  );

  const bundleCopy = path.join(run, BUNDLE_FILE);
  fs.copyFileSync(path.join(output, BUNDLE_FILE), bundleCopy);
  const child = runBundle(manifest.node.path, bundleCopy, run);
  assert.equal(child.status, 0, "inline driver exit: " + child.stderr);
  const result = JSON.parse(
    fs.readFileSync(path.join(run, "results", RESULT_FILE), "utf8"),
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.scenario, "vm-e2e-prototype");
});

test("bounded inline bundler refuses unsupported inputs", (t) => {
  const cases = [
    {
      name: "bare import",
      files: {
        "bad-entry.mjs":
          'import shuffle from "left-pad";\nconsole.log(shuffle);\n',
      },
      pattern: /^Error: E2E_BUNDLE_UNRESOLVED_IMPORT: left-pad$/u,
    },
    {
      name: "import outside the entry root",
      files: {
        "bad-entry.mjs":
          'import secret from "../../outside.mjs";\nconsole.log(secret);\n',
      },
      pattern: /^Error: E2E_BUNDLE_IMPORT_OUTSIDE_ROOT/u,
    },
    {
      name: "multi-line import statement",
      files: {
        "bad-entry.mjs":
          'import {\n  writeResult,\n} from "./driver-runtime.mjs";\nconsole.log(writeResult);\n',
      },
      pattern: /^Error: E2E_BUNDLE_UNSUPPORTED_SYNTAX/u,
    },
    {
      name: "import cycle",
      files: {
        "bad-entry.mjs": 'import "./other.mjs";\nconsole.log("entry");\n',
        "other.mjs": 'import "./bad-entry.mjs";\nconsole.log("other");\n',
      },
      pattern: /^Error: E2E_BUNDLE_UNSUPPORTED_CYCLE/u,
    },
  ];
  for (const { name, files, pattern } of cases) {
    const source = makeTempDir(t, "farol-vm-e2e-refuse");
    const output = makeTempDir(t, "farol-vm-e2e-refuseout");
    for (const [fileName, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(source, fileName), contents, { mode: 0o600 });
    }
    assert.throws(
      () =>
        bundleDriver({
          entry: path.join(source, "bad-entry.mjs"),
          outputDir: output,
          root: REPO_ROOT,
          bundler: "inline",
        }),
      pattern,
      name,
    );
    assert.deepEqual(fs.readdirSync(output), [], name + ": no residue");
  }
});
