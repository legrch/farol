# Installed application incident response

An owner report that Farol will not launch, reconnect, or install an update is an
incident. Restoring a usable installed application takes priority over feature
work and broad acceptance or repeated formal review cycles.

## Restore first

1. Establish the exact installed path, version, observed failure, and owned
   process state. Preserve the existing application, profile, workspaces,
   connection settings, journals, and recovery evidence using recoverable moves.
2. Select a known working package or a bounded hotfix. Run relevant regression,
   type, and static checks, inspect the owned diff, and commit coherent source.
   Build with `task package` from clean committed bytes; retain compiler,
   dependency, source, resource, and package attestation.
3. Verify the packaged application's actual startup, normal quit, and reopen
   with disposable state. These checks establish packaged lifecycle behavior;
   they do not establish the installed profile or live connection.
4. Restore the owner's authorized installation promptly. If OTA cannot recover,
   use the explicit replacement path. Prefer `/Applications/Farol.app` when the
   owner has authorized that destination. Keep the previous application and
   recovery evidence until the replacement has been read back and launched.
5. Verify the installed application's startup and connection, then perform
   bounded real Computer checks: files, Bash/Git, process cancellation, and
   reconnect. Record source, packaged, installed, and live results separately.
6. Resume aggregate acceptance and risk-based formal review after restoring
   usability. Report open findings and limitations explicitly. An emergency
   installation does not by itself authorize public release or accepted-main
   advancement.

The Lead should use existing owner grants for diagnostics and installation rather
than repeatedly asking for them. A machine restart interrupts other applications
and requires an explicit owner decision when it is necessary.

## Select the exact installation

Resolve an installed incident by the canonical bundle path, not the display
name. Historical build bundles can also be named Farol, and macOS may select
one of them when asked to open an application by name. For the owner's global
installation, launch only `/Applications/Farol.app` through its outer launcher.
Never launch a historical bundle or its embedded vendor executable as a fallback.

Before interaction or replacement, compare the installed version and source/build
receipt with the actual process paths and the running UI's accepted resource
identity. A visible window or a matching display name alone does not identify
the installed build. Binding to an already running native window is distinct
from executing an embedded vendor runtime directly.

When the owner retires an old installation, stop only its positively identified
processes and remove that exact bundle from the active installation path using
recoverable custody. Unregister the retired bundle's path. Preserve its source,
profile and uncertain-operation evidence. Keep one canonical installed path;
retain replacement custody outside ordinary application launch locations.
Do not alter unrelated Dock entries or choose between identically named icons
without confirming their target identity.

## Preserve uncertain work

Recovery must not replay an operation with an unknown outcome, invent process
cleanup evidence, discard journals, reset credentials, or replace a working
profile with an empty one. When prior write descendants cannot be excluded, use
the explicit preserved-state recovery contract and genuine native evidence.
A failed notice acknowledgement or uncertain idle observation must not alone
prevent a separately authorized manual update; integrity and process ownership
checks remain effective.

## Evidence and follow-up

The recovery backend separates stored archive observations from Computer
readiness. After one Computer store constructor refuses, it can expose only
the existing archive reader when that constructor explicitly confirms that no
native description was acquired or that every acquired description was closed.
Missing receipts, unknown cleanup or unknown publication still refuse startup.
The original component error is retained; the store is not reopened or repaired.
Profile, physical-root, current-owner and archive-claim checks remain effective.

The Desktop consumes the original validated, immutable handshake capabilities.
All five Computer methods must be present together or absent together. In the
archive-only case it sends no Computer deactivation or publication probe, and
folder queries remain unavailable. Partial or broadened recovery surfaces
refuse. A live Computer store still requires its original publication ACK;
unknown publication never selects the archive-only path after dispatch.
Archive data stays `stored_unconfirmed`, with no predecessor drain, effect
settlement, historical identity change or authority inferred from readable text.
Disposable native cases cover a malformed Computer snapshot and an independently
held Computer lock; they do not prove recovery of an existing installation.

Retain the incident's failing observation, selected source and package identity,
representative checks, exact installation result, and first successful live
operation. Each incident should add regression coverage for its actual cause.
Track broader acceptance and deferred findings after restoration instead of
holding the user's working installation behind another complete review ladder.

## Explicit global replacement maintenance

The existing replacement owner accepts the frozen version 1 selection for the
user Applications installation. Version 2 additionally requires an explicit
`installLocation` of `shared` or `legacy`; `shared` selects only
`/Applications/Farol.app`. Both Node preflight and the inherited-descriptor native
owner use the ordinary promotion library's shared-parent checks. No arbitrary
destination or legacy bundle identity is admitted.

Replacement retains the previous bundle, promotion receipt and updater tree,
including accepted private execution images, without claiming old operations
settled. A fresh updater with no update/download history can have no ready or
last-update records. A missing half or historical work without its records
remains unconfirmed and refuses replacement.

If that untouched updater has never created its mutex, the separately selected
`prepareCleanReplacementLock` maintenance action may create only its empty lock
after confirmed closed-app admission under the promotion lease. Its attested
native child uses held private directory descriptors, exclusive creation, file
and directory sync, and independent named-file readback. It writes no update
result, journal, old ACK or cleanup receipt. An unknown child/publication retains
the original owner and lease. Select a fresh replacement snapshot only after
this preparation completes; a visible lock file alone cannot settle an unknown
preparation. Ordinary plan-only replacement does not initialize that lock.

## Cold backend startup deadline

The desktop uses a bounded 15-second budget for the original Go startup,
including Shell metadata delivery and the first handshake. Runtime attestation
and retained journal initialization can exceed the ordinary two-second RPC
budget on a cold launch. Ordinary operation deadlines remain unchanged. A late
or missing startup response stays outcome-unknown; increasing the budget never
retries a failed startup or settles its retained run marker.

Before that spawn, the host qualifies its compiled resources and the nested
Shell runtime within one separate 10-second budget
(`CORE_QUALIFICATION_BUDGET_MS`). That work hashes about 320 MiB, which takes
about 0.3 seconds on an idle Mac but measured 2 seconds on a busy launch. The
former 2-second budget therefore refused one start in fifteen. The two budgets
run in sequence, so a cold launch spends at most 25 seconds of budget before it
either becomes ready or refuses. The qualification deadline is checked between
filesystem operations and does not interrupt one that is already pending, so a
stalled filesystem call can hold a launch past that sum. The qualification budget is liveness only: digests and
the final file-identity recheck decide integrity. A spent budget refuses with
`core_resources_deadline_expired` or `shell_runtime_deadline_expired`, never
with the unqualified code, and is not retried; the user opens the app again.
Qualification time is not taken from the child's budget, because a shortened
handshake would turn a slow but working launch into an outcome-unknown failure.

## Idle settings poll after a desktop delay

A delayed desktop event loop can make an expired timer run before an original settings or browser poll reply already waiting on stdout. The client allows both reciprocal poll lanes one IO observation turn for that original response, retaining its exact correlation and sending no replacement request; the storage pump retains its own empty-poll check. Only a validated empty response of the correct poll shape from the same Go generation can resume polling after the deadline. The fired timeout remains authoritative even if the wall clock moves backward. A late command never reaches physical storage, even when the command's own deadline would still permit it. Missing, malformed, crossed or changed-generation responses still fence delivery; ordinary RPC, storage-write and reply-ACK deadlines keep their existing unknown-outcome behavior. No fence is cleared and no write is replayed.

The native pipe regression blocks the Node event loop for 16 seconds with a controlled empty peer response. It proves queued-IO recovery for that boundary, together with deterministic expired-command and missing-response cases. It does not establish the cause of a historical incident, Electron file-picker behavior, Go state reconciliation, startup-marker recovery or installed application acceptance; those require their own disposable native witnesses.

The Go storage exchange treats readiness as a wake-up, retaining the original command in its pending slot until a valid poll acquires it. It checks the poll's cancellation and deadline together with the command's original deadline under the delivery lock. Expiration before this admission returns an empty poll without consuming, replacing or renewing that command; a subsequent valid poll may receive it once. A command already issued to the host still retains the existing lost-reply and unknown-write fences. Go regression tests cover expiry and cancellation during lock contention, unchanged command identity/bytes/deadline, and concurrent poll delivery followed by quiescence. They exercise the reciprocal storage port, without physical configuration writes or proof of Electron or installed recovery.

The explicit packaged native startup harness mode `--settings-idle-delay --reopen` blocks the real Electron main loop for 16 seconds in each of two disposable same-profile lifetimes, checks unchanged Go lifecycle bytes and ready Settings, and requires confirmed ordinary Quit before reopening. It retains bounded browser-failure diagnostics and readiness classifications; failed or uncertain profiles are preserved without another launch. This synthetic-provider scenario does not exercise a native file picker, lost write, Force Quit, tunnel interruption, arbitrary descendant cleanup or the installed production profile.

## Withdrawal during execution resource recheck

The original asynchronous resource recheck remains part of the admitted startup.
After it returns, connector Configure and local runtime spawn must recheck
Quit/update/stop and the original transport observation epoch before dispatch.
Stop or Quit while that filesystem check is pending must produce no later
native launch. Resource validity does not establish current admission. The
source-level host fixtures exercise this pending phase separately from real
resource attestation and installed process evidence.

## Public source changes while a private runtime is running

Execution resource validation and updater source validation are separate ports.
An accepted private image remains executable when the public application slot is
replaced. Before a new update can capture execution and reach Quit, its origin
also checks the current `/Applications/Farol.app` against the accepted source
build/digest. A changed public source refuses that update before helper or Quit;
it does not invalidate the still-running private resources. Hint-based, settled
private and ordinary shared origins supply this check. The native helper retains
its final source check because another administrator is not excluded by the
application's private lease.

## Local runtime shutdown ownership

The Node IPC runtime retains its original child lifetime until `close` confirms
exit 0 without a signal, or the original exit and IPC disconnection are both
observed with no parent-owned stdio streams remaining. Node can omit `close`
when the parent disconnects IPC. Quit includes that lifetime in the same
bounded drain as other owned services. A shutdown message, its send callback,
IPC disconnection, or an `exit` event alone does not confirm closure. Failed or
forced termination remains an unconfirmed Quit obligation. The child installs
shutdown, disconnect and SIGTERM handlers before its asynchronous initialization;
a late startup result is closed rather than published after parent loss. This
root-process observation does not qualify arbitrary descendant cleanup.

## Shared replacement completion observation

After hashing the held candidate descriptor, replacement rechecks the named
application, new receipt and retained custody against their captured identities.
The same checks run before intent retirement and after the original retirement
readback. A displacement during verification retains the original pending fence;
a failed post-retirement observation publishes the existing uncertainty fence.
Completion is a bounded observation, not permanent exclusion of later changes
by another administrator. No displaced operation is repeated or rolled back.

## Retained private launch processes

Closed-app replacement checks the entire selected profile's `installed-updates`
namespace, including operation-owned `launch-Farol.app` images and authenticated
`installed-execution` snapshots. A process using either location blocks custody
before publication of the replacement intent. The canonical slot and native Go
and connector state roots keep their separate process checks.

## Resource manifest wire compatibility

Schema 1 retains the historical `electron-utility-process` discriminator because
installed package verifiers compare the complete resource contract. The active
implementation uses Node IPC as documented above. Renaming that wire value would
make existing installed verifiers reject the next package; a future discriminator
change needs a separately qualified versioned consumer transition.

## Connector internal preparation withdrawal

Configure, Doctor and Start carry the caller's original synchronous admission
check. Configure checks it after resource validation and directory preparation,
then immediately before init. The production anchor starter checks it after
executable/resource validation and immediately before spawn. Quit, update or
withdrawal of the original recovery observation therefore refuses a late native
dispatch even when the accepted image remains intact. A pre-dispatch withdrawal
is classified as not started, never an unknown spawn or profile-write result.

## Shared custody preparation and copied roots

Replacement prepares and opens its custody directory beneath the pinned private
profile before publishing that same inode into Applications with exclusive
rename. Intent writes use the held private descriptor; an unrelated directory
substituted at the shared name is never adopted as custody. Failed preparation
stays retained and is not reused or retried. Named identity checks remain bounded
observations, not permanent exclusion of another administrator.

Execution capture rejects a copied root symlink before changing permissions and
uses a no-follow directory descriptor for the mode change. The connection guide
loads its document from the same authenticated private origin as the renderer,
so delayed guide loads do not consult a replaceable public bundle.

## Connector polling observations

The explicit Check connection action keeps local readiness, helper-reported polling and external attachment separate. Its metrics adapter reads only the original active child's private loopback `/metrics`, with a one-second abort, no redirects and a 256 KiB/4,096-line bound. It projects only unique numeric reports for `commands_poll_cycles_total`, `commands_poll_errors_total` and `commands_poll_last_successful_timestamp_seconds`; labels, raw bodies, upstream error text, credentials and caller-selected URLs are excluded. Missing, invalid, ambiguous or unsupported metrics remain unobserved.

The existing Go connector owner handles `computer.connector.polling` as a read-only Query on the inherited desktop pipe. It is absent from the external connector endpoint. Original binding/current-owner guards remain required; pending, withdrawn or uncertain owners cannot be restored by a positive sample. Go uses its own injected clock to distinguish a helper-reported success within 90 seconds, an older success, an explicit zero/no-success report, and unknown or future time. This diagnostic neither changes Settings/journals nor grants attachment, permission, replay, restart or clean-retirement authority. The host and renderer recheck the original runtime and generations before displaying the observation. A delayed completion after Stop, owner replacement or terminal child observation is withheld.

The new polling Query retains its original five-second host budget and one-shot request ID. A stalled main loop may run its timer before an original reply already waiting on stdout; the client allows one IO observation turn to settle only that exact pure read. A complete valid response with the original context, binding, samples and state shape is discarded after expiry, returning a known expired-observation refusal while preserving the original bridge. It never publishes late positive polling evidence, resends the request, renews authority or clears an effect fence. A fired timeout remains authoritative through clock rollback. Missing replies and late protocol errors, malformed/crossed data or generations still fence the bridge. All other ordinary RPC, write, command and ACK deadlines keep their existing behavior. The host rechecks the same runtime/owner before reporting expiry; an owner change still withholds that receipt.

Metrics HTTP 503/504 or stale polling do not enter the local health watcher's recovery port. This observation adds no automatic proof refresh or reconnection behavior. Controlled Go policy/boot mapping, HTTP parsing, original-child doubles and DOM cases qualify their stated source boundaries only; actual packaged Electron/Go outage/sleep, live helper compatibility, installation and external-call acceptance remain separate gates.

The explicit Dev native witness `node tests/e2e/connector-polling.e2e.mjs --run-native` requires clean current Go-selected bytes produced by `task package` and verifies the attested development entry, isolated HOME/AppData proof, original hidden Electron/Go child and synthetic helper. It drives normal configuration and actual React Check local connection, stale/no-success/missing/503/504 metrics, a 16-second main-loop stall during held HTTP, ordinary clean Quit and one same-profile successor. A separate fresh invocation with `--go-callback-delay` pauses only the exact original Go PID, starts the explicit check, blocks the main loop and resumes that same Go child to expose queued-RPC deadline behavior. Neither case exercises a live control plane or actual OS sleep; failed/unknown profiles and original reports are retained without replay, a second Quit or an owner-beta acceptance claim. The existing owner-beta lifecycle gate remains unchanged.
