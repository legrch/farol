#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

usage='Usage: scripts/install-release.sh <version|latest>'
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
valid_version() { printf '%s\n' "$1" | /usr/bin/grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; }

# Resolve the highest published stable semver from one bounded page, and refuse
# an incomplete page or asset set. This remains independent of GitHub's Latest
# marker so an older release cannot change the installer's selection.
resolve_latest() {
  /usr/bin/python3 -I - "$1" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], 'rb') as stream:
        raw = stream.read(2097153)
    if len(raw) > 2097152:
        raise ValueError('release listing exceeds limit')
    releases = json.loads(raw)
    if not isinstance(releases, list) or not releases or len(releases) >= 100:
        raise ValueError('release listing is empty or incomplete')
    stable = []
    for release in releases:
        if not isinstance(release, dict):
            raise ValueError('invalid release entry')
        tag = release.get('tag_name')
        if type(release.get('draft')) is not bool or type(release.get('prerelease')) is not bool or not isinstance(tag, str):
            raise ValueError('invalid release classification')
        if release['draft']:
            continue
        if not isinstance(release.get('published_at'), str) or not release['published_at']:
            raise ValueError('invalid published release')
        if release['prerelease']:
            continue
        if not isinstance(tag, str) or len(tag) > 64 or not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', tag):
            raise ValueError('invalid stable release version')
        stable.append((tuple(map(int, tag[1:].split('.'))), tag[1:], release))
    if not stable:
        raise ValueError('no published stable release')
    _, version, selected = max(stable, key=lambda item: item[0])
    assets = selected.get('assets')
    expected = {f'Farol-{version}-darwin-arm64.zip', 'farol-release.json', 'SHA256SUMS'}
    if not isinstance(assets, list) or any(not isinstance(asset, dict) or not isinstance(asset.get('name'), str) for asset in assets):
        raise ValueError('newest stable release assets are incomplete')
    by_name = {asset['name']: asset for asset in assets}
    if len(by_name) != len(assets) or not expected.issubset(by_name) or any(by_name[name].get('state') != 'uploaded' or type(by_name[name].get('size')) is not int or by_name[name]['size'] <= 0 for name in expected):
        raise ValueError('newest stable release assets are incomplete')
    print(version)
except (OSError, ValueError, TypeError, UnicodeError, json.JSONDecodeError) as error:
    print('Latest release lookup failed:', error, file=sys.stderr)
    sys.exit(1)
PY
}
check_latest_version() {
  /usr/bin/python3 -I - "$1" "$2" <<'PY'
import re, sys
versions = sys.argv[1:]
if any(not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', value) for value in versions):
    sys.exit(1)
installed, selected = (tuple(map(int, value.split('.'))) for value in versions)
sys.exit(0 if installed <= selected else 1)
PY
}

# Explicit, non-installing test interface: validates and extracts only to a new
# caller-specified directory. It does not invoke any production operations.
validate_archive() {
  /usr/bin/python3 -I - "$@" <<'PY'
import hashlib, json, os, pathlib, re, shutil, stat, struct, sys, zipfile
version, archive, manifest_path, sums_path, output = sys.argv[1:]
name = f'Farol-{version}-darwin-arm64.zip'
def reject(message):
    raise ValueError(message)
try:
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', version):
        reject('invalid version')
    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)
    expected = {'schema': 'farol.github-release/1', 'repository': 'legrch/farol',
                'version': version, 'platform': 'darwin', 'arch': 'arm64', 'archiveName': name}
    if not isinstance(manifest, dict) or any(manifest.get(k) != v for k, v in expected.items()):
        reject('release manifest identity mismatch')
    size = manifest.get('archiveSize')
    digest = manifest.get('archiveSha256')
    artifact_digest = manifest.get('artifactSha256')
    if not isinstance(artifact_digest, str) or not re.fullmatch('[0-9a-f]{64}', artifact_digest):
        reject('invalid artifact digest')
    if type(size) is not int or size <= 0 or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        reject('invalid archive size or digest')
    if os.path.basename(archive) != name or os.path.getsize(archive) != size:
        reject('archive name or size mismatch')
    h = hashlib.sha256()
    with open(archive, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    if h.hexdigest() != digest:
        reject('archive digest mismatch')
    with open(sums_path, encoding='utf-8') as f:
        lines = f.read().splitlines()
    matches = [line for line in lines if re.fullmatch(r'[0-9a-fA-F]{64} [ *]' + re.escape(name), line)]
    if len(matches) != 1 or matches[0][:64].lower() != digest:
        reject('SHA256SUMS mismatch or duplicate')
    # Require a single app root and forbid duplicate names, special files, and
    # entries beneath symlinks. Extract files first, then create links.
    with zipfile.ZipFile(archive) as z:
        entries, links = {}, {}
        for item in z.infolist():
            raw = item.filename
            parts = raw.rstrip('/').split('/')
            if not raw or '\\' in raw or raw.startswith('/') or any(p in ('', '.', '..') for p in parts) or (parts[0] != 'Farol.app' and raw != 'artifact.json'):
                reject('unsafe ZIP path: ' + raw)
            key = '/'.join(parts)
            if key == 'artifact.json' and stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFREG):
                reject('artifact metadata must be a file')
            if key == 'Farol.app' and stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFDIR):
                reject('app root must be a directory')
            if key in entries:
                reject('duplicate ZIP path: ' + key)
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                reject('unsupported ZIP entry type')
            entries[key] = (item, mode, kind)
            if kind == stat.S_IFLNK:
                target = z.read(item).decode('utf-8')
                if not target or '\x00' in target or target.startswith('/') or '\\' in target:
                    reject('unsafe symlink target')
                links[key] = target
        if not entries or not any(k.startswith('Farol.app/') for k in entries):
            reject('missing app contents')
        for key in entries:
            ancestors = key.split('/')[:-1]
            if any('/'.join(ancestors[:i]) in links for i in range(1, len(ancestors) + 1)):
                reject('ZIP entry below symlink')
        os.mkdir(output, 0o700)
        root = pathlib.Path(output)
        for key, (item, mode, kind) in entries.items():
            dest = root.joinpath(*key.split('/'))
            if kind == stat.S_IFLNK:
                continue
            if item.is_dir() or kind == stat.S_IFDIR:
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(item) as src, open(dest, 'xb') as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(dest, (mode & 0o7777) or 0o644)
        for key, target in links.items():
            dest = root.joinpath(*key.split('/'))
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Darwin applies umask to the link's own mode, which is part of
            # the tree digest. Linux symlinks always have mode 0777.
            mode = entries[key][1] & 0o777
            old_umask = os.umask(0o777 & ~mode)
            try:
                os.symlink(target, dest)
            finally:
                os.umask(old_umask)
        app = (root / 'Farol.app').resolve(strict=True)
        for key in links:
            resolved = root.joinpath(*key.split('/')).resolve(strict=True)
            if not resolved.is_relative_to(app):
                reject('symlink escapes app root')
        # Directory modes must be applied after extraction, including restrictive
        # modes. Release archives contain explicit records for all directories.
        for key, (_, mode, kind) in sorted(entries.items(), key=lambda pair: -pair[0].count('/')):
            if kind == stat.S_IFDIR:
                os.chmod(root.joinpath(*key.split('/')), mode & 0o7777)
        # Identical encoding to src/pkg/artifact-tree-digest/digest.ts v2.
        tree = hashlib.sha256(b'farol.tree-digest/v2\0')
        def field(value):
            data = value.encode('utf-8')
            return struct.pack('>I', len(data)) + data
        def walk(directory):
            for child in sorted(directory.iterdir(), key=lambda p: p.name.encode('utf-16-be')):
                info = child.lstat()
                tree.update(field(child.relative_to(app).as_posix()))
                tree.update(b'l' if stat.S_ISLNK(info.st_mode) else b'd' if stat.S_ISDIR(info.st_mode) else b'f' if stat.S_ISREG(info.st_mode) else b'?')
                tree.update(struct.pack('>I', stat.S_IMODE(info.st_mode)))
                if stat.S_ISLNK(info.st_mode):
                    target = os.readlink(child)
                    lexical = pathlib.Path(os.path.abspath(child.parent / target))
                    if os.path.isabs(target) or not lexical.is_relative_to(app) or not child.resolve(strict=True).is_relative_to(app):
                        reject('unsafe artifact symlink')
                    tree.update(field(target))
                elif stat.S_ISDIR(info.st_mode):
                    walk(child)
                elif stat.S_ISREG(info.st_mode):
                    content = hashlib.sha256()
                    with child.open('rb') as f:
                        for chunk in iter(lambda: f.read(1024 * 1024), b''):
                            content.update(chunk)
                    tree.update(content.digest())
                else:
                    reject('unsupported artifact entry')
        walk(app)
        if tree.hexdigest() != artifact_digest:
            reject('artifact tree digest mismatch')
except (OSError, ValueError, RuntimeError, UnicodeError, zipfile.BadZipFile, json.JSONDecodeError) as error:
    print('Release validation failed:', error, file=sys.stderr)
    sys.exit(1)
PY
}

if [ "${1-}" = '--validate-only' ]; then
  [ "$#" -eq 6 ] || { printf '%s\n' 'Usage: --validate-only <version> <zip> <manifest> <sums> <new-output-directory>' >&2; exit 2; }
  shift
  validate_archive "$@"
  exit $?
fi
if [ "${1-}" = '--resolve-latest' ]; then
  [ "$#" -eq 2 ] || { printf '%s\n' 'Usage: --resolve-latest <release-list-json>' >&2; exit 2; }
  resolve_latest "$2"
  exit $?
fi
if [ "${1-}" = '--check-latest-version' ]; then
  [ "$#" -eq 3 ] || { printf '%s\n' 'Usage: --check-latest-version <installed> <selected>' >&2; exit 2; }
  check_latest_version "$2" "$3"
  exit $?
fi
[ "$#" -eq 1 ] || { printf '%s\n' "$usage" >&2; exit 2; }
[ "$1" != '--help' ] || { printf '%s\n' "$usage"; exit 0; }
{ [ "$1" = latest ] || valid_version "$1"; } || { printf '%s\n' "$usage" >&2; exit 2; }
version=$1
requested_latest=no
[ "$version" != latest ] || requested_latest=yes
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'macOS is required'
[ "$(/usr/bin/uname -m)" = arm64 ] || fail 'Apple silicon is required'
tmp=$(/usr/bin/mktemp -d "/tmp/farol-release.XXXXXXXX") || fail 'cannot create private temporary directory'
retain=yes
cleanup() {
  if [ "$retain" = yes ]; then
    printf 'Recovery files retained at: %s\n' "$tmp" >&2
  else
    /bin/rm -rf "$tmp"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ "$version" = latest ]; then
  printf '%s\n' 'Finding the newest published stable release...'
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 30 --max-filesize 2097152 --output "$tmp/releases.json" 'https://api.github.com/repos/legrch/farol/releases?per_page=100' || fail 'latest release lookup failed; specify a version explicitly'
  version=$(resolve_latest "$tmp/releases.json") || fail 'latest release lookup failed; specify a version explicitly'
  printf 'Selected Farol %s\n' "$version"
fi
name="Farol-${version}-darwin-arm64.zip"
url="https://github.com/legrch/farol/releases/download/v${version}"
for asset in "$name" farol-release.json SHA256SUMS; do
  printf 'Downloading %s...\n' "$asset"
  if [ -t 2 ] && [ "$asset" = "$name" ]; then
    /usr/bin/curl --fail --show-error --progress-bar --location --proto '=https' --proto-redir '=https' --output "$tmp/$asset" "$url/$asset" || fail "download failed: $asset"
  else
    /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$tmp/$asset" "$url/$asset" || fail "download failed: $asset"
  fi
done
printf '%s\n' 'Verifying the release...'
validate_archive "$version" "$tmp/$name" "$tmp/farol-release.json" "$tmp/SHA256SUMS" "$tmp/extracted" || fail 'release validation failed'
manifest_build_id=$(/usr/bin/python3 -I - "$tmp/farol-release.json" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as stream:
    build_id = json.load(stream).get('buildId')
if not isinstance(build_id, str) or not re.fullmatch('[0-9a-f]{64}', build_id):
    sys.exit(1)
print(build_id)
PY
) || fail 'release build identity unavailable'
app="$tmp/extracted/Farol.app"
plist="$app/Contents/Info.plist"
plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null; }
[ "$(plist_value "$plist" CFBundleIdentifier)" = io.github.legrch.farol ] || fail 'bundle identifier mismatch'
[ "$(plist_value "$plist" CFBundleShortVersionString)" = "$version" ] || fail 'bundle version mismatch'
executable=$(plist_value "$plist" CFBundleExecutable) || fail 'missing bundle executable'
[ "$executable" = Farol ] || fail 'unexpected bundle executable'
# The launcher is a shell script, not a signed Mach-O. Verify the exact
# launcher required by the package contract and the two executable signatures.
cat > "$tmp/expected-launcher" <<'LAUNCHER'
#!/bin/sh
set -eu

launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=${launcher_path%/*}
contents_dir=${macos_dir%/*}
export ELECTRON_FORCE_IS_PACKAGED=true
exec "$contents_dir/Resources/app/farol-backend" run-desktop-launcher "$@"
LAUNCHER
launcher="$app/Contents/MacOS/Farol"
[ -f "$launcher" ] && [ ! -L "$launcher" ] && [ -x "$launcher" ] && /usr/bin/cmp -s "$launcher" "$tmp/expected-launcher" || fail 'launcher does not match package contract'
backend="$app/Contents/Resources/app/farol-backend"
electron="$app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"
for binary in "$backend" "$electron"; do
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || fail 'packaged executable missing or invalid'
done
/usr/bin/codesign --verify --strict "$backend" || fail 'backend signature verification failed'
# Electron ships with a linker ad-hoc signature and no resource seal. Verify
# its executable signature; validate_archive already checked the entire tree.
/usr/bin/codesign --verify --strict --ignore-resources "$electron" || fail 'Electron signature verification failed'
if signature=$(/usr/bin/codesign -d "$app" 2>&1); then
  fail 'outer app is signed; release package contract expects an unsigned outer app'
else
  case "$signature" in
    *'code object is not signed at all'*) printf '%s\n' 'Outer app: unsigned; executable signatures and release tree verified (Electron has no resource seal)' ;;
    *) fail 'cannot determine outer app signing status' ;;
  esac
fi
installed=/Applications/Farol.app
profile="$HOME/Library/Application Support/io.github.legrch.farol/installed-updates"
running() {
  /bin/ps -ww -axo pid=,ppid=,comm= > "$tmp/processes" || return 2
  /usr/bin/python3 -I - "$tmp/processes" "$installed" "$profile" "${1-all}" <<'PY'
import ctypes, os, re, sys
table, installed, profile, mode = sys.argv[1:]
def resolve_executable(pid):
    # macOS can replace the displayed process title with a short name or a
    # project title. Resolve such candidates to the kernel's executable path.
    try:
        proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc.proc_pidpath.restype = ctypes.c_int
        buf = ctypes.create_string_buffer(4096)
        if proc.proc_pidpath(pid, buf, len(buf)) <= 0:
            # A process can exit after the ps snapshot. Skip only a confirmed
            # vanished PID; a live but unreadable process remains a refusal.
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return None
            raise ValueError('cannot resolve live Farol process executable')
        return os.fsdecode(buf.value)
    except OSError as error:
        raise ValueError('cannot resolve Farol process executable') from error
def process_instance(pid):
    # proc_bsdinfo from the macOS SDK (sys/proc_info.h), including the
    # microsecond-resolution kernel start time. A PID alone can be reused.
    class BsdInfo(ctypes.Structure):
        _fields_ = ([ (name, ctypes.c_uint32) for name in
                     ('flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
                      'ruid', 'rgid', 'svuid', 'svgid', 'pad') ] +
                    [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] +
                    [ (name, ctypes.c_uint32) for name in
                      ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid', 'nice') ] +
                    [('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)])
    proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    proc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    proc.proc_pidinfo.restype = ctypes.c_int
    info = BsdInfo()
    if proc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.pid != pid or info.start_sec == 0:
        raise ValueError('production primary instance unavailable')
    return f'{pid}:{info.start_sec}:{info.start_usec}'
found = False
try:
    with open(table, encoding='utf-8') as stream:
        lines = stream.read().splitlines()
    if not lines:
        raise ValueError('empty process table')
    rows = []
    for line in lines:
        match = re.fullmatch(r'\s*([0-9]+)\s+([0-9]+)\s+(.+?)\s*', line)
        if not match:
            raise ValueError('unparseable process table')
        rows.append((int(match.group(1)), int(match.group(2)), match.group(3)))
    # The app's Go launcher is the parent of its one Electron primary. Other
    # Electron binaries in installed-execution are Computer/tunnel children and
    # must not be mistaken for a second application primary.
    if mode in ('main-pid', 'main-instance'):
        def production_bundle(path):
            if path == installed + '/Contents/Resources/app/farol-backend':
                return installed
            match = re.fullmatch(re.escape(profile) + r'/[a-f0-9]{32}/launch-Farol\.app/Contents/Resources/app/farol-backend', path)
            return path[:-len('/Contents/Resources/app/farol-backend')] if match else None
        launchers = []
        for pid, _, title in rows:
            if title == 'farol-backend' or title.endswith('/farol-backend'):
                executable = resolve_executable(pid)
                if executable is None:
                    continue
                bundle = production_bundle(executable)
                if bundle is not None:
                    launchers.append((pid, bundle))
        if len(launchers) != 1:
            raise ValueError('production launcher is not unique')
        launcher_pid, bundle = launchers[0]
        primary = bundle + '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron'
        mains = []
        for pid, parent, title in rows:
            if parent == launcher_pid and (title == 'Farol' or title == 'Electron' or title.endswith('/Electron')):
                if resolve_executable(pid) == primary:
                    mains.append(pid)
        if len(mains) != 1:
            raise ValueError('production application PID is not unique')
        print(process_instance(mains[0]) if mode == 'main-instance' else mains[0])
        sys.exit(0)
    for pid, _, executable in rows:
        if not executable.startswith('/') and 'farol' in executable.lower():
            executable = resolve_executable(pid)
            if executable is None:
                continue
        owned = executable.startswith(installed + '/') or executable.startswith(profile + '/')
        # Explicitly identified Dev and Owner Preview bundles are distinct.
        other = any('/' + name + '.app/' in executable for name in ('Farol Dev', 'Farol Owner Preview'))
        if owned:
            if mode == 'all' or executable.endswith('/Electron Runtime.app/Contents/MacOS/Electron'):
                found = True
        elif not other and (
            os.path.basename(executable).lower() in ('farol', 'farol-backend')
            or '/farol.app/' in executable.lower()
            or '/launch-farol.app/' in executable.lower()
        ):
            raise ValueError('unclassified Farol process')
    sys.exit(0 if found else 1)
except Exception as error:
    print('Process inspection failed:', error, file=sys.stderr)
    sys.exit(2)
PY
}
terminate_owned() {
  /usr/bin/python3 -I - "$installed" "$profile" "$tmp/termination-evidence.json" <<'PY'
import ctypes, datetime, json, os, re, signal, subprocess, sys, time
installed, profile, evidence = sys.argv[1:]
lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
lib.proc_pidpath.restype = ctypes.c_int
def table():
    out = subprocess.run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,stat='], check=True, text=True, capture_output=True).stdout
    result = {}
    for line in out.splitlines():
        m = re.fullmatch(r'\s*(\d+)\s+(\d+)\s+(\S+)\s*', line)
        if not m: raise ValueError('unparseable process table')
        pid, parent, state = m.groups()
        result[int(pid)] = (int(parent), state)
    if not result: raise ValueError('empty process table')
    return result
def identity(pid):
    buf = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, buf, len(buf)) <= 0: raise ValueError('process path unavailable')
    start = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], check=True, text=True, capture_output=True).stdout.strip()
    if not start: raise ValueError('process start unavailable')
    return {'pid': pid, 'path': os.fsdecode(buf.value), 'start': start}
try:
    rows = table()
    roots = []
    def production_bundle(path):
        if path == installed + '/Contents/Resources/app/farol-backend': return installed
        match = re.fullmatch(re.escape(profile) + r'/[a-f0-9]{32}/launch-Farol\.app/Contents/Resources/app/farol-backend', path)
        return path[:-len('/Contents/Resources/app/farol-backend')] if match else None
    for pid, (_, state) in rows.items():
        if state.startswith('Z'): continue
        buf = ctypes.create_string_buffer(4096)
        if lib.proc_pidpath(pid, buf, len(buf)) > 0:
            bundle = production_bundle(os.fsdecode(buf.value))
            if bundle is not None: roots.append((pid, bundle))
    if len(roots) != 1: raise ValueError('production launcher is not unique')
    root_pid, bundle = roots[0]
    owned = {root_pid}
    while True:
        expanded = owned | {pid for pid, (parent, _) in rows.items() if parent in owned}
        if expanded == owned: break
        owned = expanded
    records = []
    for pid in sorted(owned):
        parent, state = rows[pid]
        if state.startswith('Z'): continue
        record = identity(pid)
        path = record['path']
        if not (path.startswith(bundle + '/') or (path.startswith(profile + '/installed-execution/') and '/Farol.app/' in path)):
            raise ValueError('unexpected production descendant')
        record.update(parent=parent, state=state)
        records.append(record)
    with open(evidence, 'x') as f:
        json.dump({'created': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'processes': records}, f, indent=2)
        f.flush(); os.fsync(f.fileno())
    def send(sig):
        current = table()
        for record in reversed(records):
            pid = record['pid']
            if pid not in current or current[pid][1].startswith('Z'): continue
            actual = identity(pid)
            if actual['path'] != record['path'] or actual['start'] != record['start']:
                raise ValueError('process identity changed')
            try: os.kill(pid, sig)
            except ProcessLookupError: pass
    send(signal.SIGTERM)
    time.sleep(10)
    send(signal.SIGKILL)
    time.sleep(1)
    current = table()
    if any(r['pid'] in current and not current[r['pid']][1].startswith('Z') for r in records):
        raise ValueError('production process did not exit')
except (OSError, ValueError, subprocess.SubprocessError) as error:
    print('Production process termination failed:', error, file=sys.stderr)
    sys.exit(1)
PY
}
check_stopped() {
  if running "${1-all}"; then return 1; else status=$?; fi
  [ "$status" -eq 1 ] || fail 'cannot inspect process table'
  return 0
}
existing=no
if [ -e "$installed" ] || [ -L "$installed" ]; then
  [ -d "$installed" ] && [ ! -L "$installed" ] || fail 'installed app path is not a directory'
  [ "$(plist_value "$installed/Contents/Info.plist" CFBundleIdentifier)" = io.github.legrch.farol ] || fail 'existing app identity mismatch'
  if [ "$requested_latest" = yes ]; then
    installed_version=$(plist_value "$installed/Contents/Info.plist" CFBundleShortVersionString) || fail 'installed version unavailable'
    check_latest_version "$installed_version" "$version" || fail 'latest is older than the installed version; specify a version to downgrade'
  fi
  existing=yes
fi
if ! check_stopped; then
  main_pid=$(running main-pid) || fail 'production application identity could not be inspected'
  /usr/bin/osascript - "$main_pid" <<'APPLESCRIPT' || fail 'normal Quit failed or production identity could not be inspected'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcesses to {}
    repeat with candidate in every application process
      if (unix id of candidate) is targetPid then set end of targetProcesses to candidate
    end repeat
    if (count of targetProcesses) is not 1 then error "Production application PID is not unique"
    set targetProcess to item 1 of targetProcesses
    if (unix id of targetProcess) is not targetPid then error "Production application PID changed"
    tell targetProcess to click menu item "Quit Farol" of menu 1 of menu bar item "Farol" of menu bar 1
  end tell
end run
APPLESCRIPT
  count=0
  while ! check_stopped; do
    if [ "$count" -ge 30 ]; then
      terminate_owned || fail 'Farol did not quit; existing app preserved'
      break
    fi
    /bin/sleep 1
    count=$((count + 1))
  done
fi
if [ "$existing" = yes ]; then
  /usr/bin/ditto "$installed" "$tmp/previous.app" || fail 'could not preserve predecessor'
  retain=yes
fi
check_stopped || fail 'production process appeared; existing app preserved'
if [ "$existing" = yes ]; then
  /bin/rm -rf "$installed" || fail 'could not remove old app; predecessor retained'
fi
if ! /usr/bin/ditto "$app" "$installed"; then
  fail 'copy failed; predecessor retained if one existed'
fi
nonce=$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]') || fail 'cannot create launch nonce'
case "$nonce" in
  ????????-????-????-????-????????????) ;;
  *) fail 'invalid launch nonce' ;;
esac
proof="$tmp/startup-proof.json"
suffix=${tmp##*.}
/usr/bin/open "$installed" --args "--farol-install-proof=$suffix:$nonce" || fail 'launch request failed; predecessor retained if one existed'
count=0
while check_stopped main; do
  [ "$count" -lt 30 ] || fail 'launch not confirmed; predecessor retained if one existed'
  /bin/sleep 1
  count=$((count + 1))
done
# A live PID can be held by a modal startup error. Only the new primary can
# publish this nonce-bound proof after its main startup has completed.
count=0
while [ ! -e "$proof" ]; do
  check_stopped main && fail 'Farol exited before startup confirmation; predecessor retained'
  [ "$count" -lt 45 ] || fail 'Farol startup unconfirmed; predecessor retained'
  /bin/sleep 1
  count=$((count + 1))
done
main_pid=$(running main-pid) || fail 'confirmed startup process identity unavailable'
main_instance=$(running main-instance) || fail 'confirmed startup process instance unavailable'
[ "${main_instance%%:*}" = "$main_pid" ] || fail 'confirmed startup process changed; predecessor retained'
/usr/bin/python3 -I - "$proof" "$nonce" "$manifest_build_id" "$version" "$main_pid" "$main_instance" <<'PY' || fail 'startup confirmation invalid; predecessor retained'
import json, os, stat, sys
file, nonce, build_id, version, pid, instance = sys.argv[1:]
before = os.lstat(file)
if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600:
    sys.exit(1)
fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
try:
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
        sys.exit(1)
    data = os.read(fd, 4097)
    if len(data) > 4096:
        sys.exit(1)
finally:
    os.close(fd)
proof = json.loads(data)
if set(proof) != {'schema', 'nonce', 'buildId', 'version', 'pid'} or proof != {
    'schema': 'farol.install-startup-proof/1', 'nonce': nonce,
    'buildId': build_id, 'version': version, 'pid': int(pid),
}:
    sys.exit(1)
_, start_sec, start_usec = (int(part) for part in instance.split(':'))
# A replacement process with a recycled PID starts after the proof file was
# created by the original primary. The original process must predate it.
birth = getattr(before, 'st_birthtime', None)
if birth is None or start_sec * 1000000 + start_usec > int(birth * 1000000):
    sys.exit(1)
PY
confirmed_main=$(running main-instance) || fail 'Farol primary exited after startup confirmation; predecessor retained'
[ "$confirmed_main" = "$main_instance" ] || fail 'Farol primary changed after startup confirmation; predecessor retained'
actual=$(plist_value "$installed/Contents/Info.plist" CFBundleShortVersionString) || fail 'cannot read installed version'
[ "$actual" = "$version" ] || fail 'installed version mismatch; predecessor retained if one existed'
printf 'Installed and running: Farol %s\n' "$actual"
printf '%s\n' 'Farol opened. Check its connection and updates in the app.'
retain=no
