// Synthetic output-admission fixtures. These tests never build or launch apps.
import test from "node:test";
import { createHash } from "node:crypto";
import { treeDigest } from "../artifact-digest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveVMDev,
  requireVMDevOutput,
  assembleVMDev,
  vmDevInfoPlist,
  VM_DEV_APP,
  VM_DEV_ARCHIVE,
  VM_DEV_IDENTITY,
} from "../vm-dev-artifact.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-vm-dev-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "_output/vm-dev/run-1");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  return { root, output };
}

test("preflight refuses absent build before producing any app bytes", async (t) => {
  const { root, output } = await fixture(t);
  await assert.rejects(assembleVMDev(root, output), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(output), []);
});
test("existing output is never adopted or overwritten", async (t) => {
  const { root, output } = await fixture(t);
  await fs.writeFile(path.join(output, "keep"), "prior evidence");
  await assert.rejects(assembleVMDev(root, output), /VM_DEV_OUTPUT_NOT_EMPTY/);
  assert.equal(
    await fs.readFile(path.join(output, "keep"), "utf8"),
    "prior evidence",
  );
});
test("physical containment excludes caller aliases and unrelated paths", async (t) => {
  const { root, output } = await fixture(t);
  const link = path.join(root, "_output/vm-dev/alias");
  await fs.symlink(output, link);
  await assert.rejects(requireVMDevOutput(root, link), /VM_DEV_OUTPUT_UNSAFE/);
  await assert.rejects(requireVMDevOutput(root, root), /VM_DEV_OUTPUT_UNSAFE/);
  await assert.rejects(
    requireVMDevOutput(root, output + "/../run-1"),
    /VM_DEV_OUTPUT_UNSAFE/,
  );
});
test("guest presentation is Dev and rejects XML/version injection", () => {
  const plist = vmDevInfoPlist("0.5.23", "14.0");
  assert.match(plist, /<string>local\.farol\.dev<\/string>/);
  assert.ok(plist.includes(`<string>${VM_DEV_IDENTITY.product}</string>`));
  assert.doesNotMatch(plist, /io\.github\.legrch\.farol/);
  assert.throws(
    () => vmDevInfoPlist("0.5.23</string>", "14.0"),
    /VM_DEV_IDENTITY_INVALID/,
  );
  assert.throws(
    () => vmDevInfoPlist("0.5.23", "14.0<key>"),
    /VM_DEV_IDENTITY_INVALID/,
  );
});
test("fixed launcher selects Dev before storage and forwards no input", async () => {
  const launcher = await fs.readFile(
    fileURLToPath(new URL("../vm-dev-launcher.sh", import.meta.url)),
    "utf8",
  );
  assert.ok(
    launcher.indexOf("export FAROL_ENVIRONMENT=dev") <
      launcher.indexOf("exec "),
  );
  assert.match(
    launcher,
    /unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE FAROL_PROFILE_MODE/,
  );
  assert.match(launcher, /unset FAROL_ACCEPTANCE_PROFILE FAROL_E2E /);
  assert.match(
    launcher,
    /exec "\$contents_dir\/Resources\/app\/farol-backend" run-desktop-launcher\n$/,
  );
  assert.doesNotMatch(launcher, /\$@|\$\*|source |eval |\/Users\//);
});

test("archive requires an independently selected receipt before output writes", async (t) => {
  const { root, output } = await fixture(t);
  await fs.writeFile(path.join(output, "vm-dev-artifact.json"), "{}");
  await assert.rejects(
    archiveVMDev(root, output, "a".repeat(64)),
    /VM_DEV_RECEIPT_CHANGED/,
  );
  assert.deepEqual(await fs.readdir(output), ["vm-dev-artifact.json"]);
});

test("app tamper after receipt refuses before archiver or ZIP publication", async (t) => {
  const { root, output } = await fixture(t);
  const app = path.join(output, VM_DEV_APP);
  await fs.mkdir(app);
  const item = path.join(app, "synthetic");
  await fs.writeFile(item, "accepted");
  const receipt = {
    schema: "farol.vm-dev-artifact/1",
    kind: "local-dev-derivative",
    appName: VM_DEV_APP,
    bundleId: VM_DEV_IDENTITY.bundleId,
    environment: "dev",
    artifactPath: app,
    artifactSha256: await treeDigest(app),
    launcherSHA256: "b".repeat(64),
    officialRelease: false,
    hostLaunch: false,
    profileImport: false,
  };
  const raw = JSON.stringify(receipt);
  const accepted = createHash("sha256").update(raw).digest("hex");
  await fs.writeFile(path.join(output, "vm-dev-artifact.json"), raw);
  await fs.writeFile(item, "tampered");
  await assert.rejects(
    archiveVMDev(root, output, accepted),
    /VM_DEV_ARTIFACT_CHANGED/,
  );
  await assert.rejects(fs.lstat(path.join(output, VM_DEV_ARCHIVE)), {
    code: "ENOENT",
  });
});
