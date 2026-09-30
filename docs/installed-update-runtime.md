# Installed updater lifecycle

The updater is enabled only for the exact installed Farol Next Preview slot and
its existing owner data directory. Temporary `task run` copies do not update the
installed app. The GitHub channel and package identity are fixed by the release
contract; no source checkout, credentials or local diagnostics are published.

Electron's ASAR filesystem must not reinterpret release bytes. The desktop copy
port uses Electron's `original-fs`, and trusted verifier/readback subprocesses use
`ELECTRON_RUN_AS_NODE=1` plus `ELECTRON_NO_ASAR=1`. The ordinary application keeps
its normal filesystem semantics.

A durable ready record binds the verified archive to an operation before helper
dispatch. Only the helper's exact readiness acknowledgment permits normal Quit.
Unknown acknowledgment or completion never permits another apply. The same child
handle remains observable while the original app is alive, including after a
process metadata readback failure. The actual helper PID is persisted before
reading its start time. An unavailable start time remains null, never invented:
a present PID or failed process observation cannot prove that helper exited.
Only confirmed termination plus an absent journal, unchanged source and exact
staged target (with no predecessor/failed copy) can reconcile a pre-mutation
exit. That restores a deferred ready state without launching another helper.

Before Python allocates ZIP entries, the extractor bounds central-directory
metadata and counts its actual records. This channel accepts single-volume,
non-ZIP64 archives with at most 16 MiB of central-directory metadata and 1 GiB
of expanded content. The app tree's entry/depth bounds also precede extraction
and stay within the installer's limits.

A pre-readiness refusal is retryable only after that same helper's classified
terminal exit confirms it never crossed the mutation handoff. The app rechecks
the unchanged slot/journal, preserves the refusal receipt, clears only that
pre-mutation intent and releases admission. The redundant staged app is removed
before that intent is cleared; the small refusal receipt remains. Unconfirmed
cleanup persists an obligation and blocks another attempt across restarts.
A missing, timed-out or conflicting
terminal result remains unknown and never permits a substitute helper.

A confirmed `not_started` launcher result is separate from an unknown no-PID
outcome. Only the launcher's terminal native exec failure can establish that no
helper existed. Apply rechecks the source and absent journal, records the refusal,
then durably transitions to preparation cleanup before reclaiming its copy. An
interrupted cleanup is reconciled on startup without dispatch. Rollback/recovery
records the same no-spawn proof in its exact restore intent and rechecks unchanged
journal and installed identity before clearing it. A lost proof or unknown close
remains blocked; no-PID alone never permits another attempt.

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
app remains available for rollback; no workspace or settings are reclaimed.

At startup the updater reads the same operation journal and measures the current
slot and predecessor/staged/failed pair. It does not launch a helper while
rendering or silently download a replacement. A settled target offers the measured
predecessor through **Restart & Restore Previous Version**. A known interrupted
pair offers **Restart & Finish Recovery** only after the original helper PID/start
time has been observed as ended; a permission error or malformed process readback
keeps recovery blocked. Both actions acquire the existing work
admission fences, record their exact dispatch intent, and use the helper's normal
Quit protocol. The helper, not the renderer, owns atomic exchange and reconciliation.

A restore intent whose result is still unknown stays blocked. A matching changed
terminal journal plus measured running build reconciles it on the next launch.
A rolled-back or cancelled build is not automatically offered again. All prior
payloads and journals remain available; this lifecycle never deletes the
predecessor or modifies workspaces/settings to make an update admissible.

These source tests exercise ports and disposable filesystem state. They are not
proof of a public GitHub download, installed N-to-N+1 upgrade, native relaunch,
configuration preservation or rollback on the owner's live installation. Those
require separate release/update receipts from the accepted packaged candidate.
