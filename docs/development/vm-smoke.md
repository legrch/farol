# Packaged app testing in a macOS guest

`task vm:smoke` tests an exact release archive in a dedicated macOS guest. Hidden
is the default; `--visible` shows the same guest desktop. It never launches the
production app on the host or reads the production host profile/tunnel.

## Code, configuration and persistent state

| Owner                    | Location                                                    | Contents                                                                  |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Repository               | `config/vm/pilot.json`                                      | Versioned machine resources and interactive bootstrap contract            |
| Repository               | `tooling/vm-machine.py`, `tooling/vm-smoke*`, Taskfile      | Provisioning adapter, smoke, Dev import and tests                         |
| terminal-mac             | `~/Library/Application Support/terminal-mac`                | VM disks, machine identity, Apple restore cache and per-machine artifacts |
| Installed tool           | `~/Applications/TerminalMac.app`                            | Standalone host tool and unchanged guest helper; no checkout dependency   |
| Local test configuration | `~/Library/Application Support/Farol Testing/vm-smoke.json` | Host paths, VM name, bootstrap/menu points; no credentials                |
| Private evidence         | `~/Library/Application Support/Farol Testing/evidence`      | Per-run results, screenshots and separate visual reviews                  |
| Guest profile            | Guest appData product directory                             | Guest computer/workspace identity and separately imported Dev connection  |

Removing a source checkout must not remove the VM, installed tool, private
configuration, evidence or guest profile. Runtime state belongs in Application
Support, not a Git worktree or source-controlled VM image. The generic VM and
read-only artifact share belong to terminal-mac; product checks belong here.

The installed terminal-mac needs the per-machine read-only `artifacts` share.
Its signed app resources are never a staging directory. The guest sees only the
existing control share, helper tools and that narrow artifact inbox; the host
home and project folders are not mounted. NAT can reach host/LAN services and
is not network isolation.

## Create or resume from the versioned spec

```sh
task vm:plan                         # print commands, no execution
task vm:setup -- --ipsw /path/to/AppleRestore.ipsw
```

Setup creates a missing machine from explicit Apple restore media or starts an
existing matching machine. It refuses resource/network drift instead of resizing,
replacing or deleting an existing VM. Install terminal-mac separately first; this
adapter does not download arbitrary tools or change host security settings.

A new guest still needs the normal macOS account and helper permission setup.
The spec contains no password, TCC approval, autologin credential or security
bypass. Existing guest bootstrap state survives a normal restart. Automatic login
and idle lock choices remain guest-owner settings, not source secrets.

## Private machine configuration

The VM entrypoint selects an already installed Node version declared in
`package.json`, even when the shell starts an older Node. It installs nothing.
The standard private configuration is discovered
automatically. `--config` or `FAROL_VM_CONFIG` selects another file.

```json
{
  "terminal_mac": "~/Applications/TerminalMac.app/Contents/MacOS/terminal-mac",
  "vm_home": "~/Library/Application Support/terminal-mac",
  "vm": "pilot",
  "bootstrap": "finder",
  "terminal_point": [62, 765],
  "menu_point": [1058, 12],
  "timeout": 180
}
```

Coordinates above are examples, not universal defaults. Confirm them against the
current guest screenshot. In `finder` bootstrap, the point is the Finder Dock
icon. The runner opens the fixed system Terminal path through Go to Folder,
opens one dedicated Terminal window, then uses a finite closed-phase request
loop. Later Dock/focus changes do not redirect shell typing. The legacy
`terminal` bootstrap selects a confirmed existing Terminal window or Dock icon.
`--bootstrap-point` and `--terminal-point` are equivalent CLI spellings.

## Test an exact packaged release

```sh
task vm:smoke -- --artifact /path/to/Farol-VERSION-darwin-arm64.zip
task vm:smoke -- --artifact /path/to/Farol-VERSION-darwin-arm64.zip --visible
task vm:smoke -- --latest
```

A local ZIP needs adjacent `farol-release.json` and `SHA256SUMS`. The runner checks
release identity, unsigned/not-notarized declaration, name, size/digest, safe ZIP
entries and plist/artifact binding. Local consistency does not authenticate an
arbitrary caller-supplied manifest; local artifact provenance belongs to its
producer. `--latest` resolves public GitHub Latest and its exact official asset
URLs on that run. Signed/notarized formats require a dedicated future verifier.
No OS quarantine or signing warning is bypassed.

For a new dedicated test guest, add `--prepare-test-guest` once. It records a
guest-only marker after connection admission; it never resets a profile. Unknown
or foreign configured connections refuse. A connection imported by the fixed
Dev-only path below is admitted only while its tunnel matches the guest marker
and no unresolved runtime/verification effect is present.

The bounded scenario proves capture, read-only staging, exact guest install,
initial UI, optional menu, normal Quit with no owned app process remaining, and
one relaunch with new process identity and one normal window. The outer launcher
and nested runtime may coexist, so PID count is not app-instance count. An
existing guest app is normally quit before installation; no force-stop is used.

## Reuse only the approved Dev connection

```sh
task vm:connect-dev -- --visible     # one-time offline ID/key import
task vm:status                      # local guest identity/proof only
```

The import source is the fixed host Dev identity from the product identity
contract. It copies only the configured tunnel ID and the private API-key file,
never host computer ID, folders/grants, runtime receipts, browser cookies or
sessions. No arbitrary profile argument or production source exists. A live
process referring to that exact host Dev profile refuses import. The source is
read-only; replacement/race checks refuse changed files.

The destination is the genuine packaged identity inside the guest. An unknown
operation or a different existing guest tunnel refuses before key/config writes.
A successful import increments the guest connector generation and discards old
local attachment/selection receipts; it does not invent a successful check. The
private key is never printed or placed in command arguments, is mode 0600, and
its host staging copy is removed after guest acknowledgement. Persistent keys
remain only in the existing host Dev store and the guest private store, not the
machine configuration or repository.

Import does not itself start a network tunnel. Use the guest's Connect action
once with saved credentials, save the exact existing ChatGPT app name, then
observe the result. No new ChatGPT app, login, message or account is created by
these tasks. Owner-only authentication/payment stops the scenario.

One Dev endpoint is used sequentially. Before returning to host Dev, use:

```sh
task vm:release-dev                 # normal Quit of only the guest app
# Then use the ordinary host task dev workflow when its own preflight is ready.
```

This preserves the guest profile and VM, does not launch a host app, and does not
silently fall back to production. It is not a global lock on manual launches of
host Dev; do not run two clients on the same Dev endpoint concurrently. A shared
endpoint does not mean a shared computer/profile identity. The package profile
and any future guest Dev profile remain distinct and retain their own proofs.

## Results and limits

`result.json` separates `lifecycle: PASS`, `ui: NEEDS_REVIEW` and remote tunnel
qualification. An agent inspects Setup/returning UI, menu and sensible relaunch
screenshots separately. Menu coordinates only capture an observation. Without a
menu point the menu row stays `NOT_RUN`. Local `vm:status` and `connection.json`
identify the guest profile/build and Dev binding, not an end-to-end provider
receipt. To qualify the route, separately call the explicitly selected Dev
connector and compare its profile/build binding with the guest proof. A catalogue
check does not qualify file reads, writes, shell or all registered tools.

The runner holds a VM-operation lease and bounds host/guest work. It restores no
unknown operation automatically. Failures retain private evidence and mark an
outstanding phase UNKNOWN when needed. Successful cleanup removes exact owned
host staging and guest extraction/predecessor; it never deletes input archives,
VMs or profiles. Hidden stays hidden and visible stays visible. Screenshots and
runtime metadata are private and excluded from the public source branch.

`task vm:test` checks archive/profile/configuration boundaries, the guest
inspector/importer and provisioning plans without real accounts or a VM.
Dev deployment, clean first-install state, updater and embedded provider sign-in
are separate qualification. A configured prepared profile tests returning use,
not a clean installation.
