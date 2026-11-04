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
import hashlib, json, os, pathlib, re, shutil, stat, sys, zipfile
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
                os.chmod(dest, (mode & 0o777) or 0o644)
        for key, target in links.items():
            dest = root.joinpath(*key.split('/'))
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(target, dest)
        app = (root / 'Farol.app').resolve(strict=True)
        for key in links:
            resolved = root.joinpath(*key.split('/')).resolve(strict=False)
            if not resolved.is_relative_to(app):
                reject('symlink escapes app root')
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
retain=no
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
/usr/bin/codesign --verify --deep --strict "$app" || fail 'code signature verification failed'
signature=$(/usr/bin/codesign -dv --verbose=4 "$app" 2>&1) || fail 'cannot inspect code signature'
case "$signature" in
  *'Signature=adhoc'*) printf '%s\n' 'Signing type: ad-hoc' ;;
  *'Authority=Developer ID Application:'*) printf '%s\n' 'Signing type: Developer ID Application (reported by codesign)' ;;
  *'Authority='*) printf '%s\n' 'Signing type: certificate-signed (reported by codesign)' ;;
  *) printf '%s\n' 'Signing type: unknown' ;;
esac
installed=/Applications/Farol.app
running() {
  /bin/ps -axo comm= > "$tmp/processes" || return 2
  /usr/bin/awk -v expected="$installed/Contents/MacOS/Farol" '$0 == expected { found=1 } END { exit !found }' "$tmp/processes"
}
check_stopped() {
  if running; then return 1; else status=$?; fi
  [ "$status" -eq 1 ] || fail 'cannot inspect process table'
  return 0
}
if [ -e "$installed" ] || [ -L "$installed" ]; then
  [ -d "$installed" ] && [ ! -L "$installed" ] || fail 'installed app path is not a directory'
  [ "$(plist_value "$installed/Contents/Info.plist" CFBundleIdentifier)" = io.github.legrch.farol ] || fail 'existing app identity mismatch'
  if ! check_stopped; then
    /usr/bin/osascript -e 'with timeout of 30 seconds' -e 'tell application "/Applications/Farol.app" to quit' -e 'end timeout' || fail 'normal Quit failed'
    count=0
    while ! check_stopped; do
      [ "$count" -lt 30 ] || fail 'Farol did not quit; existing app preserved'
      /bin/sleep 1
      count=$((count + 1))
    done
  fi
  /usr/bin/ditto "$installed" "$tmp/previous.app" || fail 'could not preserve predecessor'
  retain=yes
  /bin/rm -rf "$installed" || fail 'could not remove old app; predecessor retained'
else
  check_stopped || fail 'production process exists without an installed app'
fi
if ! /usr/bin/ditto "$app" "$installed"; then
  fail 'copy failed; predecessor retained if one existed'
fi
/usr/bin/open "$installed" || fail 'launch request failed; predecessor retained if one existed'
count=0
while check_stopped; do
  [ "$count" -lt 30 ] || fail 'launch not confirmed; predecessor retained if one existed'
  /bin/sleep 1
  count=$((count + 1))
done
actual=$(plist_value "$installed/Contents/Info.plist" CFBundleShortVersionString) || fail 'cannot read installed version'
[ "$actual" = "$version" ] || fail 'installed version mismatch; predecessor retained if one existed'
printf 'Installed and running: Farol %s\n' "$actual"
printf '%s\n' 'Updater status: not confirmed'
retain=no
