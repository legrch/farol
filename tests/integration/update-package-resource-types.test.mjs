import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeArchiveFixture } from "../support/native-archive-fixture.mjs";
import { assertPackageResourceManifest } from "../../tooling/verify-package-content.mjs";
import {
  assertResourceManifest,
  EXPECTED_RESOURCE_MANIFEST,
} from "../../tooling/resource-contract.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pythonOracle = path.join(root, "resources/native/update_archive.py");
let native;
let helper;
const deadline = { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" };
let harnessRoot;
let bundledVerifier;

beforeAll(async () => {
  native = await nativeArchiveFixture(root);
  helper = native.executable;
  harnessRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-file-type-harness-"),
  );
  bundledVerifier = path.join(harnessRoot, "verifier.mjs");
  buildSync({
    entryPoints: [
      path.join(
        root,
        "src/modules/release/infra/native/update-package-verifier.ts",
      ),
    ],
    outfile: bundledVerifier,
    bundle: true,
    platform: "node",
    format: "esm",
  });
}, 180_000);
afterAll(async () => {
  await native?.dispose();
  if (harnessRoot) await fs.rm(harnessRoot, { recursive: true, force: true });
});

async function disposable(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-file-type-case-"),
  );
  const stage = path.join(directory, "stage");
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    await run({ directory, stage });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function assertExited(result) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}

const helperProbe = `
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [modulePath, helperPath, stage, replacement] = process.argv.slice(1);
const { createUpdatePackageVerifier } = await import(pathToFileURL(modulePath).href);
const originalOpen = fs.open.bind(fs);
fs.open = async (file, flags, ...rest) => {
  if (file === helperPath && ["fifo", "regular"].includes(replacement)) {
    fs.open = originalOpen;
    await fs.rename(file, file + ".previous");
    if (replacement === "fifo") execFileSync("/usr/bin/mkfifo", [file]);
    else await fs.copyFile(file + ".previous", file);
  }
  const descriptor = await originalOpen(file, flags, ...rest);
  if (file === helperPath && replacement === "growth") {
    const originalRead = descriptor.read.bind(descriptor);
    const expectedSize = (await descriptor.stat()).size;
    descriptor.read = async (...args) => {
      if (args[2] > expectedSize + 1) {
        process.exitCode = 2;
        throw new Error("UNBOUNDED_READ");
      }
      await fs.appendFile(helperPath, Buffer.alloc(300000));
      return originalRead(...args);
    };
  }
  return descriptor;
};
let lookups = 0;
const verifier = createUpdatePackageVerifier({
  stagingParent: stage, extractorPath: helperPath, verifierPath: "/unused",
  archivePathForHandle: async () => { lookups += 1; throw new Error("UNEXPECTED_LOOKUP"); },
});
try { await verifier.verifyPackage("opaque", {}); throw new Error("UNEXPECTED_SUCCESS"); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? null, lookups })); }
`;

describe("helper resource type and descriptor binding", () => {
  it("classifies failed extraction cleanup as unknown and preserves the remaining stage", async () => {
    await disposable(async ({ directory, stage }) => {
      const archive = path.join(directory, "invalid.zip");
      await fs.writeFile(archive, "not a ZIP");
      const probe = `
// Simulate bounded cold process startup before any native extraction effect.
await new Promise((resolve) => setTimeout(resolve, 2200));
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [modulePath, helperPath, stage, archive] = process.argv.slice(1);
const { createUpdatePackageVerifier } = await import(pathToFileURL(modulePath).href);
const originalRemove = fs.rm;
const physicalStage = await fs.realpath(stage);
fs.rm = async (file, options) => {
  if (String(file).startsWith(physicalStage + "/farol-update-verify-")) throw Object.assign(new Error("fixture cleanup failure"), { code: "EPERM" });
  return originalRemove(file, options);
};
const verifier = createUpdatePackageVerifier({ stagingParent: stage, extractorPath: helperPath, verifierPath: "/unused", archivePathForHandle: async () => archive });
try { await verifier.verifyPackage("opaque", {}); throw new Error("UNEXPECTED_SUCCESS"); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? null, stages: (await fs.readdir(stage)).length })); }
`;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          probe,
          bundledVerifier,
          helper,
          stage,
          archive,
        ],
        // This finite extraction scenario includes cold Node/native startup;
        // the separate FIFO/nonblocking admission cases retain their 2 s cap.
        { ...deadline, timeout: 10_000 },
      );
      assertExited(result);
      expect(JSON.parse(result.stdout)).toEqual({
        code: "cleanup_unknown",
        stages: 1,
      });
    });
  });
  it("rejects a FIFO without a writer before the subprocess deadline", async () => {
    await disposable(async ({ directory, stage }) => {
      const fifo = path.join(directory, "helper.py");
      const made = spawnSync("/usr/bin/mkfifo", [fifo], deadline);
      assertExited(made);
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          helperProbe,
          bundledVerifier,
          fifo,
          stage,
          "",
        ],
        deadline,
      );
      assertExited(result);
      expect(JSON.parse(result.stdout)).toEqual({
        code: "invalid_stage",
        lookups: 0,
      });
      expect(await fs.readdir(stage)).toEqual([]);
    });
  });
  for (const replacement of ["fifo", "regular", "growth"]) {
    it(
      replacement === "growth"
        ? "bounds helper reads when the file grows"
        : `rejects a ${replacement} replacement between lstat and open`,
      async () => {
        await disposable(async ({ directory, stage }) => {
          const copy = path.join(directory, "helper.py");
          await fs.copyFile(helper, copy);
          const result = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              helperProbe,
              bundledVerifier,
              copy,
              stage,
              replacement,
            ],
            deadline,
          );
          assertExited(result);
          expect(JSON.parse(result.stdout)).toEqual({
            code: "invalid_stage",
            lookups: 0,
          });
          expect(await fs.readdir(stage)).toEqual([]);
        });
      },
    );
  }
});

// The real extractor accepts an ordinary ZIP. The faults below replace or
// change its artifact only after extraction, inside an owned disposable stage.
// A fixture verifier records dispatch; it does not attest a real application.
const artifactProbe = `
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [modulePath, helperPath, stage, archive, verifierPath, manifestJson, scenario] = process.argv.slice(1);
if (scenario === "delayed-bootstrap") await new Promise(resolve => setTimeout(resolve, 2500));
const { createUpdatePackageVerifier } = await import(pathToFileURL(modulePath).href);
const originalOpen = fs.open.bind(fs);
const originalLstat = fs.lstat.bind(fs);
let resourceStarted = false;
let resourceActive = false;
let resourceStartedAt;
let resourceDeadline;
const resourceExpired = () => {
  process.stderr.write("ARTIFACT_READ_DEADLINE\\n");
  process.exit(70);
};
const finishResourceRead = () => {
  if (!resourceActive) return;
  resourceActive = false;
  clearTimeout(resourceDeadline);
  // A synchronous stall can delay the timer callback. Check monotonic elapsed
  // time before allowing completion to cancel that callback.
  if (performance.now() - resourceStartedAt >= 2000) resourceExpired();
};
// This two-second oracle covers the resource operation itself. Node/module
// startup and the already-awaited native extraction have a separate outer bound.
fs.lstat = async (file, ...rest) => {
  if (path.basename(String(file)) === "artifact.json" && !resourceStarted) {
    resourceStarted = true;
    resourceActive = true;
    resourceStartedAt = performance.now();
    resourceDeadline = setTimeout(resourceExpired, 2000);
  }
  return originalLstat(file, ...rest);
};
let unboundedReads = 0;
let maximumReadLength = 0;
let checkedSize = 0;
fs.open = async (file, flags, ...rest) => {
  if (path.basename(String(file)) !== "artifact.json") return originalOpen(file, flags, ...rest);
  if (scenario === "stalled-read") await new Promise(resolve => setTimeout(resolve, 2500));
  if (["fifo", "regular", "symlink", "directory"].includes(scenario)) {
    await fs.rename(file, file + ".previous");
    if (scenario === "fifo") execFileSync("/usr/bin/mkfifo", [file]);
    if (scenario === "regular") await fs.copyFile(file + ".previous", file);
    if (scenario === "symlink") await fs.symlink(file + ".previous", file);
    if (scenario === "directory") await fs.mkdir(file);
  }
  const descriptor = await originalOpen(file, flags, ...rest);
  checkedSize = Number((await descriptor.stat()).size);
  const originalClose = descriptor.close.bind(descriptor);
  descriptor.close = async (...args) => {
    try {
      const result = await originalClose(...args);
      if (scenario === "stalled-sync-close") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
      return result;
    } finally { finishResourceRead(); }
  };
  const originalRead = descriptor.read.bind(descriptor);
  const originalReadFile = descriptor.readFile.bind(descriptor);
  let changed = false;
  const change = async () => {
    if (changed) return;
    changed = true;
    if (scenario === "growth") await fs.appendFile(file, Buffer.alloc(300000));
    if (scenario === "metadata") await fs.chmod(file, 0o400);
    if (scenario === "read-replacement") {
      await fs.rename(file, file + ".previous");
      await fs.copyFile(file + ".previous", file);
    }
  };
  descriptor.read = async (...args) => {
    maximumReadLength = Math.max(maximumReadLength, args[2]);
    await change();
    return originalRead(...args);
  };
  descriptor.readFile = async (...args) => {
    unboundedReads += 1;
    await change();
    return originalReadFile(...args);
  };
  return descriptor;
};
const verifier = createUpdatePackageVerifier({
  stagingParent: stage, extractorPath: helperPath, verifierPath,
  archivePathForHandle: async () => archive,
});
let code = null;
let accepted = false;
try { await verifier.verifyPackage("opaque", JSON.parse(manifestJson)); accepted = true; await verifier.discard("opaque"); }
catch (error) { code = error.code ?? null; }
finishResourceRead();
let measured = false;
try { await fs.stat(verifierPath + ".called"); measured = true; } catch {}
process.stdout.write(JSON.stringify({ code, accepted, measured, unboundedReads, maximumReadLength, checkedSize, stages: (await fs.readdir(stage)).length }));
`;

describe("extracted artifact descriptor and bounded read", () => {
  for (const scenario of [
    "ordinary",
    "legacy-layout",
    "fifo",
    "regular",
    "symlink",
    "directory",
    "growth",
    "metadata",
    "read-replacement",
    "delayed-bootstrap",
    "stalled-read",
    "stalled-sync-close",
  ]) {
    it(`handles ${scenario} without an unbounded read or premature measurement`, async () => {
      await disposable(async ({ directory, stage }) => {
        const archive = path.join(directory, "archive.zip");
        const manifest = {
          product: "Farol",
          bundleId: "io.github.legrch.farol",
          version: "0.1.0-owner.beta.1",
          buildVersion: "2",
          channel: "owner-beta",
          sourceCommit: "a".repeat(40),
          sourceTreeDigest: "b".repeat(64),
          buildId: "c".repeat(64),
          artifactSha256: "d".repeat(64),
          signing: "unsigned",
          notarized: false,
        };
        const artifact = {
          schema: scenario === "legacy-layout" ? 5 : 6,
          ...manifest,
          sourceDirty: false,
          updateChannel: "github-owner-beta",
          signing: { kind: "unsigned" },
        };
        const made = spawnSync(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in [("artifact.json", sys.argv[2]), (sys.argv[3] + "/Contents/Info.plist", "fixture")]:
        info = zipfile.ZipInfo(name)
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(info, data)
`,
            archive,
            JSON.stringify(artifact),
            scenario === "legacy-layout"
              ? "Farol Next Preview.app"
              : "Farol.app",
          ],
          deadline,
        );
        assertExited(made);
        const bytes = await fs.readFile(archive);
        const expected = {
          ...manifest,
          archiveSize: bytes.length,
          archiveSha256: createHash("sha256").update(bytes).digest("hex"),
        };
        const verifierPath = path.join(directory, "measure.mjs");
        const identity = { ...manifest, updateChannel: "github-owner-beta" };
        await fs.writeFile(
          verifierPath,
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(verifierPath + ".called")}, "called"); process.stdout.write(${JSON.stringify(JSON.stringify(identity))});`,
        );
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            artifactProbe,
            bundledVerifier,
            helper,
            stage,
            archive,
            verifierPath,
            JSON.stringify(expected),
            scenario,
          ],
          // Bound preparation separately; the in-probe resource oracle stays 2s.
          { ...deadline, timeout: 10_000 },
        );
        if (["stalled-read", "stalled-sync-close"].includes(scenario)) {
          expect(result.error, result.stderr).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr).toBe(70);
          expect(result.stderr).toBe("ARTIFACT_READ_DEADLINE\n");
          await expect(fs.stat(verifierPath + ".called")).rejects.toMatchObject(
            { code: "ENOENT" },
          );
          expect(await fs.readdir(stage)).toHaveLength(1);
          return;
        }
        assertExited(result);
        const outcome = JSON.parse(result.stdout);
        const ordinary = ["ordinary", "delayed-bootstrap"].includes(scenario);
        expect(outcome).toMatchObject({
          code: ordinary ? null : "package_mismatch",
          accepted: ordinary,
          measured: ordinary,
          unboundedReads: 0,
          stages: 0,
        });
        expect(outcome.maximumReadLength).toBeLessThanOrEqual(
          outcome.checkedSize + 1,
        );
        expect(await fs.readdir(stage)).toEqual([]);
      });
    });
  }
});

const archiveProbe = `
import importlib.util, os, shutil, sys
helper_path, archive_path, stage, scenario = sys.argv[1:]
spec = importlib.util.spec_from_file_location("archive_helper", helper_path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
expected_size = 1 if scenario == "fifo" else os.lstat(archive_path).st_size
expected_sha = "a" * 64
real_open = os.open
def replacing_open(file, flags, *args, **kwargs):
    if str(file) == archive_path and scenario.startswith("replace"):
        os.rename(archive_path, archive_path + ".previous")
        if scenario == "replace-fifo":
            os.mkfifo(archive_path)
        else:
            shutil.copyfile(archive_path + ".previous", archive_path)
        helper.os.open = real_open
    return real_open(file, flags, *args, **kwargs)
helper.os.open = replacing_open
real_read = os.read
def growing_read(fd, count):
    helper.os.read = real_read
    if count > expected_size + 1:
        raise AssertionError("UNBOUNDED_READ")
    with open(archive_path, "ab") as stream:
        stream.write(b"growth")
    return real_read(fd, count)
if scenario == "growth":
    helper.os.read = growing_read
if scenario == "metadata":
    def changed_metadata(fd, count):
        chunk = real_read(fd, count)
        if not chunk:
            os.chmod(archive_path, 0o600)
        return chunk
    helper.os.read = changed_metadata
sys.argv = [helper_path, archive_path, stage, str(expected_size), expected_sha]
try:
    helper.main()
except helper.Refusal as error:
    print(error)
else:
    raise AssertionError("UNEXPECTED_SUCCESS")
`;

describe("Python reference archive resource type and bounded hashing", () => {
  for (const scenario of [
    "fifo",
    "replace-fifo",
    "replace-regular",
    "growth",
    "metadata",
  ]) {
    it(`rejects ${scenario} before the subprocess deadline without extraction`, async () => {
      await disposable(async ({ directory, stage }) => {
        const archive = path.join(directory, "archive.zip");
        if (scenario === "fifo") {
          assertExited(spawnSync("/usr/bin/mkfifo", [archive], deadline));
        } else {
          await fs.writeFile(archive, "ordinary archive bytes");
          await fs.chmod(archive, 0o644);
        }
        const result = spawnSync(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            archiveProbe,
            pythonOracle,
            archive,
            stage,
            scenario,
          ],
          deadline,
        );
        assertExited(result);
        expect(result.stdout.trim()).toBe(
          scenario === "fifo"
            ? "ARCHIVE_TYPE_INVALID"
            : scenario === "growth"
              ? "ARCHIVE_SIZE_MISMATCH"
              : "ARCHIVE_CHANGED",
        );
        expect(await fs.readdir(stage)).toEqual([]);
      });
    });
  }
});

describe("resource manifest package identity", () => {
  const artifact = {
    version: "0.1.0-preview.0",
    updateChannel: "local-preview-only",
  };
  it("accepts the resource identity only when both artifact and expected identity match", () => {
    expect(() =>
      assertPackageResourceManifest(
        EXPECTED_RESOURCE_MANIFEST,
        artifact,
        artifact.version,
        artifact.updateChannel,
      ),
    ).not.toThrow();
  });
  for (const [
    label,
    actualArtifact,
    expectedVersion,
    expectedChannel,
    code,
  ] of [
    [
      "artifact version",
      { ...artifact, version: "0.1.0-preview.1" },
      artifact.version,
      artifact.updateChannel,
      "PACKAGE_RESOURCE_VERSION_MISMATCH",
    ],
    [
      "expected version",
      artifact,
      "0.1.0-preview.1",
      artifact.updateChannel,
      "PACKAGE_RESOURCE_VERSION_MISMATCH",
    ],
    [
      "artifact channel",
      { ...artifact, updateChannel: "github-owner-beta" },
      artifact.version,
      artifact.updateChannel,
      "PACKAGE_RESOURCE_CHANNEL_MISMATCH",
    ],
    [
      "expected channel",
      artifact,
      artifact.version,
      "github-owner-beta",
      "PACKAGE_RESOURCE_CHANNEL_MISMATCH",
    ],
  ]) {
    it(`rejects mismatched ${label} even when the resource schema is accepted`, () => {
      expect(() =>
        assertResourceManifest(EXPECTED_RESOURCE_MANIFEST),
      ).not.toThrow();
      expect(() =>
        assertPackageResourceManifest(
          EXPECTED_RESOURCE_MANIFEST,
          actualArtifact,
          expectedVersion,
          expectedChannel,
        ),
      ).toThrow(code);
    });
  }
});
