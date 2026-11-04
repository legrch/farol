#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

usage='Usage: scripts/install-release.sh <version>'
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
valid_version() { printf '%s\n' "$1" | /usr/bin/grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; }

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
[ "$#" -eq 1 ] || { printf '%s\n' "$usage" >&2; exit 2; }
[ "$1" != '--help' ] || { printf '%s\n' "$usage"; exit 0; }
valid_version "$1" || { printf '%s\n' "$usage" >&2; exit 2; }
version=$1
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'macOS is required'
[ "$(/usr/bin/uname -m)" = arm64 ] || fail 'Apple silicon is required'
name="Farol-${version}-darwin-arm64.zip"
url="https://github.com/legrch/farol/releases/download/v${version}"
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
for asset in "$name" farol-release.json SHA256SUMS; do
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$tmp/$asset" "$url/$asset" || fail "download failed: $asset"
done
validate_archive "$version" "$tmp/$name" "$tmp/farol-release.json" "$tmp/SHA256SUMS" "$tmp/extracted" || fail 'release validation failed'
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
  /bin/ps -ww -axo pid=,comm= > "$tmp/processes" || return 2
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
            raise ValueError('cannot resolve Farol process executable')
        return os.fsdecode(buf.value)
    except OSError as error:
        raise ValueError('cannot resolve Farol process executable') from error
found = False
main_pids = []
try:
    with open(table, encoding='utf-8') as stream:
        lines = stream.read().splitlines()
    if not lines:
        raise ValueError('empty process table')
    for line in lines:
        match = re.fullmatch(r'\s*([0-9]+)\s+(.+?)\s*', line)
        if not match:
            raise ValueError('unparseable process table')
        executable = match.group(2)
        if not executable.startswith('/') and 'farol' in executable.lower():
            executable = resolve_executable(int(match.group(1)))
        owned = executable.startswith(installed + '/') or executable.startswith(profile + '/')
        # Explicitly identified Dev and Owner Preview bundles are distinct.
        other = any('/' + name + '.app/' in executable for name in ('Farol Dev', 'Farol Owner Preview'))
        if owned:
            if executable == installed + '/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron' or (
                executable.startswith(profile + '/') and
                executable.endswith('/launch-Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron')
            ):
                main_pids.append(int(match.group(1)))
            if mode == 'all' or executable.endswith('/Electron Runtime.app/Contents/MacOS/Electron'):
                found = True
        elif not other and (
            os.path.basename(executable).lower() in ('farol', 'farol-backend')
            or '/farol.app/' in executable.lower()
            or '/launch-farol.app/' in executable.lower()
        ):
            raise ValueError('unclassified Farol process')
    if mode == 'main-pid':
        if len(main_pids) != 1:
            raise ValueError('production application PID is not unique')
        print(main_pids[0])
        sys.exit(0)
    sys.exit(0 if found else 1)
except (OSError, UnicodeError, ValueError) as error:
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
    for pid, (_, state) in rows.items():
        if state.startswith('Z'): continue
        buf = ctypes.create_string_buffer(4096)
        if lib.proc_pidpath(pid, buf, len(buf)) > 0 and os.fsdecode(buf.value) == installed + '/Contents/Resources/app/farol-backend':
            roots.append(pid)
    if len(roots) != 1: raise ValueError('production launcher is not unique')
    owned = {roots[0]}
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
        if not (path.startswith(installed + '/') or (path.startswith(profile + '/installed-execution/') and '/Farol.app/' in path)):
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
  existing=yes
fi
if ! check_stopped; then
  main_pid=$(running main-pid) || fail 'production application identity could not be inspected'
  /usr/bin/osascript - "$main_pid" <<'APPLESCRIPT' || fail 'normal Quit failed or production identity could not be inspected'
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcesses to every application process whose unix id is targetPid
    if (count of targetProcesses) is not 1 then error "Production application PID is not unique"
    tell item 1 of targetProcesses to click menu item "Quit Farol" of menu 1 of menu bar item 1 of menu bar 1
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
/usr/bin/open "$installed" || fail 'launch request failed; predecessor retained if one existed'
count=0
while check_stopped main; do
  [ "$count" -lt 30 ] || fail 'launch not confirmed; predecessor retained if one existed'
  /bin/sleep 1
  count=$((count + 1))
done
actual=$(plist_value "$installed/Contents/Info.plist" CFBundleShortVersionString) || fail 'cannot read installed version'
[ "$actual" = "$version" ] || fail 'installed version mismatch; predecessor retained if one existed'
printf 'Installed and running: Farol %s\n' "$actual"
printf '%s\n' 'Updater status: not confirmed'
retain=no
