# Installed updater lifecycle

The supported installed slots are exactly `/Applications/Farol.app` and the
trusted OS-account home followed by `/Applications/Farol.app`. First installation
with `tooling/promote-preview.mjs` defaults to `/Applications/Farol.app`; an explicit
`--destination` accepts either canonical slot. It never overwrites an existing app
or receipt. The native promotion launcher retains a legacy default for existing
maintenance callers.

Ordinary Desktop updates select the slot from the exact attested running
`Contents/Resources/app` directory. They do not probe for another copy, normalize
arbitrary paths, trust `HOME`, or fall back after an observation failure. A trusted
standalone controller can explicitly supply `installedResourcesDirectory`; omission
retains its legacy selection. Native updater requests carry the closed
`installLocation` enum (`shared` or `legacy`); omission remains legacy-compatible.
The helper mutates and relaunches that same slot. Each modern operation has an
immutable private `installed-updates/<operationId>/slot-binding.json` record,
using `farol.installed-operation-slot/1`. Its canonical ASCII JSON bytes bind the
operation ID, `installLocation`, and exact source/target build pair. Desktop
publishes it through a pinned directory descriptor with atomic no-overwrite
placement before durable preparation or helper dispatch. Every explicit-slot
helper request verifies it before handoff, journal writes and mutation fences.
Runtime journal/recovery/relaunch readback also verifies the exact slot binding.
Missing, noncanonical, displaced, unsafe or differently bound records stay fenced
from updater recovery, correlated relaunch and mutation. No existing
journal/handoff is opportunistically repaired. An old unbound operation still
requires separately designed maintenance before it can continue; this packet
implements no migration. Ordinary public shared-slot startup alone can use a
historical pending, preparation or settled receipt as an execution baseline
when the retained release/build pair and complete current executable digest
match. It does not create a slot binding, dispatch a helper, change receipts or
admit the old update. Every present binding remains strict, and an unreadable
record is never treated as missing. Pre-dispatch cleanup retains the immutable binding after
removing staged bytes, so a lost final Ready write cannot erase slot authority.
Old helper requests without `installLocation` retain the
legacy-only wire behavior and app/build validation. Receipt and journal schemas remain
unchanged. App content/build digests, user ownership, promotion and updater locks,
atomic swaps, descriptor-bound mutation and unknown-outcome fences still apply.

Ordinary shared-slot startup authenticates the complete executable image from
its independently accepted promotion, settled/pending operation or closed-repair
baseline before Go starts. The Go artifact and Shell support roots come from
this owner-private immutable image, satisfying attestation through the child
lifetime even if the public app pathname is replaced after this trusted startup.

The unsigned preview starts from an owner-selected, trusted installation. Its
outer launcher, embedded Electron runtime and first `main.cjs` execute before
Farol can capture the private image. Snapshot authentication covers the resources
selected by that genuine main process and later child launches; it is not a
pre-execution authenticity check for the first program opened from Applications.
A different administrator replacing the public bundle before a Finder, Dock or
LaunchServices open is outside this preview's initial-code trust boundary. The
host's OS and filesystem permissions govern that initial launch. No Developer ID,
notarization or Gatekeeper admission guarantee is implemented by this snapshot.
A correlated update relaunch uses the retained owner-private `launch-Farol.app`;
that private launch origin differs from an ordinary initial public-slot open.
Changing the distribution trust anchor requires a separate owner decision and
its own platform qualification, not another self-attestation inside replaced code.

Shared-slot tool execution is authenticated before any bundled observer or
package verifier starts. The accepted promotion, settled update, correlated
pending operation or closed-repair generation supplies the expected full tree
digest. A private complete image under `installed-updates/installed-execution/`
binds the executable and scripts; physical ASAR copying and hashing use
`original-fs`. Invalid, displaced or incomplete images never fall back to public
slot code. A target generation can authenticate from its pending operation
before recovery writes its new settled receipt.

Automatic shared-slot relaunch uses a descriptor-copied, independently verified
`<operation>/launch-Farol.app`, retained inside the private operation directory.
The helper publishes its launch intent only after this image is complete and
opens that private application exactly once. It never opens the replaceable
`/Applications/Farol.app` pathname. Correlated startup verifies the private
image, immutable shared-slot operation, helper completion and physical accepted
pair, then supplies its resource origin to the same updater owner. Normal reopen
of this image without the one-shot hint requires the current settled generation
and unchanged public target. Consumed Ready receipts do not invalidate private
executable authority. Private launch images remain retained; this packet adds no
background image garbage collection or replay of an unknown launch. While
running from a retained private launch entry, normal Quit skips installation;
the retained update remains ready without a restart blocker. Idle automatic
installation and explicit installation use their existing successor relaunch.
This prevents a no-relaunch Quit update from stranding that launch entry.

The shared `/Applications` parent must be canonical, root-owned and not world
writable. Group write is allowed only for the standard macOS administrator group
(GID 80). Neither launcher nor helper changes permissions or elevates. This
exception applies only to that shared parent: app, state and staging ownership
checks remain strict. Parent identity is rechecked before placement/publication
and update mutations. UserData remains the OS-account
`Library/Application Support/Farol Next Preview` directory.

The updater is enabled only for the selected installed slot and
its existing owner data directory. Temporary `task run` copies do not update the
installed app. The GitHub channel and package identity are fixed by the release
contract; no source checkout, credentials or local diagnostics are published.

For an idle update, a configured connector is drained without deleting its
saved route. Desktop first reserves configuration/task admission and the promotion
lease. The Computer fence then exclusively excludes file/shell handlers and Codex
dispatch. The existing durable Desktop obligation report runs under those
reservations before any client is stopped; pending edit delivery and unreadable
or changing Desktop journals leave the connector running. The runtime rechecks
the same report after the drain. Pending or unknown mutation records, shell reservations, dispatch locks,
unreadable journals and incomplete task intents block the update. Issued Codex
handles use the existing exact-identity read-only status path; only terminal turns
and an observed idle thread qualify. The selected route must still admit those
reads; an unavailable, expired or mismatched route is not idle. These are bounded
thread snapshots, not a global lock over independent native clients.

After those checks the normal NEW connector/MCP/proxy shutdown must confirm its
owned processes and handlers ended. The external Codex daemon is never stopped.
Workspace grants, task selection, route, credentials and the selected ChatGPT
app remain saved. A failed drain does not launch the updater helper. Later does
not enter this drain at all.

For automatic installation, an open embedded ChatGPT document is admitted only
after a fresh public-DOM observation of an empty usable composer, a visible
enabled Start voice mode
control, and no enabled Send control. Disabled Send alone does not establish
voice readiness; an absent, renamed, disabled or ambiguous voice entry control
leaves admission unknown. Native CSS visibility includes opacity and ancestor
visibility. The entry control must intersect the current viewport and own a
hit at the center of that intersection; clipped or covered controls cannot
supply the positive idle signal. Missing native visibility or hit-test support
also leaves admission unknown. Active
responses, voice sessions, drafts, attachments, popups, pending navigation and
unrecognized controls refuse admission. The observation returns a classification,
never composer or conversation text. Desktop hides the browser views and holds
their native keyboard/mouse input fence while update admission is reserved.
After initial idle proof, the route acquires its own acknowledged debugger pause
and repeats the content-free DOM inspection through `Runtime.evaluate`. A quiet
document receives one inspector `void 0` evaluation so the pending pause has a
statement to stop on; its command reply alone never proves a paused page. The pause
holds ordinary page scripts and their queued timers through asynchronous package
preparation, record writes and helper handoff. An existing debugger or DevTools,
unconfirmed pause, unexpected resume or detach is uncertainty, never idle. No
other debugger session is detached or adopted. Confirmed refusal resumes the
page once before releasing admission; unconfirmed resume keeps admission fenced
until normal Quit and reopen. This returns `UPDATE_BROWSER_RELEASE_UNCONFIRMED`
when no helper is outstanding, not an unknown helper handoff or an offered
recovery operation. Admission and connector restart remain fenced in that
lifetime, with no repeated resume or detach command. An independently unknown
preparation outcome retains its original uncertainty. Ordinary activity probes are not queued into the
paused renderer. The
same document generation and URL are rechecked after package verification and
again after copying, before durable helper dispatch. A failed observation or
late state change attempts to release admission without launching the helper.
Only confirmed release restores normal admission. Standalone
browser windows remain unqualified by this embedded-only path.

If preparation is refused after a confirmed connector drain, Desktop restores
that previously running connector once, after releasing update admission. The
drain revision and runtime binding must still match; changed settings, unknown
stops and previously idle connectors are never repaired implicitly. This uses
the normal connector start, which rechecks executable identity and current
grants, without replaying a task or verification Send. A dispatched or unknown
helper handoff retains admission and does not enter this abort recovery.

A confirmed update drain preserves a previously ready, generation-bound
Computer-only runtime as unreachable with `CONNECTOR_UPDATE_DRAINED`. It removes
live attachment proof. After a confirmed clean shutdown, the production app may
use the existing startup admission to verify the saved executable and start one
new connector generation. Explicit Stop, crash or unknown shutdown, pending
edits, changed grants, unknown connection outcomes and selected Codex routes
continue to exclude automatic resume. Historical completion is not live proof;
fresh readiness must be established. No Send or verification challenge is replayed.

Electron's ASAR filesystem must not reinterpret release bytes. The desktop copy
port uses Electron's `original-fs`, and trusted verifier/readback subprocesses use
`ELECTRON_RUN_AS_NODE=1` plus `ELECTRON_NO_ASAR=1`. The ordinary application keeps
its normal filesystem semantics.

Before discovery and again before update preparation, the measured installed tree
must match durable accepted-package evidence. The first generation uses the normal
installer's private promotion receipt; later generations use the reconciled update
receipt and its exact source/target digest. Version and build labels alone cannot
turn modified installed bytes into an accepted predecessor. Missing, redirected,
malformed or mismatched evidence blocks preparation without launching a helper.

A durable ready record binds the verified archive to an operation before helper
dispatch. Only the helper's exact readiness acknowledgment permits normal Quit.
Unknown acknowledgment or completion never permits another apply. The same child
handle remains observable while the original app is alive, including after a
process metadata readback failure. The actual helper PID is persisted on the spawn
event, before sending helper program/request bytes or waiting for readiness, then
enriched with its start time.
Failure or timeout while recording closes only the unsent pipes; it never sends
a late request or changes an unknown result into permission to relaunch. An
unavailable start time remains null, never invented:
a present PID or failed process observation cannot prove that helper exited.
Only confirmed termination plus an absent journal, unchanged source and exact
staged target (with no predecessor/failed copy) can reconcile a pre-mutation
exit. That restores a deferred ready state without launching another helper.

Before the bundled Go helper allocates ZIP entries, the extractor bounds central-directory
metadata and counts its actual records. This channel accepts single-volume,
non-ZIP64 archives with at most 16 MiB of central-directory metadata and 1 GiB
of expanded content. The app tree's entry/depth bounds also precede extraction
and stay within the installer's limits.

The archive helper is an attested, offline-built native executable. Its resource
filename remains `update-archive.py` for package compatibility; it is executed
directly, not through Python. The package includes its Go and Unicode dependency
notices. The React/Go Dev's external Computer file route now uses Go. The install/swap
helper is the attested Go `farol-backend` too: the runtime selects it with
`selectUpdateHelper` (the same private execution image and adapter as slot-binding
publication) and spawns `run-closed-release-helper` under a transferred promotion lease
or `run-live-release-helper` otherwise. A build without the compiled Go core refuses
apply and restore with `UPDATE_HELPER_GO_CORE_REQUIRED` before any admission, copy,
binding or process and must be updated by hand; a Go capability that fails to qualify
refuses with the existing not-started outcome. Neither ever falls back to Python, whose
`update_helper.py` stays in the tree and package until a separate deletion packet. The
supervised maintainer controller reads the accepted target package's own Go declaration
and refuses before the predecessor quits when there is none. These source changes do not
replace the installed 0.1.11 app.

A pre-readiness refusal is retryable only after that same helper's classified
terminal exit confirms it never crossed the mutation handoff. The app rechecks
the unchanged slot/journal, preserves the refusal receipt, clears only that
pre-mutation intent and releases admission. Before removing the redundant staged
app it durably changes the dispatch intent into the existing preparation cleanup
phase. The small refusal receipt remains outside the copy directory. Interrupted
cleanup stays blocked in that lifetime; startup can reconcile this proven
pre-mutation preparation without requiring already-removed target bytes.
A missing, timed-out or conflicting
terminal result remains unknown and never permits a substitute helper.

A confirmed `not_started` launcher result is separate from an unknown no-PID
outcome. Only the launcher's pre-spawn preflight result or confirmed terminal
native exec failure can establish that no helper existed. Apply rechecks the source and absent journal, records the refusal,
then durably transitions to preparation cleanup before reclaiming its copy. An
interrupted cleanup is reconciled on startup without dispatch. Rollback/recovery
records the same no-spawn proof in its exact restore intent and rechecks unchanged
journal and installed identity before clearing it. A lost proof or unknown close
remains blocked; no-PID alone never permits another attempt.

Normal Quit cancels this updater lifetime's HTTPS requests and waits through the
existing bounded quit drain for download cleanup or durable retention. A completed
verified archive is retained even after its UI closes. A missed drain deadline
records the updater as unconfirmed; it never claims cleanup succeeded.

If the ready-record write fails, an observed absent ready record plus the exact
download intent permits reclaiming the already-owned extraction/archive before
clearing the intent. Only confirmed cleanup reports a retryable persistence failure.
A possibly committed ready record or uncertain cleanup retains the recovery fence.

A rejected download releases its extracted stage and archive bytes before the
download intent is cleared. Archive cleanup opens the issued file without
following links, checks its descriptor identity, and truncates that descriptor;
it never unlinks a path after a metadata check. One empty archive slot is reused
within the updater lifetime, preventing rejected checks from accumulating large
archives. A substituted entry stays untouched. Unknown cleanup preserves the
intent and blocks another download.

The ready record is committed before retention disposes the extraction, so a
crash at that boundary still identifies the exact archive. Before copying an
app for Restart, the same record durably names a preparation operation. Startup
can reclaim that unfinished copy only while the installed source still matches,
no helper/journal exists, and the private operation directory contains only
staged.app. It then physically re-verifies the retained archive. Dispatch is a
separate durable transition; an uncertain dispatch is never treated as preparation.

A ready update keeps only its archive during Later. Successful verification
extractions are released after retention, cold verification and copying into the
helper's operation directory. Explicit Restart re-verifies that same archive.
Unconfirmed extraction cleanup creates a durable obligation and blocks another
verification or helper. At most two abandoned verification directories may be
present before the verifier refuses another allocation; it never deletes an
unreconciled stage simply to free capacity.

An interrupted unlink of the download intent is reconciled only when its exact
build/checksum matches a durable ready record and fresh package verification
succeeds. A mismatched intent or missing ready record remains blocked. No network
request, task or helper is repeated during that reconciliation.

After the running package and predecessor are reconciled with a settled operation,
the archive is reclaimed through its bounded, checksum-verified descriptor. A
zero-length archive reconciles a completed truncation after interruption. Only
then is archive release recorded in the durable receipt. The previous installed
app remains retained; rollback still requires a compatible state reader. No
workspace or settings are reclaimed.

At startup the updater reads the same operation journal and measures the current
slot and predecessor/staged/failed pair. It does not launch a helper while
rendering or silently download a replacement. A settled target offers the measured
predecessor through **Quit & Restore Previous Version** only when the known
state-reader boundary allows restoration. From beta.12, completed supervised
Shell results use format v6, which beta.11 and earlier readers reject. Restoring
those predecessors is blocked before app exchange, including recovery paths;
records are never rewritten or downgraded to make an old reader accept them.
The predecessor bundle and current records remain retained. An interrupted
`rollback_started` journal cannot prove whether the target wrote newer state.
For an incompatible predecessor, **Finish Recovery** can therefore retain the
exact verified current target and its exact `previous.app`, settling forward to
`verified` without exchanging either app. Both identities are rechecked after
Quit under the owner lease. Other incompatible pairs refuse before the helper
authorizes Quit. No journal history or state downgrade is inferred from a missing
launch record. This guard does not qualify rollback compatibility for later
versions. A known interrupted pair offers **Quit & Finish Recovery** only after the original helper PID/start
time has been observed as ended; a permission error or malformed process readback
keeps recovery blocked. Both actions acquire the existing work
admission fences, record their exact dispatch intent, and use the helper's normal
Quit protocol. The helper, not the renderer, owns atomic exchange and reconciliation.
Only a reconciled verified target is automatically relaunched. Cancellation and
rollback leave the restored source closed, with `cancelled` or `rolled_back`
retained. A predecessor can predate the startup lease protocol, so it must not
start while the helper still owns that lease. Independent completion, physical
identity and state-compatibility verification must precede a normal cold launch.
Historical source-launch phases remain readable; observation never repeats them.

Once dispatch intent requires admission to remain held, the runtime retains the
admission handle itself, including its kernel lease, until the process exits.
Returning an unknown result or closing the updater during Quit does not release
that fence. Confirmed pre-mutation refusals still explicitly release admission.
Disposable host tests force garbage collection and verify that a separate process
cannot acquire the real lease after apply, rollback or recovery returns or closes.

Restore dispatch records its own helper PID before request bytes and enriches it
with the observed start time, using the same launch callback as apply. If that
helper is confirmed ended, the journal is unchanged, and the installed build and
accepted companion still match, startup records that interrupted outcome and
clears only that restore intent. It offers the existing explicit rollback/recovery
action without launching another helper. Missing legacy identity, a live or
unobservable PID, changed journal/build/companion, or uncertain cleanup remains
blocked. A null start time permits reconciliation only when the recorded PID is
confirmed absent; it never proves a present process is a replacement.

A restore intent whose result is still unknown stays blocked. A matching changed
terminal journal plus measured running build reconciles it on the next launch.
A rolled-back or cancelled build is not automatically offered again. All prior
payloads and journals remain available; this lifecycle never deletes the
predecessor or modifies workspaces/settings to make an update admissible.

These source tests exercise ports and disposable filesystem state. They are not
proof of a public GitHub download, installed N-to-N+1 upgrade, native relaunch,
configuration preservation or rollback on the owner's live installation. Those
require separate release/update receipts from the accepted packaged candidate.

## Prepared external transition

`tooling/supervised-update.mjs` is an external owner-transition entry, composed
with the existing installed updater. It is prepared source, not an accepted
public installer or an installed-upgrade result. Its bundled entry has been
compiled and exercised with `--help` outside the checkout; apply remains subject
to native helper, accepted-package, state and recovery qualification.

One private, hash-bound selection names the exact source, target, manifest and
local archive. The controller attests resources without executing candidate code,
checks the measured predecessor and existing obligations, acquires the existing
promotion lease, and requests one ordinary Quit. Only the exact predecessor's
confirmed exit and fresh drained receipt permit preservation and staging.
An uncertain Quit, pending update intent or changed identity refuses progression.

The preservation adapter copies the closed app and profile into a private root.
It retains file bytes, POSIX modes and literal symlinks under bounded inventory,
identity and readback checks. A capacity estimate precedes copying; it reserves
no disk space. The private `preservation.json` identifies the source build,
closed lifetime and pair digests without an entry inventory or profile contents.
Receipt presence alone proves neither completed capture nor permission to restore.
Partial copies and uncertain writes stay retained. ACLs, extended attributes,
timestamps and real installed-profile recovery are not qualified by these tests.

The existing updater imports the selected archive, retains its ready intent and
launches the same helper under the inherited lease. The controller retains the
original child before metadata recording and observes its actual terminal result;
an applying view, exit without protocol completion or lost observation is not
success. Supervised apply selects `relaunch:false`. Only a successful original
helper exit at `verified`, followed by a matching measured target slot, returns
`verified_closed`. The controller also rechecks the original closed lifetime,
absent run marker, state-root identity and unchanged Quit receipt after the swap.
That observation does not prevent a later independent app launch.
`launch_requested` and `completed` are outside this closed
transition and remain unknown to this controller. Ordinary installed updates
retain their existing relaunch behavior.

The target stays closed until recovery and state compatibility are separately
qualified. The CLI does not launch it or automatically roll back an uncertain
operation. This route does not yet implement supervised restore. The preserved
profile cannot be blindly restored over updater journals or the promotion-lease
inode; application startup and external Computer require their own checks.

Reporting failures cannot interrupt the updater's drain. The controller settles
the current step, records reporting loss and stops before the next effect where
possible. Once apply starts, it continues observing the original operation.
Final CLI reporting loss returns exit 3 without changing a known lifecycle
terminal or launching a replacement operation.

## Physical staging cleanup

Electron treats ASAR archives as virtual directories through its patched Node
filesystem. Main supplies the same physical `original-fs` boundary for package
removal as for copying. The verifier removes only its own bound extraction root;
prepared-copy and reconciled-download cleanup retain their existing ownership
checks. A cleanup failure still writes the unknown-outcome obligation and fences
updates; this change does not retry or clear an existing uncertain cleanup.

The updater package gate includes a disposable Electron ASAR cleanup regression.
Its verifier response is synthetic, so it proves physical removal semantics and
port composition, not an installed GitHub upgrade or package authenticity.

## Closed Preview repair

A first installed generation can have an unresolved cleanup record without the
extraction-root identity needed for safe reclamation. That is not an update to
retry. The explicit closed-Preview repair tool requires the real normal Quit,
unchanged durable work obligations and the same kernel admission lease before
installing a newly accepted candidate. It preserves the existing application,
normal promotion receipt and configuration. The whole old updater directory is
retained intact under the exact operation's quarantine; its unknown result is
preserved rather than declared reconciled or deleted.

Repair writes a separate `farol.next.closed-repair/1` receipt. The updater accepts
that installed baseline only after checking the fixed slot, exact build/source,
fixed private predecessor location and both physical package identities. The
normal promotion receipt is never rewritten to claim a non-overwriting install,
and no synthetic live-helper or GitHub update receipt is produced. A later real
GitHub upgrade records its own ordinary update journal and installed receipt.

Use the tool only from clean committed accepted candidate bytes, with NEW closed:

Keep NEW closed from its confirmed normal Quit until the repair command has a
terminal result and that result has been read back. The same exclusive owner
window is required for closed rollback. The work-admission lease and repeated
marker checks do not fence concurrent application startup; this one-shot manual
repair does not qualify concurrent launch, including launch of an older bundle.

```sh
node tooling/closed-preview-repair.mjs --expected-predecessor <measured-accepted-digest> --apply
```

The resulting operation ID identifies the preserved predecessor and explicit
closed-Preview rollback. Do not substitute an operation or expected digest after
an unknown result, remove its quarantine or fake a normal Quit. A failed or
interrupted repair remains a recovery obligation until its exact physical pair
and journal can be reconciled by the tool. V0, account state and credentials are
outside this operation. This establishes an installation baseline; it does not
prove the required installed N-to-N+1 GitHub journey.

An unresolved cold-repair journal fences updater admission even when no repair
receipt has been published and the normal installed receipt still matches.
Cold-repair receipt publication is not sufficient for updater admission. The
matching private repair journal must be terminal with the identical receipt.
After interruption between receipt and journal publication, explicit recovery
can reconcile the already-published terminal receipt after a later genuine
normal Quit, only with the same measured installed/predecessor inode/build pair
and quarantine. It performs no second copy or swap. Earlier unresolved phases
retain their original Quit binding.

## Hidden browser idle observation

Retained ChatGPT views receive the current shell viewport before their first
load, including when Settings or Home conceals them. Layout changes keep that
viewport current without attaching, showing or focusing the view. A zero-sized
viewport remains unknown to the idle probe; it is never interpreted as idle.

The exact attachment-entry labels `Add files` and `Add files and more` belong
to one structural control identity. A simultaneous pair is ambiguous, including
a disabled duplicate. Either single native button must remain unexpanded,
unpressed and owned by the composer form. Drafts, attachments, generation,
unknown enabled actions and absent positive voice readiness still block updates.

`node tests/e2e/chatgpt-update-idle.e2e.mjs` checks real Electron hidden and
detached viewport behavior with a disposable public-DOM fixture. It does not
qualify live provider state, installed admission or a completed OTA.

## Confirmed interruption and unified automatic updates

The normal update window has one download-and-install choice. Its new versioned
record carries the explicit scope `download-and-install`; a legacy download-only
boolean does not authorize installation. On the stable UI, legacy choices are
projected OFF without rewriting the historical records. OFF supersedes the old
install-on-quit choice. A durable write fence preserves an unknown preference write across app
lifetimes. The existing independent install-on-quit API remains readable for
compatibility, but is not exposed as a second ordinary setting.

A one-minute readiness tick uses the existing six-hour discovery throttle. With
confirmed unified consent it downloads eligible updates and attempts the normal
idle admission. Known pre-dispatch busy/unknown-browser observations may be
checked on a later tick. Unknown installation, release or package effects remain
retained for recovery and are never repeated. Remind Me Later defers automatic
installation for the current app lifetime.

`restart-confirmed` carries the exact version shown by the confirmation dialog.
It permits closing owned ChatGPT windows without inferring DOM idle, preserves
the conversation address and keeps new input fenced through handoff. A native
close must be observed; a failed close keeps the admission reserved. Internal
programmatic tasks and Computer obligations retain their existing cancellation
and drain owners. Manual consent never turns an unknown operation into success. A prior known
pre-dispatch refusal (`UPDATE_WORK_PENDING`, `UPDATE_CONNECTOR_ACTIVE` or
`UPDATE_TASK_ROUTE_NEEDS_DRAIN`) does not permanently disable the confirmation
button. A fresh version-bound click may acquire the current host admission again;
it still rechecks and drains the same owned work before installer dispatch. A
later uncertain drain, package failure or unknown handoff remains fenced. Saved
notice failures retain their original metadata and acknowledgement fence in
Diagnostics; they do not add technical warnings to the ordinary update dialog.

Starting with 0.2.1 the public release version uses ordinary semantic versions
and the stable GitHub channel. Build numbers still increase, while existing
bundle IDs, product identity, process names and profile paths remain compatible.
The old beta readers stay available for predecessor/recovery evidence. The beta
to stable transition requires a qualified closed replacement because older
installed builds discover only the beta feed; subsequent stable updates use OTA.
