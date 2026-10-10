# Installed preview replacement maintenance

Status: startup consumer and one-shot replacement producer implemented with
disposable native verification. Production acceptance, packaging and integration
remain parent-owned. This document grants no production execution authority.

## Startup fence

The fixed intent slot is
`<userData>/farol-next-state/installed-replacement.pending`. The desktop checks
it after acquiring its existing generation-owned promotion lease, before the
startup critical callback, and again through that callback's verifier before
publishing the running marker. Any entry blocks startup, including symlinks,
directories, malformed bytes and completed-looking records. Probe errors other
than `ENOENT` block startup as unconfirmed. Startup never opens, parses, repairs
or removes the intent, and offers no environment or command-line bypass.

`withStartupPromotionLease` remains the consumer of the existing kernel lock.
It imports no tooling and changes neither Quit receipts nor runtime markers.
This fence protects a candidate containing this source change. It does not
retrofit beta.5, prevent manual opening of an archived app, or exclude an
external process that ignores the lease.

## Required producer contract

The owner maintenance entry uses the fixed trusted home `/Users/ac`,
canonical app `/Users/ac/Applications/Farol.app`, normal receipt
`Farol.app.receipt.json`, and runtime-owned updater root
`<userData>/installed-updates`. Browser, authentication and other profile state
remain in place. A plan must perform no writes, lease acquisition or placement.
Apply must be an explicit, exact one-shot selection; unknown effects cannot be
retried, replayed or automatically rolled back.

Before any custody effect, hold one generation-owned promotion lease across
fresh source/package verification, genuine activation drain, expected normal
receipt and updater metadata snapshots, and app/backend/connector/helper process
proof. A completed-looking journal or diagnostic lease record is not terminal
proof. Python stdin helpers must be correlated through the existing operation,
helper process-start and lease structures. Unknown or unexpected records refuse
the operation.

Publish and fsync a private mode-0600 non-overwriting intent in the fixed slot,
then read it back under pinned directory identities. Custody must use private
same-device directories and non-overwriting descriptor-relative renames, with
fsync, identity checks and readback after every move. Move the canonical app
first. Preserve the entire updater directory in one rename, the original normal
receipt and any exact named install journal, retaining original bytes and
metadata. Do not copy browser/profile/authentication partitions.

Invoke the existing ordinary promotion helper with that same held lease and
its normal receipt schema. Register the original child-close promise before
effect dispatch; retain exclusion until that original close is confirmed when
the bounded call returns unknown. Placement success alone does not complete
maintenance. Verify placed candidate bytes, normal receipt, custody identities
and retained updater state before completion.

The existing completion pattern in `closed-empty-chat-recovery.ts` writes and
fsyncs a completion record, reads it back, rechecks pinned identities, then moves
pending last and fsyncs/readbacks both locations. Its final-rename error path
attempts to restore an uncertainty fence; that attempt can itself fail. A future
replacement implementation must preserve and report that uncertainty explicitly,
without claiming universal power-loss protection or allowing one-shot replay.
The startup consumer does not establish producer completion or durability.

## Verification and remaining work

Disposable native tests exercise macOS lease exclusion, intent presence,
unchanged bytes/inodes, symlinks, directories, unreadable entries, drift before
publication and loss of an exact maintenance holder. Injected `EIO`, `EACCES`
and `ENOTDIR` probe failures are labeled fixture faults. Admission after a
fixture completion rename proves only the startup consumer's absence rule.
No packaged app, real replacement, receipt acceptance, installed profile or
provider is exercised.

The producer binds parent-selected public metadata snapshots instead of
reconciling historical updater operations. It nonblockingly acquires the existing
updater lock inode alongside the existing promotion lease, retaining both through
custody, placement and the original helper close. The updater lock excludes an
ordinary helper waiting for predecessor exit before promotion acquisition.
Historical `launch_requested` and `verified` records remain unchanged and
unconfirmed; custody is never reported as operation completion. Existing cold
repair receipts or journals are refused and require their owning reconciliation.

## Selection and invocation

Use `node tooling/replace-installed-preview.mjs --selection /absolute/selection.json
--selection-sha <sha256>` for plan-only, adding `--apply` only for an explicit
production step. Selection is a private regular file with schema
`farol.installed-replacement-selection/1`, exact `sourceCommit`, a fresh
32-character hexadecimal `operationId`, `snapshot`, and `helpers` (exact PID and
process-start pairs). `snapshotInstalledReplacement(home)` defines the snapshot
shape for the parent: app/receipt digests and inodes, build metadata, pinned
directory/lock identities, root and immediate child metadata, and exact JSON
record digests. Archive and stage contents are not scanned. The CLI has no home,
candidate, process, helper or force overrides. Module-only seams are fixtures.

Custody is `/Users/ac/Applications/.farol-replacement-<operationId>`. A completed
operation retains `previous.app`, `previous.receipt.json`, the entire
`installed-updates`, intent and completion records there. No rollback or replay
entry is provided. The candidate must be clean exact schema 7, with increasing
release and build versions. The new receipt is the ordinary promotion schema.

If final intent retirement is unknown and a durable uncertainty fence cannot
be confirmed, the owner retains both original locks and stays alive with
`REPLACEMENT_UNKNOWN_RETAINS_LOCKS_OWNER_REQUIRED`. Conductor reconciliation is
required. This is a live-owner exclusion limit, not universal crash/power-loss
protection. No automatic recovery or retry follows.

Native subprocess tests must run in host execution. The filesystem sandbox on
this Mac makes `/usr/bin/python3` emit a `DARWIN_USER_TEMP_DIR` confstr warning;
strict stderr rejection correctly refuses that environment. The same disposable
producer and ordinary promotion tests pass outside that sandbox. This observation
does not authorize changing a real run's environment after an unknown effect.

Parent integration, a new clean committed candidate, package verification,
independent review and the explicitly selected production step remain separate
acceptance boundaries. No existing artifact at the prior source identity gains
this fence merely because the source tests pass.
