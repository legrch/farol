import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseGithubReleaseManifest } from "../../src/modules/release/app/github-release";
import {
  ELECTRON_RUNTIME,
  runtimeClosure,
} from "../../tooling/runtime-contract.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const producer = path.join(repository, "tooling/prepare-release-archive.py");
const owned = [];
const version = "0.2.0-owner.beta.6";
const appName = "Farol.app";

function run(command, args, cwd, timeout = 15_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/var/empty",
      TMPDIR: os.tmpdir(),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function git(root, ...args) {
  const result = run("/usr/bin/git", args, root);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function temporaryRoot() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-release-test-")),
  );
  owned.push(root);
  return root;
}

// The app, Electron and extractor below are synthetic, offline substitutes.
// Real source/candidate/layout contracts are copied unchanged. The fake Mach-O
// header tests byte binding only; it is not a Go build or native app evidence.
const extractorFixture = `#!/usr/bin/python3
import hashlib, json, os, pathlib, stat, sys, zipfile
assert len(sys.argv) == 5  # Direct executable invocation, four data arguments.
archive, stage, size, digest = sys.argv[1:]
b = pathlib.Path(archive).read_bytes()
assert len(b) == int(size) and hashlib.sha256(b).hexdigest() == digest
with zipfile.ZipFile(archive) as z:
    assert "artifact.json" in z.namelist() and "Farol.app/" in z.namelist()
    for member in z.infolist():
        target = pathlib.Path(stage, member.filename)
        mode = member.external_attr >> 16
        if stat.S_ISDIR(mode):
            target.mkdir(parents=True, exist_ok=True)
        elif stat.S_ISLNK(mode):
            target.symlink_to(z.read(member).decode())
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(member))
        if not stat.S_ISLNK(mode):
            target.chmod(stat.S_IMODE(mode))
print(json.dumps({"appPath": str(pathlib.Path(stage, "Farol.app")), "artifactPath": str(pathlib.Path(stage, "artifact.json"))}))
`;

async function fixture({
  rejected = false,
  sourceRejected = false,
  mismatch = null,
  mutateSource = false,
  mutatePackage = false,
  restoreFault = null,
} = {}) {
  const root = await temporaryRoot();
  const tooling = path.join(root, "tooling");
  await fs.mkdir(tooling);
  await fs.copyFile(producer, path.join(tooling, "prepare-release-archive.py"));
  for (const name of [
    "source-identity.mjs",
    "candidate-contract.mjs",
    "package-layout.mjs",
  ])
    await fs.copyFile(
      path.join(repository, "tooling", name),
      path.join(tooling, name),
    );
  // Wrap the unchanged source implementation only to count gate invocations.
  await fs.rename(
    path.join(tooling, "source-identity.mjs"),
    path.join(tooling, "source-identity-real.mjs"),
  );
  await fs.writeFile(
    path.join(tooling, "source-identity.mjs"),
    `
import fs from 'node:fs';
import path from 'node:path';
import { sourceIdentity as real } from './source-identity-real.mjs';
export function sourceIdentity(root, scope) {
  const result = real(root, scope);
  fs.appendFileSync(path.join(root, '_output/source-calls'), scope + '\\n');
  return result;
}
`,
  );
  const restoredChange =
    restoreFault === "artifact"
      ? 'p = pathlib.Path(stage, "artifact.json"); a = json.loads(p.read_bytes()); a["artifactPath"] = "Farol Next Preview.app"; p.write_text(json.dumps(a))\n'
      : restoreFault === "core"
        ? 'p = pathlib.Path(stage, "Farol.app/Contents/Resources/app/farol-backend"); p.chmod(0o700); p.write_bytes(bytes(64))\n'
        : restoreFault === "path"
          ? 'stage = str(pathlib.Path(stage, "crossed"))\n'
          : "";
  const extractor = extractorFixture.replace(
    "print(json.dumps",
    restoredChange + "print(json.dumps",
  );
  await fs.writeFile(
    path.join(tooling, "native-archive-build.mjs"),
    `
export const NATIVE_ARCHIVE_SHA256 = '${createHash("sha256").update(extractor).digest("hex")}';
export const NATIVE_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
`,
  );
  await fs.writeFile(
    path.join(tooling, "verify-package.mjs"),
    sourceRejected
      ? "throw new Error('fixture source refusal');\n"
      : 'process.stdout.write("fixture verified\\n");\n',
  );
  await fs.writeFile(path.join(root, ".gitignore"), "_output/\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const head = git(root, "rev-parse", "HEAD");
  const tree = run(
    "/usr/bin/git",
    ["ls-tree", "-r", "-z", "--full-tree", head, "--", "."],
    root,
  ).stdout;
  const sourceTreeDigest = createHash("sha256")
    .update(Buffer.from("git-ls-tree-v1\0"))
    .update(tree)
    .digest("hex");
  const app = path.join(root, "_output/package", appName);
  const resource = path.join(app, "Contents/Resources/app");
  const executable = path.join(
    app,
    "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
  );
  await fs.mkdir(resource, { recursive: true });
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(path.join(resource, "payload"), "fixture bytes");
  await fs.chmod(path.join(resource, "payload"), 0o755);
  await fs.writeFile(path.join(resource, "update-archive.py"), extractor, {
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(resource, "update-package.mjs"),
    "fixture entry",
  );
  await fs.writeFile(
    executable,
    rejected
      ? "#!/usr/bin/python3\nimport sys\nsys.exit(7)\n"
      : `#!/usr/bin/python3
import json, os, pathlib, sys
assert os.environ["ELECTRON_RUN_AS_NODE"] == "1" and os.environ["ELECTRON_NO_ASAR"] == "1"
a = json.load(open(sys.argv[2]))
actual = {k: a[k] for k in ["product", "bundleId", "version", "buildVersion", "sourceCommit", "sourceTreeDigest", "buildId", "artifactSha256"]} | {"updateChannel": a["updateChannel"], "signing": a["signing"]["kind"], "notarized": a["notarized"]}
${mismatch ? `actual[${JSON.stringify(mismatch)}] = "crossed physical identity"` : ""}
${mutateSource ? 'pathlib.Path(sys.argv[1]).parents[6].joinpath(".gitignore").write_text("_output/\\n# changed during verification\\n")' : ""}
${mutatePackage ? 'pathlib.Path(sys.argv[1]).parent.joinpath("payload").write_text("changed during verification")' : ""}
print(json.dumps(actual))
`,
  );
  await fs.chmod(executable, 0o755);
  const artifact = {
    schema: 7,
    treeDigestVersion: "farol.next.tree-digest/v2",
    product: "Farol Next Preview",
    version,
    buildVersion: "20",
    bundleId: "local.farol.next.preview",
    buildId: "a".repeat(64),
    builtAt: "2026-10-10T00:00:00.000Z",
    sourceCommit: head,
    sourceTreeDigest,
    sourceDirty: false,
    artifactPath: app,
    artifactSha256: "b".repeat(64),
    electronSourceSha256: ELECTRON_RUNTIME.extractedTreeDigest,
    runtime: runtimeClosure(
      ELECTRON_RUNTIME,
      "Contents/Frameworks/Electron Runtime.app",
    ),
    signing: {
      kind: "unsigned",
      reason: "owner-beta-distribution",
      runtimeBytes: "unmodified-vendor-bundle",
    },
    notarized: false,
    updateChannel: "github-owner-beta",
  };
  const artifactFile = path.join(root, "_output/package/artifact.json");
  await fs.writeFile(artifactFile, JSON.stringify(artifact));
  const native = Buffer.alloc(64);
  native.writeUInt32LE(0xfeedfacf, 0);
  native.writeUInt32LE(0x0100000c, 4);
  native.writeUInt32LE(2, 12);
  await fs.writeFile(path.join(resource, "farol-backend"), native, {
    mode: 0o500,
  });
  const core = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: artifact.buildId,
      sourceSHA: head,
      sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: {
      path: "farol-backend",
      size: native.length,
      sha256: createHash("sha256").update(native).digest("hex"),
    },
  };
  const embedded = {
    schema: 4,
    sourceMode: "head-exact",
    inputExact: true,
    dirty: false,
    core,
    ...Object.fromEntries(
      [
        "buildId",
        "sourceCommit",
        "sourceTreeDigest",
        "product",
        "bundleId",
        "version",
      ].map((key) => [key, artifact[key]]),
    ),
    entries: ["core-artifact.json", "farol-backend"],
    entrySha256: {
      "farol-backend": core.binary.sha256,
      "core-artifact.json": createHash("sha256")
        .update(JSON.stringify(core))
        .digest("hex"),
    },
  };
  await fs.writeFile(
    path.join(resource, "core-artifact.json"),
    JSON.stringify(core),
  );
  await fs.writeFile(
    path.join(resource, "build-manifest.json"),
    JSON.stringify(embedded),
  );
  const output = path.join(root, "_output", "release");
  return {
    root,
    app,
    resource,
    head,
    artifact,
    artifactFile,
    output,
    core,
    embedded,
  };
}

function prepare(f, output = f.output, head = f.head) {
  return run(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      path.join(f.root, "tooling/prepare-release-archive.py"),
      head,
      output,
    ],
    f.root,
  );
}

afterEach(async () => {
  for (const root of owned.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("release archive CLI fixture contract", () => {
  // The fixture fakes the trusted extractor and verifier. It checks CLI
  // orchestration only; a real accepted package needs the bundled native tools.
  it("binds a clean source, sanitizes public artifact, and emits exactly three public assets", async () => {
    const f = await fixture();
    await fs.symlink("payload", path.join(f.resource, "payload-link"));
    const result = prepare(f);
    expect(result.status, result.stderr).toBe(0);
    const names = (await fs.readdir(f.output)).sort();
    const archiveName = `Farol-${version}-darwin-arm64.zip`;
    expect(names).toEqual([
      archiveName,
      "SHA256SUMS",
      "farol-release.json",
      "private",
    ]);
    const manifest = JSON.parse(
      await fs.readFile(path.join(f.output, "farol-release.json")),
    );
    expect(manifest.archiveName).toBe(archiveName);
    expect(manifest.sourceCommit).toBe(f.head);
    expect(manifest.repository).toBe("legrch/farol");
    expect(parseGithubReleaseManifest(manifest)).toEqual({
      ok: true,
      value: manifest,
    });
    expect(
      parseGithubReleaseManifest({
        ...manifest,
        repository: "legrch/farol-releases",
      }).ok,
    ).toBe(false);
    const archive = await fs.readFile(path.join(f.output, archiveName));
    expect(manifest.archiveSize).toBe(archive.length);
    expect(manifest.archiveSha256).toBe(
      createHash("sha256").update(archive).digest("hex"),
    );
    expect(
      await fs.readFile(path.join(f.root, "_output/source-calls"), "utf8"),
    ).toBe(".\n.\n");
    expect(await fs.readFile(path.join(f.output, "SHA256SUMS"), "utf8")).toBe(
      `${manifest.archiveSha256}  ${archiveName}\n`,
    );
    const inspected = run(
      "/usr/bin/python3",
      [
        "-c",
        `import json,sys,zipfile,stat
z=zipfile.ZipFile(sys.argv[1])
a=json.loads(z.read("artifact.json"))
l=z.getinfo("Farol.app/Contents/Resources/app/payload-link")
f=z.getinfo("Farol.app/Contents/Resources/app/payload")
assert a["artifactPath"] == "Farol.app"
assert a["schema"] == 7
assert stat.S_ISLNK(l.external_attr >> 16) and z.read(l) == b"payload"
assert (f.external_attr >> 16) & 0o111
print(json.dumps(sorted({n.split("/")[0] for n in z.namelist()})))
`,
        path.join(f.output, archiveName),
      ],
      f.root,
    );
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual([appName, "artifact.json"]);
    expect(
      await fs.readFile(
        path.join(f.output, "private/artifact.local.json"),
        "utf8",
      ),
    ).toContain(f.app);
    for (const name of [archiveName, "farol-release.json", "SHA256SUMS"])
      expect(
        (await fs.readFile(path.join(f.output, name))).includes(
          Buffer.from(f.root),
        ),
      ).toBe(false);
    expect((await fs.stat(path.join(f.output, "private"))).mode & 0o777).toBe(
      0o700,
    );
    // Identical fixture bytes retain their public ZIP identity across fresh
    // processes, independent of Python's randomized set iteration order.
    const second = `${f.output}-again`;
    expect(git(f.root, "status", "--porcelain")).toBe("");
    const secondResult = prepare(f, second);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    expect(await fs.readFile(path.join(second, archiveName))).toEqual(archive);
  });

  it("refuses stale, dirty, and existing destinations", async () => {
    const f = await fixture();
    expect(prepare(f, f.output, "0".repeat(40)).stderr).toContain(
      "HEAD_MISMATCH",
    );
    await fs.writeFile(path.join(f.root, "dirty"), "dirty");
    expect(prepare(f).stderr).toContain("SOURCE_DIRTY");
    await fs.rm(path.join(f.root, "dirty"));
    await fs.mkdir(f.output);
    expect(prepare(f).stderr).toContain("OUTPUT_EXISTS");
  });

  it("refuses stale artifact identity and private fields", async () => {
    const f = await fixture();
    f.artifact.sourceTreeDigest = "d".repeat(64);
    await fs.writeFile(f.artifactFile, JSON.stringify(f.artifact));
    expect(prepare(f).stderr).toContain("CANDIDATE_SOURCE_MISMATCH");
    f.artifact.sourceTreeDigest = "e".repeat(64);
    f.artifact.runtime = { path: "/Users/owner/private" };
    await fs.writeFile(f.artifactFile, JSON.stringify(f.artifact));
    expect(prepare(f).stderr).toContain("PRIVATE_PATH_IN_ARTIFACT");
  });

  it("refuses unsafe symlinks and special entries", async () => {
    const f = await fixture();
    const link = path.join(f.resource, "escape");
    await fs.symlink("/tmp", link);
    expect(prepare(f).stderr).toContain("APP_LINK_INVALID");
    await fs.rm(link);
    const fifo = path.join(f.resource, "fifo");
    const made = run("/usr/bin/mkfifo", [fifo], f.root);
    expect(made.status, made.stderr).toBe(0);
    expect(prepare(f).stderr).toContain("APP_SPECIAL_ENTRY");
  });

  it("refuses a package rejected by its verifier", async () => {
    const f = await fixture({ rejected: true });
    const result = prepare(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("VERIFICATION_REJECTED");
    expect(await fs.readdir(f.output)).toEqual(
      expect.arrayContaining(["private"]),
    );
    expect(await fs.readdir(f.output)).not.toContain("farol-release.json");
    expect(await fs.readdir(f.output)).toEqual(["private"]);
  });

  it("requires the source package verifier before executing packaged helpers", async () => {
    const f = await fixture({ sourceRejected: true });
    expect(prepare(f).stderr).toContain("SOURCE_PACKAGE_REJECTED");
    await expect(fs.stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exempts vendor compiler-path bytes only behind the source verifier gate", async () => {
    // The fixture source verifier supplies orchestration success/refusal only;
    // actual unmodified vendor provenance remains the production verifier's job.
    for (const sourceRejected of [false, true]) {
      const f = await fixture({ sourceRejected });
      const vendor = path.join(
        f.app,
        "Contents/Frameworks/Electron Runtime.app/vendor-fixture",
      );
      await fs.writeFile(vendor, "/Users/public-compiler/electron/src/build");
      const result = prepare(f);
      if (sourceRejected)
        expect(result.stderr).toContain("SOURCE_PACKAGE_REJECTED");
      else expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each([5, 6, 8, true])(
    "refuses schema %s rather than weakening current Go proof",
    async (schema) => {
      const f = await fixture();
      await fs.writeFile(
        f.artifactFile,
        JSON.stringify({ ...f.artifact, schema }),
      );
      expect(prepare(f).stderr).toContain("ARTIFACT_SCHEMA_INVALID");
    },
  );

  it.each(["Farol Next Preview.app", "../Farol.app", "Farol.app"])(
    "refuses noncanonical artifact path %s",
    async (claimed) => {
      const f = await fixture();
      f.artifact.artifactPath = claimed;
      await fs.writeFile(f.artifactFile, JSON.stringify(f.artifact));
      expect(prepare(f).stderr).toContain("ARTIFACT_PATH_INVALID");
    },
  );

  it.each([
    "product",
    "bundleId",
    "version",
    "buildVersion",
    "sourceCommit",
    "sourceTreeDigest",
    "buildId",
    "artifactSha256",
    "updateChannel",
    "signing",
    "notarized",
  ])(
    "refuses a physically verified %s different from the candidate",
    async (mismatch) => {
      const f = await fixture({ mismatch });
      expect(prepare(f).stderr).toContain(
        mismatch === "updateChannel" ||
          mismatch === "signing" ||
          mismatch === "notarized"
          ? "PHYSICAL_RELEASE_IDENTITY_MISMATCH"
          : "PHYSICAL_IDENTITY_MISMATCH",
      );
      expect(await fs.readdir(f.output)).toEqual(["private"]);
    },
  );

  it.each(["missing", "schema", "architecture", "source", "hash", "bytes"])(
    "refuses %s embedded Go core evidence",
    async (fault) => {
      const f = await fixture();
      if (fault === "missing")
        await fs.rm(path.join(f.resource, "core-artifact.json"));
      if (fault === "schema") {
        f.embedded.schema = 3;
        await fs.writeFile(
          path.join(f.resource, "build-manifest.json"),
          JSON.stringify(f.embedded),
        );
      }
      if (fault === "architecture" || fault === "source") {
        if (fault === "architecture") f.core.build.platform.goarch = "amd64";
        else f.core.build.sourceSHA = "f".repeat(40);
        f.embedded.core = f.core;
        await fs.writeFile(
          path.join(f.resource, "core-artifact.json"),
          JSON.stringify(f.core),
        );
        await fs.writeFile(
          path.join(f.resource, "build-manifest.json"),
          JSON.stringify(f.embedded),
        );
      }
      if (fault === "hash")
        await fs.appendFile(path.join(f.resource, "core-artifact.json"), "\n");
      if (fault === "bytes") {
        await fs.chmod(path.join(f.resource, "farol-backend"), 0o700);
        await fs.writeFile(
          path.join(f.resource, "farol-backend"),
          Buffer.alloc(64),
        );
      }
      const result = prepare(f);
      expect(result.status).not.toBe(0);
      if (fault !== "missing") expect(result.stderr).toContain("GO_CORE_");
      await expect(fs.stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses a substituted executable even when the fixture source verifier returns success", async () => {
    const f = await fixture();
    await fs.appendFile(
      path.join(f.resource, "update-archive.py"),
      "# substituted\n",
    );
    expect(prepare(f).stderr).toContain("EXTRACTOR_BYTES_UNTRUSTED");
  });

  it.each(["path", "artifact", "core"])(
    "refuses crossed %s in the extracted roundtrip",
    async (restoreFault) => {
      const f = await fixture({ restoreFault });
      expect(prepare(f).stderr).toContain(
        restoreFault === "path"
          ? "EXTRACTION_IDENTITY_INVALID"
          : restoreFault === "artifact"
            ? "RESTORED_ARTIFACT_MISMATCH"
            : "GO_CORE_BYTES_INVALID",
      );
      expect(await fs.readdir(f.output)).toEqual(["private"]);
    },
  );

  it.each(["expanded", "entries", "central", "depth"])(
    "bounds ZIP %s resources before writing",
    async (fault) => {
      const f = await fixture();
      const result = run(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          `
import pathlib, runpy, sys
m = runpy.run_path(sys.argv[1])
g = m['members'].__globals__
fault = sys.argv[2]
if fault == 'expanded': g['MAX_EXPANDED'] = 16384
if fault == 'entries': g['MAX_ENTRIES'] = 2
if fault == 'central': g['MAX_CENTRAL'] = 100
if fault == 'depth':
    deep = g['APP']
    for i in range(129):
        deep = deep / 'd'
        deep.mkdir()
try:
    m['members']()
except ValueError as error:
    assert str(error) == {'expanded': 'APP_RESOURCE_LIMIT', 'entries': 'APP_RESOURCE_LIMIT',
                          'central': 'APP_CENTRAL_LIMIT', 'depth': 'APP_PATH_DEPTH'}[fault], str(error)
else:
    raise AssertionError('resource limit bypassed')
print('refused')
`,
          path.join(f.root, "tooling/prepare-release-archive.py"),
          fault,
        ],
        f.root,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("refused");
    },
  );

  it("refuses casefold collisions and relative links escaping the app", async () => {
    const f = await fixture();
    // APFS may normalize or fold filenames. Inject the duplicate enumeration
    // in a disposable Python policy test instead of assuming a volume format.
    const result = run(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import os, runpy, sys
m = runpy.run_path(sys.argv[1])
g = m['members'].__globals__
real_listdir = os.listdir
def duplicate(path):
    names = real_listdir(path)
    return names + names[:1] if path == g['APP'] else names
g['os'].listdir = duplicate
try:
    m['members']()
except ValueError as error:
    assert str(error) == 'APP_PATH_COLLISION', str(error)
else:
    raise AssertionError('duplicate path accepted')
print('refused')
`,
        path.join(f.root, "tooling/prepare-release-archive.py"),
      ],
      f.root,
    );
    expect(result.status, result.stderr).toBe(0);
    await fs.symlink(
      "../../../../artifact.json",
      path.join(f.resource, "escape-relative"),
    );
    expect(prepare(f).stderr).toContain("APP_LINK_ESCAPE");
  });

  it("rejects hardlinked artifact and app inputs", async () => {
    const f = await fixture();
    const link = path.join(f.root, "_output/hardlink");
    await fs.link(f.artifactFile, link);
    expect(prepare(f).stderr).toContain("INPUT_FILE_INVALID");
    await fs.rm(link);
    await fs.link(path.join(f.resource, "payload"), link);
    expect(prepare(f).stderr).toContain("APP_HARDLINK_INVALID");
  });

  it.each([
    "profile",
    "source",
    "metadata",
    "runtime-extra",
    "top-extra",
    "binary-path",
    "split-path",
  ])("refuses %s disclosure in public assets", async (fault) => {
    const f = await fixture();
    let code;
    if (fault === "profile" || fault === "source") {
      await fs.mkdir(
        path.join(f.resource, fault === "profile" ? "Profiles" : "src"),
      );
      code =
        fault === "profile" ? "PRIVATE_ENTRY_IN_APP" : "SOURCE_ENTRY_IN_APP";
    } else if (
      fault === "metadata" ||
      fault === "runtime-extra" ||
      fault === "top-extra"
    ) {
      if (fault === "metadata")
        f.artifact.runtime.relativePath = "/Users/example/Library/Farol";
      if (fault === "runtime-extra")
        f.artifact.runtime.sourceRoot = "private-relative-data";
      if (fault === "top-extra")
        f.artifact.sourceRoot = "private-relative-data";
      await fs.writeFile(f.artifactFile, JSON.stringify(f.artifact));
      code =
        fault === "metadata"
          ? "PRIVATE_PATH_IN_ARTIFACT"
          : fault === "runtime-extra"
            ? "RUNTIME_FIELDS_INVALID"
            : "ARTIFACT_FIELDS_INVALID";
    } else {
      const prefix =
        fault === "split-path"
          ? Buffer.alloc(1024 * 1024 - 5, 0x61)
          : Buffer.from([0, 1, 2]);
      await fs.writeFile(
        path.join(f.resource, "payload"),
        Buffer.concat([
          prefix,
          Buffer.from("/Users/example/private-source"),
          Buffer.from([0]),
        ]),
      );
      code = "PRIVATE_PATH_IN_APP";
    }
    expect(prepare(f).stderr).toContain(code);
    if (fault === "binary-path" || fault === "split-path")
      expect(await fs.readdir(f.output)).toEqual(["private"]);
  });

  it.each([
    ["macOS home at EOF", "/Users/example", false],
    ["Linux home at EOF", "/home/example", false],
    ["macOS home before NUL", "/Users/example\0", false],
    ["Linux home before NUL", "/home/example\0", false],
    ["home before whitespace", "/Users/example ", false],
    ["home before quote", '/home/example"', false],
    ["macOS home across chunks", "/Users/example\0", true],
    ["Linux home across chunks", "/home/example", true],
  ])("refuses %s in owned app bytes", async (_label, leakedPath, split) => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.resource, "payload"),
      Buffer.concat([
        split ? Buffer.alloc(1024 * 1024 - 5, 0x61) : Buffer.from([0, 1, 2]),
        Buffer.from(leakedPath),
      ]),
    );
    expect(prepare(f).stderr).toContain("PRIVATE_PATH_IN_APP");
    expect(await fs.readdir(f.output)).toEqual(["private"]);
  });

  it("refuses a mode mismatch hidden by core.filemode=false", async () => {
    const f = await fixture();
    git(f.root, "config", "core.filemode", "false");
    await fs.chmod(path.join(f.root, ".gitignore"), 0o755);
    expect(git(f.root, "status", "--porcelain")).toBe("");
    expect(prepare(f).stderr).toContain("SOURCE_MODE_MISMATCH");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "refuses %s concealed source",
    async (flag) => {
      const f = await fixture();
      git(f.root, "update-index", flag, ".gitignore");
      await fs.writeFile(
        path.join(f.root, ".gitignore"),
        "_output/\n# concealed\n",
      );
      expect(git(f.root, "status", "--porcelain")).toBe("");
      expect(prepare(f).stderr).toContain("SOURCE_INDEX_FLAGS");
    },
  );

  it("physically checks bytes even when a stale Git status reports clean", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.root, ".gitignore"),
      "_output/\n# changed\n",
    );
    const result = run(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import json, pathlib, runpy, sys
m = runpy.run_path(sys.argv[1])
g = m['clean_source'].__globals__
real_git = g['git']
g['git'] = lambda *args: b'' if args[0] == 'status' else real_git(*args)
try:
    m['clean_source'](sys.argv[2], json.loads(pathlib.Path(sys.argv[3]).read_bytes()))
except ValueError as error:
    assert str(error) == 'SOURCE_PHYSICAL_MISMATCH', str(error)
else:
    raise AssertionError('stale status admitted changed bytes')
print('refused')
`,
        path.join(f.root, "tooling/prepare-release-archive.py"),
        f.head,
        f.artifactFile,
      ],
      f.root,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("refused");
  });

  it.each(["source", "package"])(
    "refuses a %s change during roundtrip verification",
    async (kind) => {
      const f = await fixture({
        mutateSource: kind === "source",
        mutatePackage: kind === "package",
      });
      expect(prepare(f).stderr).toContain(
        kind === "source" ? "SOURCE_DIRTY" : "INPUT_CHANGED",
      );
      expect(await fs.readdir(f.output)).toEqual(["private"]);
    },
  );

  it.each(
    ["artifact", "member"].flatMap((kind) =>
      ["symlink", "fifo", "replacement", "growth", "shrink"].map((fault) => [
        kind,
        fault,
      ]),
    ),
  )(
    "refuses %s %s substitution with bounded descriptor reads",
    async (kind, fault) => {
      const root = await temporaryRoot();
      const result = run(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          `
import errno, io, os, pathlib, runpy, sys, zipfile
from unittest.mock import patch
m = runpy.run_path(sys.argv[1])
root, kind, fault = pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
package = root / "_output/package"
package.mkdir(parents=True)
candidate = package / "artifact.json"
candidate.write_bytes(b"fixture")
before = candidate.lstat()
g = m["read_artifact"].__globals__
g.update(ROOT=root, PACKAGE=package, ARTIFACT=candidate)
real_open, real_read = os.open, os.read
changed, delivered = False, 0

def substitute():
    global changed
    candidate.rename(package / "original")
    if fault == "symlink":
        candidate.symlink_to("original")
    elif fault == "fifo":
        os.mkfifo(candidate)
    else:
        candidate.write_bytes(b"changed")
    changed = True

def opening(path, flags, *args, **kwargs):
    if pathlib.Path(path) == candidate and fault in ("symlink", "fifo", "replacement"):
        assert flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK
        substitute()
    return real_open(path, flags, *args, **kwargs)

def reading(fd, count):
    global changed, delivered
    if fault in ("growth", "shrink"):
        with candidate.open("ab" if fault == "growth" else "wb") as f:
            f.write(b"x" * 4096 if fault == "growth" else b"")
        changed = True
    data = real_read(fd, count)
    delivered += len(data)
    assert delivered <= before.st_size + 1
    return data

with patch.object(os, "open", opening), patch.object(os, "read", reading):
    try:
        if kind == "artifact":
            m["read_artifact"]()
        else:
            with zipfile.ZipFile(io.BytesIO(), "w") as z:
                m["add_member"](z, candidate, "payload", before)
    except (ValueError, OSError) as error:
        assert changed, str(error)
        if isinstance(error, OSError):
            assert fault == "symlink" and error.errno == errno.ELOOP, str(error)
        else:
            assert str(error) in ("INPUT_FILE_INVALID", "INPUT_CHANGED", "INPUT_SIZE_CHANGED"), str(error)
    else:
        raise AssertionError("substitution was accepted")
print("refused")
`,
          producer,
          root,
          kind,
          fault,
        ],
        root,
        3_000,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("refused");
    },
  );

  it.each(
    ["directory", "symlink"].flatMap((kind) =>
      ["before", "during"].map((timing) => [kind, timing]),
    ),
  )("checks %s identity %s archive entry writing", async (kind, timing) => {
    const root = await temporaryRoot();
    const result = run(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import io, pathlib, runpy, sys, zipfile
m = runpy.run_path(sys.argv[1])
root, kind, timing = pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
entry = root / "entry"
(root / "payload").write_bytes(b"fixture")
if kind == "directory":
    entry.mkdir()
else:
    entry.symlink_to("payload")
before = entry.lstat()
def replace():
    entry.rename(root / "original")
    if kind == "directory":
        entry.mkdir()
    else:
        entry.symlink_to("payload")
with zipfile.ZipFile(io.BytesIO(), "w") as z:
    write = z.writestr
    def writing(*args, **kwargs):
        replace()
        return write(*args, **kwargs)
    if timing == "before":
        replace()
    else:
        z.writestr = writing
    try:
        m["add_member"](z, entry, "entry/" if kind == "directory" else "entry", before)
    except ValueError as error:
        assert str(error) == "INPUT_CHANGED", str(error)
    else:
        raise AssertionError("changed entry was accepted")
print("refused")
`,
        producer,
        root,
        kind,
        timing,
      ],
      root,
      3_000,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("refused");
  });
});
