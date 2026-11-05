import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/install-release.sh", import.meta.url),
);
const python = "/usr/bin/python3";
const fixtureCode = String.raw`
import hashlib, json, os, pathlib, stat, sys, zipfile
root, scenario = sys.argv[1:]
app = pathlib.Path(root) / 'reference/Farol.app'
launcher = """#!/bin/sh
set -eu

launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=${"$"}{launcher_path%/*}
contents_dir=${"$"}{macos_dir%/*}
export ELECTRON_FORCE_IS_PACKAGED=true
exec "$contents_dir/Resources/app/farol-backend" run-desktop-launcher "$@"
"""
for name, content, mode in [
    ('Contents/MacOS/Farol', launcher, 0o755),
    ('Contents/Resources/app/farol-backend', 'backend', 0o700),
    ('Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron', 'runtime', 0o755),
    ('Contents/Frameworks/Versions/A/library', 'library', 0o644),
]:
    target = app / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    target.chmod(mode)
os.symlink('A', app / 'Contents/Frameworks/Versions/Current')
version = '1.2.3'
name = 'Farol-' + version + '-darwin-arm64.zip'
archive = os.path.join(root, name)
with zipfile.ZipFile(archive, 'w') as z:
    def file(name, content, mode=0o100644):
        i = zipfile.ZipInfo(name)
        i.create_system = 3
        i.external_attr = mode << 16
        z.writestr(i, content)
    file('Farol.app/', '', stat.S_IFDIR | 0o755)
    file('artifact.json', '{}')
    for path in sorted(app.rglob('*')):
        name_in_zip = 'Farol.app/' + path.relative_to(app).as_posix()
        info = path.lstat()
        if path.is_symlink(): file(name_in_zip, os.readlink(path), info.st_mode)
        elif path.is_dir(): file(name_in_zip + '/', '', info.st_mode)
        else: file(name_in_zip, path.read_bytes(), info.st_mode)
    if scenario == 'traversal': file('Farol.app/../../escape', 'bad')
    if scenario == 'absolute': file('/Farol.app/evil', 'bad')
    if scenario == 'escape-link': file('Farol.app/Contents/escape', '../../outside', stat.S_IFLNK | 0o777)
    if scenario == 'chain-escape':
        file('Farol.app/Contents/link1', 'link2', stat.S_IFLNK | 0o777)
        file('Farol.app/Contents/link2', '../../outside', stat.S_IFLNK | 0o777)
    if scenario == 'under-link': file('Farol.app/Contents/Frameworks/Versions/Current/evil', 'bad')
    if scenario == 'duplicate': file('Farol.app/Contents/MacOS/Farol', 'duplicate')
    if scenario == 'extra-file': file('Farol.app/extra', 'tampered')
data = open(archive, 'rb').read()
hash = hashlib.sha256(data).hexdigest()
manifest = dict(schema='farol.github-release/1', repository='legrch/farol', version=version,
                platform='darwin', arch='arm64', archiveName=name, archiveSha256=hash, archiveSize=len(data))
if scenario == 'wrong-version': manifest['version'] = '1.2.4'
if scenario == 'wrong-repository': manifest['repository'] = 'other/farol'
if scenario == 'wrong-name': manifest['archiveName'] = 'other.zip'
if scenario == 'wrong-size': manifest['archiveSize'] += 1
if scenario == 'wrong-hash': manifest['archiveSha256'] = '0' * 64
open(os.path.join(root, 'farol-release.json'), 'w').write(json.dumps(manifest))
open(os.path.join(root, 'SHA256SUMS'), 'w').write(('0' * 64 if scenario == 'wrong-sums' else hash) + '  ' + name + '\n')
`;
function prepare(root, scenario) {
  const setup = spawnSync(python, ["-c", fixtureCode, root, scenario], {
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, setup.stderr);
  const digestModule = pathToFileURL(
    fileURLToPath(
      new URL("../../src/pkg/artifact-tree-digest/digest.ts", import.meta.url),
    ),
  ).href;
  const digest = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { treeDigest } from ${JSON.stringify(digestModule)}; console.log(await treeDigest(process.argv[1]));`,
      path.join(root, "reference/Farol.app"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(digest.status, 0, digest.stderr);
  const manifestPath = path.join(root, "farol-release.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (scenario !== "missing-artifact")
    manifest.artifactSha256 =
      scenario === "wrong-artifact" ? "0".repeat(64) : digest.stdout.trim();
  writeFileSync(manifestPath, JSON.stringify(manifest));
}
function run(args, options = {}) {
  return spawnSync("/bin/sh", [script, ...args], {
    encoding: "utf8",
    ...options,
  });
}
function fixture(scenario, callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-install-test-"));
  try {
    prepare(root, scenario);
    const output = path.join(root, "output");
    const result = run([
      "--validate-only",
      "1.2.3",
      path.join(root, "Farol-1.2.3-darwin-arm64.zip"),
      path.join(root, "farol-release.json"),
      path.join(root, "SHA256SUMS"),
      output,
    ]);
    callback(result, output, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("strictly rejects non-numeric versions and extra arguments before operations", () => {
  for (const args of [
    [],
    ["1.2"],
    ["01.2.3"],
    ["1.2.3-beta"],
    ["1.2.3;touch x"],
    ["--fresh-profile", "1.2.3"],
    ["1.2.3", "extra"],
  ]) {
    const result = run(args, {
      env: { PATH: "/nonexistent", TMPDIR: "/nonexistent" },
    });
    assert.equal(result.status, 2, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
  }
});

test("valid release extracts executable and safe framework symlink", () => {
  fixture("valid", (result, output) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(path.join(output, "Farol.app/Contents/MacOS/Farol"), "utf8"),
      /run-desktop-launcher/,
    );
    assert.equal(
      readFileSync(
        path.join(
          output,
          "Farol.app/Contents/Frameworks/Versions/Current/library",
        ),
        "utf8",
      ),
      "library",
    );
  });
});

for (const scenario of [
  "wrong-version",
  "wrong-repository",
  "wrong-name",
  "wrong-size",
  "wrong-hash",
  "wrong-sums",
  "missing-artifact",
  "wrong-artifact",
  "extra-file",
  "traversal",
  "absolute",
  "escape-link",
  "chain-escape",
  "under-link",
  "duplicate",
]) {
  test(`rejects ${scenario}`, () =>
    fixture(scenario, (result, output, root) => {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /Release validation failed/);
      assert.throws(() => readFileSync(path.join(root, "escape")));
    }));
}

test("does not overwrite a caller-selected extraction directory", () => {
  fixture("valid", (_result, output, root) => {
    writeFileSync(path.join(output, "sentinel"), "keep");
    const result = run([
      "--validate-only",
      "1.2.3",
      path.join(root, "Farol-1.2.3-darwin-arm64.zip"),
      path.join(root, "farol-release.json"),
      path.join(root, "SHA256SUMS"),
      output,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path.join(output, "sentinel"), "utf8"), "keep");
  });
});

// This copy has every host-effect command and installation path replaced with
// fixture-owned paths. The shipped script has no environment-based routing.
test("isolated installation orders checks, quit, backup and launch", () => {
  isolatedInstall("success", (result, root, log) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed and running: Farol 1\.2\.3/);
    assert.match(
      result.stdout,
      /Outer app: unsigned; executable signatures and release tree verified/,
    );
    assert.match(
      result.stdout,
      /Farol opened\. Check its connection and updates in the app\./,
    );
    assert.ok(log.indexOf("codesign") < log.indexOf("osascript"));
    assert.ok(log.indexOf("osascript") < log.indexOf("ditto-backup"));
    assert.ok(log.indexOf("ditto-backup") < log.indexOf("open"));
    assert.match(
      readFileSync(
        path.join(root, "Applications/Farol.app/Contents/MacOS/Farol"),
        "utf8",
      ),
      /run-desktop-launcher/,
    );
  });
});

test("isolated failed signature leaves the existing app untouched", () => {
  isolatedInstall("bad-signature", (result, root, log) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature verification failed/);
    assert.equal(
      readFileSync(path.join(root, "Applications/Farol.app/old"), "utf8"),
      "old",
    );
    assert.ok(!log.includes("osascript"));
  });
});

test("isolated failed launch retains a recoverable predecessor", () => {
  isolatedInstall("bad-launch", (result, _root, log) => {
    assert.notEqual(result.status, 0);
    const retained = result.stderr.match(/Recovery files retained at: (.+)/);
    assert.ok(retained, result.stderr);
    assert.equal(
      readFileSync(path.join(retained[1], "previous.app/old"), "utf8"),
      "old",
    );
    assert.ok(log.includes("ditto-backup"));
  });
});

test("isolated immediate startup exit is reported instead of installed and running", () => {
  isolatedInstall("early-exit", (result, _root, log) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exited shortly after launch/);
    assert.doesNotMatch(result.stdout, /Installed and running/);
    const retained = result.stderr.match(/Recovery files retained at: (.+)/);
    assert.ok(retained, result.stderr);
    assert.equal(
      readFileSync(path.join(retained[1], "previous.app/old"), "utf8"),
      "old",
    );
    assert.ok(log.includes("open"));
  });
});

for (const scenario of [
  "private-only",
  "snapshot",
  "helper",
  "dev",
  "process-title",
  "cursor-farol",
  "other-checkout",
  "vanished-after-quit",
]) {
  test(`isolated ${scenario} process is handled without touching unrelated apps`, () => {
    isolatedInstall(scenario, (result, _root, log) => {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /Traceback|Process inspection failed/);
      assert.match(log, /osascript/);
      assert.match(log, /ditto-backup/);
    });
  });
}

for (const scenario of [
  "ps-failure",
  "unknown",
  "other-farol-app",
  "other-private-launch",
  "private-and-public",
  "stubborn",
  "quit-failure",
  "backend-remains",
  "bad-tree",
  "unexpected-descendant",
  "inspection-error",
  "live-unreadable",
  "permission-denied",
]) {
  test(`isolated ${scenario} preserves the existing app and recovery files`, () => {
    isolatedInstall(scenario, (result, root, log) => {
      assert.notEqual(result.status, 0);
      assert.equal(
        readFileSync(path.join(root, "Applications/Farol.app/old"), "utf8"),
        "old",
      );
      assert.doesNotMatch(log, /ditto-backup|ditto-install|open/);
      const retained = result.stderr.match(/Recovery files retained at: (.+)/);
      assert.ok(retained, result.stderr);
      assert.ok(
        readFileSync(path.join(retained[1], "farol-release.json")).length > 0,
      );
    });
  });
}

test("isolated stuck application escalates TERM to KILL before replacement", () => {
  isolatedInstall("escalate", (result, _root, log) => {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(log.indexOf("signal-15") < log.indexOf("signal-9"));
    assert.ok(log.indexOf("signal-9") < log.indexOf("ditto-backup"));
  });
});

function isolatedInstall(scenario, callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-install-flow-"));
  try {
    prepare(root, scenario === "bad-tree" ? "extra-file" : "valid");
    const prep = spawnSync("/bin/mkdir", [
      "-p",
      path.join(root, "Applications/Farol.app"),
      path.join(root, "bin"),
    ]);
    assert.equal(prep.status, 0);
    writeFileSync(path.join(root, "Applications/Farol.app/old"), "old");
    writeFileSync(path.join(root, "running"), "yes");
    const fake = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const root = process.env.FIXTURE_ROOT, cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
const log = x => fs.appendFileSync(path.join(root, 'log'), x + '\n');
if (cmd === 'uname') { console.log(args[0] === '-s' ? 'Darwin' : 'arm64'); }
else if (cmd === 'curl') { const dest = args[args.indexOf('--output')+1]; fs.copyFileSync(path.join(root, path.basename(dest)), dest); }
else if (cmd === 'PlistBuddy') { const key = args[1]; console.log(key.includes('Identifier') ? 'io.github.legrch.farol' : key.includes('Executable') ? 'Farol' : '1.2.3'); }
else if (cmd === 'codesign') { log('codesign'); if (args[0] === '-d') { console.error('code object is not signed at all'); process.exit(1); } if (process.env.SCENARIO === 'bad-signature') process.exit(1); }
else if (cmd === 'ps') {
  if (process.env.SCENARIO === 'ps-failure') process.exit(1);
  console.log('1 /sbin/launchd');
  if (fs.existsSync(path.join(root, 'running'))) {
    const app = path.join(root, 'Applications/Farol.app');
    const profile = path.join(root, 'Library/Application Support/io.github.legrch.farol/installed-updates');
    let base = ['private-and-public', 'private-only', 'helper', 'stubborn'].includes(process.env.SCENARIO) ? path.join(profile, 'op/launch-Farol.app') : app;
    if (process.env.SCENARIO === 'snapshot') base = path.join(profile, 'installed-execution/snapshot/Farol.app');
    const suffix = ['helper', 'backend-remains'].includes(process.env.SCENARIO) && !fs.existsSync(path.join(root, 'launched')) ? '/Contents/Resources/app/farol-backend' : '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron';
    console.log('42 ' + (process.env.SCENARIO === 'process-title' ? 'Farol' : base + suffix));
    if (['private-and-public', 'snapshot', 'helper', 'stubborn'].includes(process.env.SCENARIO)) console.log('45 ' + app + '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron');
  }
  if (process.env.SCENARIO === 'unknown') console.log('43 farol-backend');
  if (['inspection-error', 'live-unreadable', 'permission-denied'].includes(process.env.SCENARIO)) console.log('43 farol-backend');
  if (process.env.SCENARIO === 'vanished-after-quit' && !fs.existsSync(path.join(root, 'running')) && !fs.existsSync(path.join(root, 'stale-sampled'))) {
    fs.writeFileSync(path.join(root, 'stale-sampled'), 'yes');
    console.log('43 farol-backend');
  }
  if (process.env.SCENARIO === 'other-farol-app') console.log('44 /tmp/other/Farol.app/Contents/MacOS/Electron');
  if (process.env.SCENARIO === 'other-private-launch') console.log('44 /Users/other/Library/Application Support/io.github.legrch.farol/installed-updates/operation/launch-Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron');
  if (process.env.SCENARIO === 'dev') console.log('44 /Applications/Farol Dev.app/Contents/MacOS/Farol Dev');
  if (process.env.SCENARIO === 'cursor-farol') console.log('44 Cursor Helper (Plugin): extension-host (user) farol [6-217]');
  if (process.env.SCENARIO === 'other-checkout') console.log('44 /Users/ac/code/other/farol/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
}
else if (cmd === 'osascript') { log('osascript'); const source = fs.readFileSync(0, 'utf8'); if (!source.includes('menu bar item "Farol"') || !source.includes('repeat with candidate in every application process') || !source.includes('if (unix id of targetProcess) is not targetPid') || process.env.SCENARIO === 'quit-failure') process.exit(1); if (!['stubborn', 'backend-remains', 'escalate', 'unexpected-descendant'].includes(process.env.SCENARIO)) fs.rmSync(path.join(root, 'running'), {force:true}); }
else if (cmd === 'ditto') { log(args[1].endsWith('previous.app') ? 'ditto-backup' : 'ditto-install'); fs.cpSync(args[0], args[1], {recursive:true, verbatimSymlinks:true}); }
else if (cmd === 'sleep') { if (process.env.SCENARIO === 'early-exit' && fs.existsSync(path.join(root, 'launched'))) fs.rmSync(path.join(root, 'running'), {force:true}); }
else if (cmd === 'open') { log('open'); if (process.env.SCENARIO === 'bad-launch') process.exit(1); fs.writeFileSync(path.join(root, 'launched'), 'yes'); fs.writeFileSync(path.join(root, 'running'), 'yes'); }
else process.exit(2);
`;
    const fakePath = path.join(root, "bin/fake");
    writeFileSync(
      fakePath,
      fake.replace("#!/usr/bin/env node", `#!${process.execPath}`),
      { mode: 0o755 },
    );
    for (const command of [
      "uname",
      "curl",
      "PlistBuddy",
      "codesign",
      "ps",
      "osascript",
      "ditto",
      "open",
      "sleep",
    ]) {
      const link = spawnSync("/bin/ln", [
        "-s",
        fakePath,
        path.join(root, "bin", command),
      ]);
      assert.equal(link.status, 0);
    }
    let copy = readFileSync(script, "utf8");
    for (const command of [
      "uname",
      "curl",
      "codesign",
      "osascript",
      "ditto",
      "open",
    ])
      copy = copy.replaceAll(
        `/usr/bin/${command}`,
        path.join(root, "bin", command),
      );
    copy = copy
      .replaceAll("/usr/libexec/PlistBuddy", path.join(root, "bin/PlistBuddy"))
      .replaceAll("/bin/ps", path.join(root, "bin/ps"))
      .replaceAll("/bin/sleep", path.join(root, "bin/sleep"))
      .replaceAll(
        "/Applications/Farol.app",
        path.join(root, "Applications/Farol.app"),
      )
      .replace(
        "/tmp/farol-release.XXXXXXXX",
        path.join(root, "release.XXXXXXXX"),
      );
    if (
      [
        "vanished-after-quit",
        "inspection-error",
        "live-unreadable",
        "permission-denied",
      ].includes(scenario)
    ) {
      copy = copy.replace(
        "found = False\nmain_pids = []\ntry:",
        `class FakePidPath:
    def __call__(self, pid, buf, size):
        if pid == 43:
            if os.environ['SCENARIO'] == 'inspection-error':
                raise RuntimeError('fixture inspection error')
            return 0
        value = os.fsencode(installed + '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron')
        buf.value = value
        return len(value)
class FakeProc:
    def __init__(self):
        self.proc_pidpath = FakePidPath()
ctypes.CDLL = lambda *args, **kwargs: FakeProc()
original_kill = os.kill
def fake_pid_probe(pid, signal):
    if pid == 43:
        if os.environ['SCENARIO'] == 'vanished-after-quit':
            raise ProcessLookupError()
        if os.environ['SCENARIO'] == 'permission-denied':
            raise PermissionError()
        return None
    return original_kill(pid, signal)
os.kill = fake_pid_probe
found = False
main_pids = []
try:`,
      );
    } else {
      copy = copy.replace(
        "found = False\nmain_pids = []\ntry:",
        `def resolve_executable(pid):
    if pid == 42:
        return installed + '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron'
    if pid == 44:
        return '/Applications/Cursor.app/Contents/MacOS/Cursor'
    return '/tmp/other/farol-backend'
found = False
main_pids = []
try:`,
      );
    }
    if (["escalate", "unexpected-descendant"].includes(scenario)) {
      const nativeProc = [
        "lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)",
        "lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]",
        "lib.proc_pidpath.restype = ctypes.c_int",
      ].join("\n");
      assert.ok(copy.includes(nativeProc));
      copy = copy.replace(nativeProc, "lib = None");
      copy = copy.replace(
        "try:\n    rows = table()",
        `def table():
    if not os.path.exists(os.path.join(os.environ['FIXTURE_ROOT'], 'running')):
        return {1: (0, 'S')}
    return {101: (1, 'S'), 102: (101, 'S')}
def identity(pid):
    if pid == 101:
        path = installed + '/Contents/Resources/app/farol-backend'
    else:
        path = '/tmp/unrelated' if os.environ['SCENARIO'] == 'unexpected-descendant' else installed + '/Contents/MacOS/Farol'
    return {'pid': pid, 'path': path, 'start': 'fixed'}
class TestProc:
    def proc_pidpath(self, pid, buf, size):
        value = os.fsencode(identity(pid)['path'])
        buf.value = value
        return len(value)
lib = TestProc()
def fake_kill(pid, sig):
    with open(os.path.join(os.environ['FIXTURE_ROOT'], 'log'), 'a') as f:
        f.write('signal-%s\\n' % int(sig))
    if sig == signal.SIGKILL and pid == 101:
        os.unlink(os.path.join(os.environ['FIXTURE_ROOT'], 'running'))
os.kill = fake_kill
time.sleep = lambda _: None
try:
    rows = table()`,
      );
    }
    const copyPath = path.join(root, "isolated-installer.sh");
    writeFileSync(copyPath, copy);
    const result = spawnSync("/bin/sh", [copyPath, "1.2.3"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        FIXTURE_ROOT: root,
        SCENARIO: scenario,
      },
    });
    let log = "";
    try {
      log = readFileSync(path.join(root, "log"), "utf8");
    } catch {}
    callback(result, root, log);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
