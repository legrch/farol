#!/bin/bash
# Only launch this script through terminal-mac guest keyboard actions.
set -Eeuo pipefail
case "$(/usr/sbin/sysctl -n hw.model)" in VirtualMac*) ;; *) exit 71 ;; esac
stage="$(cd "$(dirname "$0")" && pwd -P)"
run_id="$(basename "$stage")"
case "$run_id" in run-[a-f0-9]*) ;; *) exit 72 ;; esac
report="/Volumes/My Shared Files/control/farol-smoke/$run_id"
mkdir -p "$report"
# The host chooses only closed phase names; no evaluated command payload.
phase="${1:-}"
token="${2:-$phase}"
case "$token" in *[!a-z0-9-]*|'') exit 75 ;; esac
finish() { printf '%s\n' "$1" > "$report/$token.result.tmp"; mv "$report/$token.result.tmp" "$report/$token.result"; }
trap 'finish BLOCKED' ERR
identity() { /usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation");function run(a){return JSON.parse($.NSString.stringWithContentsOfFileEncodingError(a[0],4,null).js)[a[1]];}' "$stage/identity.json" "$1"; }
app_path="/Applications/$(identity name).app"
data_leaf="$(identity dataLeaf)"
inspect() { /usr/bin/osascript -l JavaScript "$stage/inspect.js" "$stage/identity.json"; }
case "$phase" in
  serve)
    limit="$(cat "$stage/timeout")"
    [[ "$limit" =~ ^[0-9]+$ ]] && [ "$limit" -ge 30 ] && [ "$limit" -le 600 ]
    last=""
    until_time=$((SECONDS + limit))
    printf '%s\n' READY > "$report/server.result"
    while [ "$SECONDS" -lt "$until_time" ]; do
      request="$(cat "$stage/request" 2>/dev/null || true)"
      if [ -n "$request" ] && [ "$request" != "$last" ]; then
        [[ "$request" =~ ^[0-9]{4}-(prepare|admit|install|launch|activate|inspect|relaunch|cleanup|stop|import-dev|connection-proof|share-probe)$ ]] || exit 76
        last="$request"
        next="${request#*-}"
        /bin/bash "$stage/guest.sh" "$next" "$request"
        [ "$next" != stop ] || break
      fi
      sleep 0.1
    done
    ;;
  share-probe)
    if /usr/bin/touch "$stage/guest-write-probe" 2>/dev/null; then
      /bin/rm -f "$stage/guest-write-probe"
      finish BLOCKED
      exit 0
    fi
    finish READY
    ;;
  connection-proof)
    /usr/bin/osascript -l JavaScript "$stage/connection-proof.js" "$stage/identity.json" > "$report/connection.json.tmp"
    mv "$report/connection.json.tmp" "$report/connection.json"
    finish READY
    ;;
  import-dev)
    /usr/bin/osascript -l JavaScript "$stage/import-dev.js" "$stage/identity.json" "$stage"
    finish READY
    ;;
  stop)
    finish READY
    ;;
  prepare)
    config="$HOME/Library/Application Support/$data_leaf/farol-state/config.json"
    if [ -f "$config" ]; then
      /usr/bin/osascript -l JavaScript "$stage/no-tunnel.js" "$config" || { finish NEEDS_OWNER; exit 0; }
    fi
    printf '%s\n' no-production-credentials > "$HOME/.farol-vm-smoke-test-only"
    finish READY
    ;;
  cleanup)
    work="$(cat "$report/guest-work.txt")"
    case "$work" in "$HOME"/Library/Caches/farol-vm-smoke.??????) ;; *) exit 74 ;; esac
    [ -d "$work" ] && [ ! -L "$work" ]
    /bin/rm -rf "$work"
    finish READY
    ;;
  admit)
    # Test-only bootstrap marker, never a credential or profile import.
    marker="$HOME/.farol-vm-smoke-test-only"
    if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "no-production-credentials" ]; then
      finish NEEDS_OWNER; exit 0
    fi
    config="$HOME/Library/Application Support/$data_leaf/farol-state/config.json"
    if [ -f "$config" ]; then
      /usr/bin/osascript -l JavaScript "$stage/no-tunnel.js" "$config" || { finish NEEDS_OWNER; exit 0; }
    fi
    finish READY
    ;;
  install)
    # Test-only bootstrap marker, never a credential or profile import.
    marker="$HOME/.farol-vm-smoke-test-only"
    if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "no-production-credentials" ]; then
      finish NEEDS_OWNER; exit 0
    fi
    expected="$(cat "$stage/archive.sha256")"
    actual="$(/usr/bin/shasum -a 256 "$stage/app.zip" | /usr/bin/cut -d ' ' -f 1)"
    [ "$actual" = "$expected" ]
    # No quarantine removal, Gatekeeper override, sudo, or host-side app launch.
    work="$(/usr/bin/mktemp -d "$HOME/Library/Caches/farol-vm-smoke.XXXXXX")"
    printf '%s\n' "$work" > "$report/guest-work.txt"
    /usr/bin/ditto -x -k "$stage/app.zip" "$work/unpacked"
    app="$work/unpacked/$(identity name).app"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = "$(identity bundleId)" ]
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$(cat "$stage/version")" ]
    # Refuse configured package profiles. Guest Dev connection provisioning is separate.
    config="$HOME/Library/Application Support/$data_leaf/farol-state/config.json"
    if [ -f "$config" ]; then
      /usr/bin/osascript -l JavaScript "$stage/no-tunnel.js" "$config" || { finish NEEDS_OWNER; exit 0; }
    fi
    inspect > "$report/before.json"
    /usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation");function run(a){let x=JSON.parse($.NSString.stringWithContentsOfFileEncodingError(a[0],4,null).js);if(x.pids.length)throw Error("PRODUCT_STILL_RUNNING");}' "$report/before.json"
    if [ -e "$app_path" ]; then
      mv "$app_path" "$work/previous.app"
    fi
    /usr/bin/ditto "$app" "$app_path"
    finish READY
    ;;
  launch|relaunch)
    /usr/bin/open "$app_path"
    finish READY
    ;;
  activate)
    /usr/bin/osascript -l JavaScript "$stage/activate.js" "$stage/identity.json"
    finish READY
    ;;
  inspect)
    inspect > "$report/state.json.tmp"
    mv "$report/state.json.tmp" "$report/state.json"
    finish READY
    ;;
  *) exit 73 ;;
esac
