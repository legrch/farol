# Packaged app smoke in a macOS guest

`task vm:smoke` drives a dedicated logged-in macOS VM through terminal-mac guest
keyboard, pointer and screenshot actions. Hidden is the default; `--visible`
shows the same guest desktop. This command never launches the app on the host,
reads a host app profile, imports credentials or changes a tunnel target.

The machine needs the packaged terminal-mac host executable with its guest tools,
a running installed guest helper with Accessibility and Screen Recording, and an
already prepared guest account. The runtime can start an existing stopped VM; it
does not create or delete machines or force-stop them. A guest login or OS security
prompt can block a run and must be handled through the ordinary guest workflow.

## Run an exact archive

Use the declared Node toolchain. For repeated runs, put infrastructure-only
settings in a private JSON file outside the repository:

```json
{
  "terminal_mac": "/absolute/path/TerminalMac.app/Contents/MacOS/terminal-mac",
  "vm_home": "/absolute/path/dedicated-vm-data",
  "vm": "pilot",
  "terminal_point": [100, 700],
  "menu_point": [1000, 12],
  "timeout": 180
}
```

The coordinates above are illustrative, not working defaults. Then run one task:

```sh
task vm:smoke -- --config /absolute/path/vm-smoke.json --artifact /absolute/path/Farol-VERSION-darwin-arm64.zip
# Same scenario, visible:
task vm:smoke -- --config /absolute/path/vm-smoke.json --artifact /absolute/path/Farol-VERSION-darwin-arm64.zip --visible
```

`FAROL_VM_CONFIG` can select that file instead of `--config`. Never put a profile,
credential or tunnel in this infrastructure file. Or supply explicit paths:

```sh
task vm:smoke -- \
  --artifact /absolute/path/Farol-VERSION-darwin-arm64.zip \
  --terminal-mac /absolute/path/TerminalMac.app/Contents/MacOS/terminal-mac \
  --vm-home /absolute/path/dedicated-vm-data \
  --terminal-point X Y
```

The ZIP needs its adjacent `farol-release.json` and `SHA256SUMS`. The runner
checks the documented public release handoff: repository/channel/platform,
unsigned/not-notarized declaration, archive name, size, checksum and digest. It
rejects unsafe archive entries before extraction. This does not authenticate an
arbitrary user-supplied manifest; the caller owns local artifact provenance.
Signed/notarized formats require a future explicit verifier, never a bypass.

Use `--latest` instead of `--artifact` to resolve current public GitHub Latest and
download exactly its named assets from the official release URL. Artifact
verification is separate from source/package attestation; this smoke does not
replace the package producer or release acceptance gates.

The required `--terminal-point X Y` identifies an exposed guest Terminal window or its Dock icon from a
current screenshot. Confirm this point in the guest screenshot before running. The runner creates
one dedicated guest Terminal window, then exchanges closed phase requests over
the share, so later Dock changes do not affect input. It does not guess focus
using Spotlight.

Add `--visible` to observe. Optional `--menu-point X Y` clicks the guest menu icon
at coordinates established from a current screenshot; it is not a universal
coordinate or automatic menu locator. Without it the menu row is `NOT_RUN`.
`--evidence DIR` selects the private output root (default `_output/vm-smoke`).
`--timeout SECONDS` sets a bounded deadline, 180 seconds by default, at most 600.

## Guest state and connection policy

On the first use of a dedicated test guest, add `--prepare-test-guest`. It writes
only a guest-local test-only marker after checking that any existing package
configuration has no configured tunnel/runtime/credential. The ordinary run also
requires this marker and rechecks configuration before installation. A configured
or unknown connection returns `NEEDS_OWNER`; no profile is reset or copied.

The installed product keeps its genuine bundle identity and guest package
profile. Dev has a separate identity/profile. Production host profiles and tunnels
are excluded, and the command does not read any host credential store. There is
no supported profile override that makes a genuine release reuse the Dev profile.
A shared Dev tunnel across the two guest identities needs a separately qualified,
sequential connection workflow. That is not implemented here; this runner does
not connect, redirect or claim to test a live tunnel. A working host Dev connection
is not permission to move its live endpoint into the guest.

## Scenario and evidence

The host stages the exact ZIP and closed guest scripts beneath the existing
read-only tools share. A single closed-script bootstrap command is typed into guest Terminal through
the guest helper; later phases run through a per-run finite request loop; no host desktop API is used. The guest script refuses to run outside a
VirtualMac. It checks the digest again, verifies the unpacked bundle ID/version,
requests normal Quit of an existing exact guest install, preserves it temporarily,
and installs only into guest `/Applications`.

The bounded lifecycle is initial launch, one normal Quit with no matching app
process remaining, and one relaunch with new process identity and exactly one normal app
window. The outer launcher and nested runtime may coexist; process count alone
is not a count of app instances. Screenshots cover preflight, initial UI, optional menu, Quit and relaunch.
Inspection uses guest NSWorkspace/CoreGraphics, not host Accessibility. Temporary
guest Terminal windows are not counted as product windows.

`result.json` distinguishes `lifecycle: PASS` from `ui: NEEDS_REVIEW` and
`tunnel: NOT_RUN`. An agent must inspect the actual images for Setup/returning UI,
menu and sensible relaunch state and record its separate visual verdict. Never
promote lifecycle-only evidence to a complete UI/tunnel PASS. A timeout or failed
guest command is `BLOCKED`; an owner-only prerequisite is `NEEDS_OWNER`. No
unknown-effect launch, connection or provider send is automatically replayed.

The command holds one VM smoke lease. It removes only its exact host staging and
its guest extraction/predecessor after confirmed successful completion. Failed or
unknown runs retain staging for investigation. Input archives are never deleted.
The VM remains running; hidden stays hidden and visible stays visible. This does
not restore a previously visible window automatically or alter the user's other
VM windows. Treat evidence as private; do not publish guest screenshots or state
without checking their contents.

## Validation

`task vm:test` runs archive admission and runner-boundary tests without a desktop,
production profile or network. Real guest hidden/visible runs are separate live
evidence. Dev deployment, automatic UI semantics, clean-install state, updater,
provider login and live tunnel qualification are separate work.
