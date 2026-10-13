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
its normal receipt schema. Its placement child inherits the same original
updater lock descriptor on fd 7 alongside the promotion lease on fd 6. Neither
lock is reacquired. Ordinary promotion callers omit fd 7 and retain their
existing behavior and receipt schema. Register the original child-close promise
before effect dispatch; the registration also reports that original child's PID
for bounded observation. Both inherited lock references survive Node owner death
until that original effect child exits. Placement success alone does not complete
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
Plan and apply reject serialized intent of 64 KiB or more before marking effects
started or creating a native effect child; the check counts UTF-8 bytes against
the native record reader's cap.

Custody is `/Users/ac/Applications/.farol-replacement-<operationId>`. A completed
operation retains `previous.app`, `previous.receipt.json`, the entire
`installed-updates`, intent and completion records there. No rollback or replay
entry is provided. The candidate must be clean exact schema 7, with increasing
release and build versions. The new receipt is the ordinary promotion schema.

After effect dispatch, only confirmed completion permits release. Every effect
failure, timeout, killed helper or lost result retains both original locks and
keeps the owner alive with
`REPLACEMENT_UNKNOWN_RETAINS_LOCKS_OWNER_REQUIRED`, including after the registered
original children have closed. Presence of a pending inode is never accepted as
durable-fence proof: initial publication or uncertainty publication may have
failed fsync or readback. Conductor reconciliation is required. This conservative
live-owner exclusion ends if the owner is externally killed after its effect
children exit; it does not establish universal crash/power-loss protection. No
automatic recovery or retry follows.

The disposable owner-death regression runs the genuine producer and hash-pinned
ordinary placement helper, stops that exact child at its existing pre-effect
hook, kills only its Node owner, and probes both unchanged lock inodes. A native
`NOTE_EXIT` observer registered while the child is alive supplies terminal proof
before checking that the inherited locks release. This test does not inject a
copy fault or exercise a packaged application.

Additional code-attested fixture programs execute the exact pinned replacement
helper with local fsync faults. They cover partial initial intent publication,
successful pending retirement followed by directory-fsync failure and uncertainty
publication directory-fsync failure, and loss of placement or final completion
results. The final-completion lost-result fixture also proves owner retention
when the pending slot is absent. The fixtures confirm both locks remain held by
the live owner after the original child closes, even when pending presence is
observable. These fixture faults have no CLI
selector and qualify neither real filesystem durability nor installed runtime
acceptance. Failed fixture generations without original-child terminal proof
are retained rather than cleaned.

Native subprocess tests must run in host execution. The filesystem sandbox on
this Mac makes `/usr/bin/python3` emit a `DARWIN_USER_TEMP_DIR` confstr warning;
strict stderr rejection correctly refuses that environment. The same disposable
producer and ordinary promotion tests pass outside that sandbox. This observation
does not authorize changing a real run's environment after an unknown effect.

Parent integration, a new clean committed candidate, package verification,
independent review and the explicitly selected production step remain separate
acceptance boundaries. No existing artifact at the prior source identity gains
this fence merely because the source tests pass.

Ordinary promotion rechecks the selected application entry against the held
copied directory before receipt publication and immediately before its success
response. Application displacement within an unchanged Applications directory
never yields a successful helper response. If displacement is observed after
receipt publication, the receipt and copied/displaced resources remain retained
for reconciliation; their presence alone is not confirmed placement. These are
bounded point-in-time checks, not a claim of permanent namespace exclusion.

The published receipt is also read back through a no-follow descriptor and
matched to its original inode, exact bytes, regular-file mode and single-link
identity before the success response. Removal, replacement with identical
bytes, symlink and hardlink aliases produce no success response and preserve
already published resources for reconciliation.
