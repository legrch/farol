# Packaged app testing in a macOS guest

The supported finite installed lifecycle uses the explicitly selected native
AppService route below. Hidden is the default; `--visible` shows the same guest.
It requires a compatible independently installed terminal-mac helper and live VZ
evidence that the per-machine artifact share is read-only. It never launches a
host production app or reads its profile. These journeys are separate from
`task test`; see the [VM testing contract](vm-testing.md) for acceptance boundaries.

**Legacy Terminal workflows are BLOCKED.** The current helper does not advertise
`terminal-shell-readiness/1`. The runner refuses before shell typing without that
proof. Frontmost Terminal, Dock coordinates and screenshots do not prove shell
readiness. Finder bootstrap instructions are obsolete and are not a supported
execution route.

## Code, configuration and persistent state

| Owner                 | Location                                                    | Contents                                                                  |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Repository            | `config/vm/farol.json`                                      | Machine resources and interactive setup contract                          |
| Repository            | `tooling/vm-machine.py`, `tooling/vm-smoke*`, Taskfile      | Provisioning, native lifecycle, blocked legacy adapters and offline tests |
| terminal-mac          | `~/Library/Application Support/terminal-mac`                | VM disks, machine identity, restore cache and artifact inboxes            |
| Installed tool        | `~/Applications/TerminalMac.app`                            | Independently installed host tool and guest helper                        |
| Private configuration | `~/Library/Application Support/Farol Testing/vm-smoke.json` | Infrastructure only; no credentials                                       |
| Private evidence      | `~/Library/Application Support/Farol Testing/evidence`      | Results, screenshots, operation and custody records                       |
| Guest profile         | Guest appData product directory                             | Guest-owned identity and configuration                                    |

Runtime state belongs outside source checkouts. The guest receives only the
control share, helper tools and a narrow read-only artifact inbox. Host home and
project folders are not mounted. NAT is not network isolation.

## Provisioning and configuration

```sh
task vm:plan
task vm:setup -- --ipsw /path/to/AppleRestore.ipsw
```

Setup creates a missing machine from explicit restore media or starts an existing
matching machine. It refuses resource/network drift. Install terminal-mac
separately; provisioning does not download tools, supply guest passwords or change
security settings. Account setup, helper installation and privacy grants require
independent guest qualification.

Provisioning publishes durable create-only intents before create, clone and start.
Retained intents block reentry until explicitly reconciled; a timeout never
permits another dispatch. The read-only inventory contacts no VM and clears nothing:

```sh
node tooling/vm-machine.mjs --reconcile-operations <machine>
```

The entry reads `~/Library/Application Support/Farol Testing/vm-smoke.json`, or
`--config` / `FAROL_VM_CONFIG`. Its `vm_home` must be a normalized physical path
inside the canonical terminal-mac store, without ancestor aliases or traversal.
The shared `prepared_base` field selects a qualified base for Dev provisioning;
see [base identity and receipt requirements](vm-testing.md). Legacy bootstrap/menu
coordinates remain configuration data only and cannot satisfy shell readiness.

## Native exact-release lifecycle

Select an archive and application-tree digest from independently accepted release
evidence. Never take the expected digest from the ZIP being admitted.

```sh
task qa:smoke -- --native-app-service --native-relaunch \
  --artifact /path/to/Farol-VERSION-darwin-arm64.zip \
  --expected-app-sha256 <independently-accepted-tree-sha256>
```

Add `--visible` only when visible guest QA is intended. Native mode requires an
explicit local artifact and expected tree digest; it does not support `--latest`,
legacy menu actions, credential import or arbitrary driver execution.

The ZIP needs adjacent `farol-release.json` and `SHA256SUMS`. Admission checks
release identity, archive digest and limits, safe members, plist/artifact binding,
and the independently accepted application tree. Local manifest consistency alone
does not authenticate a caller-supplied artifact. Unsupported layouts refuse before
installation. Signature and quarantine checks remain fail closed.

The helper verifies the complete payload and finite signature policy before
publishing a new guest `/Applications` app. It never overwrites an existing app.
The lifecycle is open, install, launch, activate, normal Quit, optional second
launch/activate/Quit, then close. Every phase needs a bound ACK and a fresh read-only
observation. Running phases require bound launch identity; Quit and close require
both root-exit and UI-primary-exit evidence. Missing, malformed or unconfirmed
evidence stops subsequent effects and preserves pending state and custody records.
A phase enters the completed log only after its observation is admitted.

Successful native closure is reported as `NATIVE_APP_SERVICE_CLOSED_REPORTED`.
Visual review remains `NEEDS_REVIEW`; provider, tunnel, update and live installation
acceptance are separate. Screenshots document pixels without proving those gates.

## Blocked legacy workflows and Dev connection handoff

The following legacy selections are **BLOCKED pending qualified shell readiness**:

- `qa:smoke` without `--native-app-service`, including `--latest` and shell E2E drivers.
- `qa:connect-dev`, the guest Dev credential import route.
- `qa:status`, whose connection proof can bootstrap the guest and activate the app.
- `qa:release-dev`, the legacy Quit and endpoint handoff route.

Dev import and endpoint handoff remain blocked until their execution route is
qualified. The JXA credential importer also refuses with
`GUEST_IMPORT_PERSISTENCE_UNQUALIFIED` before filesystem or credential access:
it has no qualified descriptor-rooted destination admission and no file-plus-parent
fsync primitive. Atomic writes do not establish durable ordering of the guest
uncertainty fence, credential replacement, commit receipt and final clear.
A matching, absent, unreadable or invalid-encoding receipt cannot enable this route.
No credential should be exported merely to exercise this blocked importer.

A returning guest profile may already contain connection state. Native closure does
not qualify its endpoint or authorize host Dev to take over. Never replay a refused
or outcome-unknown connection action. `task vm:dev` is a separate native Dev-app
session with no automatic credential import; see [VM testing](vm-testing.md).

## Evidence, custody and interrupted work

Before product effects, the runner durably publishes the per-VM
`.farol-smoke-pending.json` fence. Initial admission uses no-follow metadata:
dangling symlinks and uninspectable entries do not establish absence. Interrupted,
failed and timed-out effects retain their fence and operation metadata.

The runner also refuses unreconciled staging residue. This strictly read-only
report starts no VM, takes no custody lock and changes nothing:

```sh
task qa:smoke -- --reconcile-staging
```

Reconcile the original operation, ACKs and lifetime before any explicit cleanup.
Removing a fence merely to permit a retry is not reconciliation. The narrowly
accepted initial native `open` refusal with typed `noEffect` can retain its stage
and end its own unstarted fence; that exception never clears unknown effects.

Legacy Quit proof requires classified marker metadata. Only confirmed absence of
`running.json` can establish that no marker remains. Unsafe types, symlinks,
unreadable receipts and inaccessible parents are unresolved. A changed canonical
`last-quit.json` must confirm fresh drain after an observed Quit; GUI disappearance
alone never qualifies installation or endpoint release. These checks do not unblock
the legacy execution route.

Evidence and screenshots remain private. Never retain raw keys in diagnostics or
archive credential staging. Successful cleanup removes only exact owned staging;
it never deletes input archives, VMs or guest profiles. `task vm:test` covers these
admission contracts with disposable synthetic fixtures, not a live VM or provider.
