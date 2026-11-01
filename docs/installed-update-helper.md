# Installed Farol update helper

This is the narrow N → N+1 replacement mechanism for the **NEW** `io.github.legrch.farol` app. It is not the release feed, package verifier, promotion authority, active-work drain, or acceptance ledger. Initial installation still uses the existing promotion flow. No Git checkout, V0 path, privileged install, Gatekeeper setting, or quarantine change is used.

## macOS launcher lifetime

The packaged outer launcher starts the compiled backend's
`run-desktop-launcher` mode before Electron. This LaunchServices root runs no
updater policy and owns no profile, journal or promotion lease. Electron is
still the actual predecessor PID/start token. Before the existing helper request
is sent, the desktop durably records the original spawn and sends a private,
bounded binding on Electron fd7. The root observes that helper's kernel lifetime,
rechecks its parent and microsecond start identity, and echoes the binding on
fd8. The helper's request/ACK fd3/4 and closed lease/continue fd5/6 are unchanged.
The same absolute readiness deadline covers this transfer; a late/lost ACK
cannot authorize another helper or a request after the bound.

Normal Electron Quit leaves this root alive until every enrolled original helper
has an exit event. Signal forwarding and the sole Electron reap share one owner,
so forwarding never uses a reaped PID. An explicit root termination is an abort,
not helper success. If kernel observation fails, new enrollment closes and the
root retains uncertain lifetime custody until explicitly terminated; it neither
guesses completion nor starts a replacement observer or helper.

The package producer and verifier bind the same exact outer-launcher bytes.
The corrected launcher must be in the running seed as well as its successor.
A green source or disposable lifecycle test does not qualify packaged startup,
Dock/Quit, installed apply, target readiness or live connection. Existing release
tags/assets remain immutable.

Current beta qualification covers matching English process-start tokens in the
caller and native helper contexts. Localized `LC_TIME` and custom `TZ` contexts
remain unqualified; a mismatch refuses enrollment before the helper request.
Saved process-start tokens remain opaque. Do not normalize historical marker
readers or rewrite saved tokens to make an update proceed. The native helper's
existing process observer also has its own fixed locale, so changing only the
guardian formatter would not qualify localized OTA.

## Unsigned beta reliability contract (2026-10-22)

The active Go live helper keeps the atomic App/Staged exchange and saves the
source as `previous.app`. It verifies tree content plus Info.plist/build identity;
ctime, mtime and atime changes do not invalidate verification. After a confirmed
swap, controlled errors trigger a fenced rollback to the original source and a
`rolled_back` journal. Unknown native effects, lost custody or an unverifiable
source remain fenced rather than risking another exchange.

A requested relaunch opens the absolute installed slot after `verified`, and
opens the restored source after `rolled_back`. Target launch journals
`launch_requested` → `completed`; source launch journals
`rollback_launch_requested` → `rollback_completed`. Launch outcome unknown is
never retried. A zero exit from `open` is not proof of GUI startup.

Each phase is logged to the operation's `helper.log.jsonl` with only phase,
classified code, UTC timestamp and helper PID. The log is best effort; diagnostic
failure cannot block rollback. It contains no profile contents or absolute paths.

Startup follows the [desktop startup invariant](#desktop-startup-invariant) for
every journal phase after confirming the relevant helper ended: installed target
content means `completed`, source content means `rolled_back`, and neither means
refusal. It rechecks installed content and journal before publishing settlement,
reclaims the retained archive, and keeps companion bundles and diagnostics.
A pre-mutation helper exit with no journal also settles by installed content;
the operation remains in the saved receipt and its staged copy stays evidence.
Only actual file absence permits this case; a present JSON `null` journal is
malformed evidence and remains untouched. No user recovery action is needed for
either known installed build. This Go contract supersedes
the strict Quit/explicit recovery and source-stays-closed historical behavior
below. D16 replaces this temporary updater with the standard signed updater once
Developer ID is available.

## Caller contract

The release/boot owner must first authenticate and verify the downloaded release asset and extracted app, reconcile every active Computer/task/provider/connector operation, hold the existing promotion lease, reconcile its obligations, and bind the exact accepted N and N+1 build IDs, versions, and tree digests. The `drain` record in this API is a required assertion of that completed work, not a second truth store. The caller must hold the existing promotion lease through normal Quit; the helper acquires that same kernel lease after the process exits and holds it through every mutation. The caller captures the actual installed app PID and `/bin/ps -o lstart=` value **while it is alive**, dispatches the attested helper, awaits its bound `waiting_for_exit` acknowledgment (`status: ready`), then performs a normal coherent Quit. A spawn or pipe write alone never authorizes Quit. An absent or mismatched PID at initial observation is refused. The helper verifies the owning `running.json` marker matches that PID and start time, then waits up to the requested bound (normally 120 seconds) for that exact process to exit. The exact captured predecessor marker, if left behind, or an unclean/missing Quit receipt is recorded as `code: "predecessor_drain_unconfirmed"` in `helper.log.jsonl` and does not abort a bundle update. A changed, foreign or unreadable marker refuses admission and every subsequent effect fence under the promotion lease. Drain diagnostics never extend the strict `/1` journal: a restored predecessor must be able to read every phase, including interrupted compensation, cancellation and manual rollback. Profile data is not part of the swap. A live/unknown process or held/replaced lease inode still refuses. The helper never kills the app or another process.

**Selection (current).** The desktop runs the attested Go release helpers and no longer has a Python alternative. `startInstalledUpdateHelper(selection, request)` in `src/modules/release/infra/native/installed-update-helper.ts` takes an `InstalledUpdateHelperSelection`: either `{ kind: "go", helper }`, whose `qualify()` re-measures the bundled `farol-backend` against the build's compiled declaration inside the build's private execution image (the same adapter and snapshot as slot-binding publication, `selectUpdateHelper` in `installed-update-runtime.ts`), or `{ kind: "refused", reason }` for a legacy build (`helper_go_core_required`) or a capability that failed to qualify (`helper_preflight_failed`). It starts `[<qualified farol-backend>, "run-closed-release-helper"]` when a promotion lease is transferred and `[<qualified farol-backend>, "run-live-release-helper"]` otherwise, detached, in `/` with `{LANG, PATH}` only, stdin and stderr ignored, fd1 the one terminal line, fd3 the request, fd4 the acknowledgment and, for the closed mode, fd5 the borrowed lease and fd6 the continuation. No program or request bytes go over stdin. After the child closes, the launcher measures the executable again with `remeasure()`: the same image and executable checks, without the caller's effect fence, because a normal-Quit fence has already ended while the detached helper ran; a changed or unverifiable image marks the completion `helper_executable_changed`. **Threat model (accepted limitation).** `qualify()` verifies the executable through a descriptor it then closes, and `spawn()` opens the same pathname again, so a process running as the same user can replace the binary between qualification and exec; the post-close measurement detects that afterwards but cannot prevent it. The private execution image is owner-writable, and copying is not a same-user exclusion boundary. This is a change from the Python helper, whose verified program bytes went to the system-protected `/usr/bin/python3` over stdin. It is the same window the Go slot-binding publisher and the relaunch through `/usr/bin/open` already have, and the one Sparkle and Squirrel.Mac accept: by the owner's decision (Brain decision log D3, D4, D12) protection against a same-user substitution is the later Developer ID signing step, not more updater machinery. The retired Python helper's frames, terminal line and exit codes are the contract both Go entries follow. The Go live mode has no offline `recover`: recover always relaunches, as the desktop already requests. A legacy build (no compiled Go core) refuses `apply`, `recover` and `rollback` with `UPDATE_HELPER_GO_CORE_REQUIRED` before any admission, copy, binding or process, and updates by manual installation; the maintainer's supervised controller uses the accepted target package's own verified Go declaration before it asks the predecessor to quit and refuses the same way. `resources/native/update_helper.py` stays in the tree and in the package under the [bridge rule](#retiring-the-python-helper-bridge-rule). The sections below describe that program's behaviour, which the Go entries reproduce with one exception: offline `recover` (`relaunch: false`) is Python-only, and the Go entries refuse it before any I/O. Read "starts Python" in them as history.

`startInstalledUpdateHelper` returns a discriminated result: `ready` permits normal Quit for `apply`, `rollback`, or live `recover` (`relaunch: true`); `not_started` is either a helper-qualification/home preflight failure before calling spawn (no process and no exit code), a refused selection, or a classified native exec failure before any spawn event or PID, confirmed by negative terminal close with no request writes or response bytes; `refused` and `outcome_unknown` keep the app running; `terminal` reports a finished closed apply/rollback after its continuation. Every result after spawning includes an `operation` handle with `operationId`, `pid`, `observe()`, and `completion`. A timeout, malformed message, closed channel, process error, or exit before readiness retains that same child and handle, never implicitly launches another helper, and never upgrades the initial decision because a late ACK arrives. Invalid caller input throws before a child exists; operational helper-qualification/home preflight failures return `not_started` without exposing arbitrary exception text. The durable operation journal remains the update result after the caller has exited. The Lead must include and attest the Go backend in the package and read back the journal on next startup.

Readiness uses the inherited private descriptor 4; the request remains on descriptor 3. The helper emits exactly one JSON event with schema `farol.installed-update-handoff/1`, phase `waiting_for_exit` (or a pre-readiness `refused` plus `error`), `operationId`, `action`, full `source` and `target`, `pid`, and `processStart`. Only after both accepted bundles, the owner's run marker, and the live process start are verified does it send readiness and wait for exit. The launcher accepts one identity-matching frame only after EOF, with a 4096-byte cap. The optional third argument `{ readinessTimeoutMs }` defaults to 180000 and must be 1–300000; it covers the spawned helper's preparation and handoff. Terminal stdout is independently capped at 4096 bytes. After a launch result, the child and observation pipes are unrefed but retained, so the exact caller can exit naturally. A vanished stdout observer cannot interrupt the helper's journaled work. `completion` is an exit/terminal observation while the caller remains alive, not installed acceptance; a subsequent app startup reads the journal as before.

Request schema: `farol.installed-update/1`. Actions are `apply`, `recover`, and `rollback`. Required fields are `operationId` (32 lowercase hex characters), `source` and `target` (`digest`, `version`, `buildId`), `drain` (`status: reconciled`, accepted source/target build IDs), `pid`, `processStart`, `waitSeconds` (1–120), and `relaunch`. `relaunch: true` requests one correlated launch of the verified installed target or restored source, including cancellation and rollback. The selected source/target build and terminal phase are bound in the launch hint. For live `recover`, it also selects the same PID-bound ACK/normal-Quit protocol as apply and rollback. The Python program also accepted an offline `recover` (`relaunch: false`) after an already confirmed Quit; the Go entries refuse that shape before any I/O, and the desktop never sends it. The TypeScript launcher derives the current owner's home; the helper (the Go entries, as the Python program did) derives all mutable paths from that home and operation ID. The current fixed app slot is `~/Applications/Farol.app`. Historical schema 5 helpers used `~/Applications/Farol.app`; they are not the branded update route. An existing preview install must first complete the explicit [closed product cutover](product-cutover.md), then use the normal promotion baseline. Never redirect an old helper by renaming its archive or install slot. Operation data is under `~/Library/Application Support/io.github.legrch.farol/installed-updates/<operationId>/`: the accepted staged bundle is `staged.app`, predecessor is `previous.app`, a rolled-back target is `failed.app`, and `journal.json` records phases. The lock is in the parent update directory. Existing predecessor/failed bundles are never deleted or overwritten. Product config/workspace state is outside these locations.

The helper verifies the source and staged target using the same `farol.tree-digest/v2` record encoding as `tooling/artifact-digest.mjs`, plus main bundle ID/version and embedded build ID. It rechecks source and target after the old PID exits. It pins home, Applications, update, and operation directories with no-follow descriptors, refuses foreign path types and hardlinked files, and bounds entries, depth, bytes, input, journal, and process wait. It takes the existing `farol-state/promotion.lease` exclusive lock after exit and fences its inode before mutations. It fsyncs the phase journal and parent directories around renames. It does not copy or alter bundle metadata during replacement. Existing release/package attestation remains the caller's responsibility.

## Retiring the Python helper (bridge rule)

The desktop no longer dispatches `resources/native/update_helper.py`. Apply, recover, rollback and slot-binding publication run only the attested Go entries, and the desktop source carries no digest pin or interpreter path for it. The file still ships for one reason: an installed predecessor verifies a target package with its own bundled `update-package.mjs`, which requires the target's `Contents/Resources/app` set to equal that predecessor's entry ledger exactly. Every build before the bridge lists `update-helper.py` in that ledger, so it refuses a target without the file as `PACKAGE_RESOURCE_SET_INVALID`.

The fix follows Sparkle's minimum-autoupdate-version practice: ship a bridge release first. The package verifier ([verify-package-content.mjs](../tooling/verify-package-content.mjs)) and the executable closure ([runtime-launch-manifest.mjs](../tooling/runtime-launch-manifest.mjs)) accept exactly two Go-core entry sets, from `bridgeEntrySets` in [build-contract.mjs](../tooling/build-contract.mjs): the full set, or the full set minus `update-helper.py`. Any other difference is still refused. The selected set binds the embedded entry list, its digests and the executable closure. Builds without the Go core keep their exact set, because they would still need the Python helper.

A later release may drop `update-helper.py` and its build entry only after a release containing this tolerant verifier has shipped and been installed. An installation that predates it refuses such a target and can only be updated by hand. `computer-safe-open.py` is a separate resource and is unaffected: the readonly workspace, the Codex agent probe and the development MCP proof still dispatch it.

## Phases and recovery

### Desktop startup invariant

`installedUpdateStartupDecision` in the desktop runtime is the single startup
decision table. Ordinary shared-slot startup, correlated helper relaunch,
private-target reopen, and updater initialization all use it after authenticating
the operation, accepted manifest, slot binding, and executing build. A journal
must belong to that exact operation. Invalid records and unsafe paths remain
boundary failures; they never become accepted content.

The following rows apply **independently to every readable phase**: `none`
(an authenticated operation whose journal has not been created), `prepared`,
`predecessor_saved`, `new_installed`, `verified`, `launch_requested`, `completed`,
`rollback_started`, `rolled_back`, `cancelled`, `cancel_launch_requested`,
`cancel_completed`, `rollback_launch_requested`, and `rollback_completed`.
`rollback_started` is the wire spelling of an in-progress rollback. With no
operation, ordinary installer/adoption authentication applies instead.

| Journal phase    | Helper observation | Installed content         | This running process | Decision             | May continue startup |
| ---------------- | ------------------ | ------------------------- | -------------------- | -------------------- | -------------------- |
| Each phase above | Confirmed live     | Any                       | Any                  | Wait for this helper | No                   |
| Each phase above | Exit unconfirmed   | Any                       | Any                  | Refuse               | No                   |
| Each phase above | Confirmed exited   | Neither source nor target | Any                  | Refuse               | No                   |
| Each phase above | Confirmed exited   | Exact target              | Target               | Settle `completed`   | Yes                  |
| Each phase above | Confirmed exited   | Exact target              | Source or other      | Settle `completed`   | No                   |
| Each phase above | Confirmed exited   | Exact source              | Source               | Settle `rolled_back` | Yes                  |
| Each phase above | Confirmed exited   | Exact source              | Target or other      | Settle `rolled_back` | No                   |

Exact content means digest, version, and build ID together. The running process
must match that accepted build ID and version, with its executable resources
independently captured/verified. Clean process absence or verified PID reuse
confirms that the recorded original helper has ended. Missing identity,
unreadable process status, or a live helper never permits settlement. A pending
restore has its own helper: the ended original apply helper cannot stand in for
it. A proved not-started restore is reconciled separately without replay.

Startup guards observe this table without writing update state or launching an
application. Updater initialization owns the sole canonical settlement writer:
it rechecks installed content, journal phase, and helper exit, then writes
`completed` or `rolled_back` only if needed. A mismatching running process cannot
publish a receipt for another build. Archive reclamation and receipt publication
follow; interrupted housekeeping is resumed from the same canonical decision.
Neither terminal helper phases nor stale `last-update.json` override measured
content. A restored source therefore starts after interruption at
`rollback_started` or `rollback_launch_requested`, including when the saved
receipt still names the target and `ready.json` is absent.

Preserved `previous.app`, `staged.app`, `failed.app`, and rejected-target metadata
are evidence, not startup prerequisites. Only an exact readable predecessor can
enable app-only rollback, subject to state compatibility; a missing, damaged, or
unreadable predecessor disables rollback on **every** restart. It does not turn
accepted installed content into a recovery failure on the next initialization.
Settlement never moves or deletes companions, dispatches a helper, repeats an
uncertain launch, or reopens the operation. A later deliberate update/rollback
still requires its existing action admission.

Canonical desktop `completed`/`rolled_back` attest installed content only. They
do not claim that a prior LaunchServices request returned or that activation
succeeded. Unit tables enumerate every phase/helper/content/running-build row
and repeated decisions; disposable runtime fixtures cover receipt/cleanup
interruptions and repeated lifetimes. Go helper tests inject interruption before
and after actual policy journal-write seams. These are source/fixture evidence,
without installed-state, native crash-durability, or LaunchServices acceptance.

`prepared` is durable before the single Darwin `renameatx_np(..., RENAME_SWAP)` between the fixed app slot and `staged.app`. The syscall leaves the slot occupied on either side; an unsupported filesystem refuses without a two-rename fallback. The helper verifies both exact bundles and directory identities before exchange, fsyncs both parents afterward, then renames the displaced N from `staged.app` to `previous.app`. `new_installed` precedes final target verification; `verified` means both current N+1 and previous N passed exact digest and embedded identity checks. `predecessor_saved` remains readable only for recovery of a journal written by the former helper.

An explicit `recover` uses the **same operation ID and accepted source/target**. It never repeats apply. With `prepared` and the original pair (slot=N, staged=N+1), it records `cancelled`, keeps both bundles, and relaunches N when requested. With `prepared` and the exchanged pair (slot=N+1, staged=N), it verifies both, names N `previous.app`, and records `verified`; the same result follows if that rename happened before the crash. `rollback_started` describes a rollback already journaled: exact slot=N+1 and previous=N proves the exchange has not occurred, so `recover` performs it once; exact slot=N and previous=N+1 proves it occurred, so `recover` only names the latter `failed.app`. Both end as `rolled_back`. If rejected target bytes no longer match N+1 after a crash during verification rollback, recovery refuses without moving either directory; the previous same-invocation inode check cannot be reconstructed from the journal. Live recovery admits only an exact pair before Quit ACK. `recover` also accepts a settled pair without changing it. A pre-existing empty slot from the older two-rename protocol is repaired only after verifying its preserved N and staged N+1; the new protocol never creates that gap. `rollback` starts only from a verified target pair, requires the exact _current_ PID/start time and observed exit, then atomically exchanges N+1 with previous N and preserves N+1 as `failed.app`. A second `rollback` on `rollback_started` is refused; use explicit `recover` after readback. Unknown or mismatched bytes, identities, paths, process state, or journal state are refusals requiring operator reconciliation. No path is deleted or overwritten.

Live `recover` (`relaunch: true`) checks the exact physical pair and owner run marker before ACK, waits for the bound PID to exit, then acquires the same kernel promotion lease, rejects a successor marker and reconciles. An unclean or missing Quit receipt is diagnostic under the live contract above. Python's offline `recover` (`relaunch: false`) required the existing receipt and lease without a running-app handoff; it has no production caller, and the Go entries refuse it. The helper's update lock also excludes a second active helper. A timeout, an unknown original outcome, or a lease still held does not authorize another helper launch; the caller must first establish that the original child has ended and the same journal/physical pair is eligible. Startup readback is observational. The desktop now settles known installed source/target content automatically as described above. Explicit helper recovery remains for compatible maintenance callers.

Before one `/usr/bin/open -a` request for a verified target, the helper writes `launch_requested`; successful return records `completed`. The target observes this exact helper and completion before acquiring the startup lease. Cancelled sources stay closed. Rolled-back sources are relaunched when requested after source content verification, with `rollback_launch_requested` and `rollback_completed`. Historical `cancel_launch_requested`, `cancel_completed`, `rollback_launch_requested` and `rollback_completed` records remain readable. A later recovery recognizes all launch phases and **never repeats** a launch; a requested phase is outcome-unknown until owner readback. Completion means only that `open` returned success, not that GUI startup or activation passed. The current slot and preserved companion must still be verified independently before claiming installed acceptance. A failed post-exchange target check in the same helper run atomically restores N and retains the rejected target in `failed.app`; those rejected bytes are not an accepted digest. The existing promotion lease and accepted-release records remain authoritative; journal phases do not supersede them.

The tests use only disposable private temp homes and test-owned processes, including a Node caller that exits naturally immediately after readiness. Transport fixtures cover malformed/binding failures, premature exit, timeout, late acknowledgment, bounded output, and retention of the same operation; those fixtures are not native process evidence. They prove helper mechanics and refusals, not an installed app, GitHub feed, LaunchServices activation, or live provider behavior. The Lead owns combined package/CI/native/U1–U3 acceptance.

The closed-predecessor route has separate native evidence at source `6de0871a`:
all 32 cases in `tests/integration/installed-update-helper-closed.test.mjs` passed
in one authorized host run. This earlier run exercised the then-selected Python helper (the suite now spawns the Go closed entry) and retained
kernel lease on disposable app/state trees, including the TypeScript transfer
barrier, one atomic exchange, invalid lease/predecessor refusals, continuation
failures and rechecks before mutation. Each test awaited its owned children,
closed its handles and removed its fixture tree. The earlier sandbox refusal
remains a refusal; this is a distinct run. It does not establish installed
replacement, profile compatibility, post-start recovery or a normal N → N+1
update, and did not touch the installed application.

## Explicit Sidecar test presentation

An ordinary live request may carry `relaunchPresentation: "sidecar-only"` only
when relaunch is enabled. The desktop derives this closed selection from its
trusted test arguments. The request snapshot, readiness comparison and private
ACK correlation retain the exact value; it never grants Computer authority.
Both native launch validators accept only the ordinary five arguments or the
same arguments followed by `--preview-window-mode=secondary-visible` and
`--sidecar-display-only`. Verified image binding remains independent of that
argument grammar. Target launch and internal rollback launch preserve the same
selection. An implicit Sidecar viewport fits the permitted display; an explicit
viewport keeps its exact test contract. Missing Sidecar never implies permission
to use the primary display. Ordinary owner launches keep their existing behavior.

## Startup connector regression boundary

The hidden Electron startup fixture holds a subresource open while the current
ChatGPT document reaches DOM readiness. It exercises temporary-chat navigation,
current-document authentication, one synthetic connector Send and its response
probe/receipt. It does not establish live-provider, installed-profile or OTA
acceptance. Task page execution and readiness reads retain the original task
deadline; queued composer preparation checks that deadline inside the page before
typing. Response observation permits the first in-place conversation transition
while retaining physical-frame and task ownership. A second conversation is
refused with the original submission kept uncertain.

This is not a universal task cancellation contract. Attachment/debugger waits
and durable observer callbacks retain their existing lifetime semantics. Startup
connector checks attach no files. Abandoning a durable dispatch claim on a timer
would not prove that no Send occurred; UNKNOWN custody remains authoritative.

The connector preflight also joins a retained ordinary document that starts
loading after preload completes. It observes initial and temporary documents
within one original 20-second readiness budget and performs at most one temporary
navigation. Transient login controls during session hydration do not create
positive evidence: only a fresh current authentication observation admits the
next step. Protected or terminally failed openers remain refused. Binding change,
Quit and deadline expiry stop this original check without another navigation or
Send. Fixed preflight reason tokens distinguish the failed stage without logging
provider HTML, prompts or credentials.

The readiness budget bounds admission, not wall-clock cancellation of an existing
navigation wait. Those waits retain their own bounds; an expired shared readiness
deadline still cannot admit a provider submission.
