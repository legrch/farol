import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/install-release.sh', import.meta.url));
const python = '/usr/bin/python3';
const fixtureCode = String.raw`
import hashlib, json, os, stat, sys, zipfile
root, scenario = sys.argv[1:]
version = '1.2.3'
name = 'Farol-' + version + '-darwin-arm64.zip'
archive = os.path.join(root, name)
with zipfile.ZipFile(archive, 'w') as z:
    def file(name, content, mode=0o100644):
        i = zipfile.ZipInfo(name)
        i.create_system = 3
        i.external_attr = mode << 16
        z.writestr(i, content)
    file('Farol.app', '', stat.S_IFDIR | 0o755)
    file('artifact.json', '{}')
    file('Farol.app/Contents/MacOS/Farol', 'binary', 0o100755)
    file('Farol.app/Contents/Frameworks/Versions/A/library', 'library')
    file('Farol.app/Contents/Frameworks/Versions/Current', 'A', stat.S_IFLNK | 0o777)
    if scenario == 'traversal': file('Farol.app/../../escape', 'bad')
    if scenario == 'absolute': file('/Farol.app/evil', 'bad')
    if scenario == 'escape-link': file('Farol.app/Contents/escape', '../../outside', stat.S_IFLNK | 0o777)
    if scenario == 'chain-escape':
        file('Farol.app/Contents/link1', 'link2', stat.S_IFLNK | 0o777)
        file('Farol.app/Contents/link2', '../../outside', stat.S_IFLNK | 0o777)
    if scenario == 'under-link': file('Farol.app/Contents/Frameworks/Versions/Current/evil', 'bad')
    if scenario == 'duplicate': file('Farol.app/Contents/MacOS/Farol', 'duplicate')
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
function run(args, options = {}) {
  return spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', ...options });
}
function fixture(scenario, callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farol-install-test-'));
  try {
    const setup = spawnSync(python, ['-c', fixtureCode, root, scenario], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const output = path.join(root, 'output');
    const result = run(['--validate-only', '1.2.3', path.join(root, 'Farol-1.2.3-darwin-arm64.zip'),
      path.join(root, 'farol-release.json'), path.join(root, 'SHA256SUMS'), output]);
    callback(result, output, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('strictly rejects non-numeric versions and extra arguments before operations', () => {
  for (const args of [[], ['1.2'], ['01.2.3'], ['1.2.3-beta'], ['1.2.3;touch x'], ['--fresh-profile', '1.2.3'], ['1.2.3', 'extra']]) {
    const result = run(args, { env: { PATH: '/nonexistent', TMPDIR: '/nonexistent' } });
    assert.equal(result.status, 2, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
  }
});

test('valid release extracts executable and safe framework symlink', () => {
  fixture('valid', (result, output) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(output, 'Farol.app/Contents/MacOS/Farol'), 'utf8'), 'binary');
    assert.equal(readFileSync(path.join(output, 'Farol.app/Contents/Frameworks/Versions/Current/library'), 'utf8'), 'library');
  });
});

for (const scenario of ['wrong-version', 'wrong-repository', 'wrong-name', 'wrong-size', 'wrong-hash', 'wrong-sums', 'traversal', 'absolute', 'escape-link', 'chain-escape', 'under-link', 'duplicate']) {
  test(`rejects ${scenario}`, () => fixture(scenario, (result, output, root) => {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Release validation failed/);
    assert.throws(() => readFileSync(path.join(root, 'escape')));
  }));
}

test('does not overwrite a caller-selected extraction directory', () => {
  fixture('valid', (_result, output, root) => {
    writeFileSync(path.join(output, 'sentinel'), 'keep');
    const result = run(['--validate-only', '1.2.3', path.join(root, 'Farol-1.2.3-darwin-arm64.zip'),
      path.join(root, 'farol-release.json'), path.join(root, 'SHA256SUMS'), output]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path.join(output, 'sentinel'), 'utf8'), 'keep');
  });
});

// This copy has every host-effect command and installation path replaced with
// fixture-owned paths. The shipped script has no environment-based routing.
test('isolated installation orders checks, quit, backup and launch', () => {
  isolatedInstall('success', (result, root, log) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed and running: Farol 1\.2\.3/);
    assert.match(result.stdout, /Signing type: ad-hoc/);
    assert.match(result.stdout, /Updater status: not confirmed/);
    assert.ok(log.indexOf('codesign') < log.indexOf('osascript'));
    assert.ok(log.indexOf('osascript') < log.indexOf('ditto-backup'));
    assert.ok(log.indexOf('ditto-backup') < log.indexOf('open'));
    assert.equal(readFileSync(path.join(root, 'Applications/Farol.app/Contents/MacOS/Farol'), 'utf8'), 'binary');
  });
});

test('isolated failed signature leaves the existing app untouched', () => {
  isolatedInstall('bad-signature', (result, root, log) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature verification failed/);
    assert.equal(readFileSync(path.join(root, 'Applications/Farol.app/old'), 'utf8'), 'old');
    assert.ok(!log.includes('osascript'));
  });
});

test('isolated failed launch retains a recoverable predecessor', () => {
  isolatedInstall('bad-launch', (result, _root, log) => {
    assert.notEqual(result.status, 0);
    const retained = result.stderr.match(/Recovery files retained at: (.+)/);
    assert.ok(retained, result.stderr);
    assert.equal(readFileSync(path.join(retained[1], 'previous.app/old'), 'utf8'), 'old');
    assert.ok(log.includes('ditto-backup'));
  });
});

function isolatedInstall(scenario, callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farol-install-flow-'));
  try {
    const setup = spawnSync(python, ['-c', fixtureCode, root, 'valid'], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const prep = spawnSync('/bin/mkdir', ['-p', path.join(root, 'Applications/Farol.app'), path.join(root, 'bin')]);
    assert.equal(prep.status, 0);
    writeFileSync(path.join(root, 'Applications/Farol.app/old'), 'old');
    writeFileSync(path.join(root, 'running'), 'yes');
    const fake = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const root = process.env.FIXTURE_ROOT, cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
const log = x => fs.appendFileSync(path.join(root, 'log'), x + '\n');
if (cmd === 'uname') { console.log(args[0] === '-s' ? 'Darwin' : 'arm64'); }
else if (cmd === 'curl') { const dest = args[args.indexOf('--output')+1]; fs.copyFileSync(path.join(root, path.basename(dest)), dest); }
else if (cmd === 'PlistBuddy') { const key = args[1]; console.log(key.includes('Identifier') ? 'io.github.legrch.farol' : key.includes('Executable') ? 'Farol' : '1.2.3'); }
else if (cmd === 'codesign') { log('codesign'); if (process.env.SCENARIO === 'bad-signature') process.exit(1); if (args[0] === '-dv') console.error('Signature=adhoc'); }
else if (cmd === 'ps') { if (fs.existsSync(path.join(root, 'running'))) console.log(path.join(root, 'Applications/Farol.app/Contents/MacOS/Farol')); }
else if (cmd === 'osascript') { log('osascript'); fs.rmSync(path.join(root, 'running'), {force:true}); }
else if (cmd === 'ditto') { log(args[1].endsWith('previous.app') ? 'ditto-backup' : 'ditto-install'); fs.cpSync(args[0], args[1], {recursive:true, verbatimSymlinks:true}); }
else if (cmd === 'open') { log('open'); if (process.env.SCENARIO === 'bad-launch') process.exit(1); fs.writeFileSync(path.join(root, 'running'), 'yes'); }
else process.exit(2);
`;
    const fakePath = path.join(root, 'bin/fake');
    writeFileSync(fakePath, fake.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    for (const command of ['uname', 'curl', 'PlistBuddy', 'codesign', 'ps', 'osascript', 'ditto', 'open']) {
      const link = spawnSync('/bin/ln', ['-s', fakePath, path.join(root, 'bin', command)]);
      assert.equal(link.status, 0);
    }
    let copy = readFileSync(script, 'utf8');
    for (const command of ['uname', 'curl', 'codesign', 'osascript', 'ditto', 'open'])
      copy = copy.replaceAll(`/usr/bin/${command}`, path.join(root, 'bin', command));
    copy = copy.replaceAll('/usr/libexec/PlistBuddy', path.join(root, 'bin/PlistBuddy'))
      .replaceAll('/bin/ps', path.join(root, 'bin/ps'))
      .replaceAll('/Applications/Farol.app', path.join(root, 'Applications/Farol.app'))
      .replace('/tmp/farol-release.XXXXXXXX', path.join(root, 'release.XXXXXXXX'));
    const copyPath = path.join(root, 'isolated-installer.sh');
    writeFileSync(copyPath, copy);
    const result = spawnSync('/bin/sh', [copyPath, '1.2.3'], {
      encoding: 'utf8', env: { ...process.env, FIXTURE_ROOT: root, SCENARIO: scenario },
    });
    let log = '';
    try { log = readFileSync(path.join(root, 'log'), 'utf8'); } catch {}
    callback(result, root, log);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
