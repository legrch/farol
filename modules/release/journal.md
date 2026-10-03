# Current-alpha journal persistence

This source-only adapter stores exactly `journal.json` in an existing accepted
operation directory. It uses the existing
`farol.installed-update-journal/1` schema, full operation/source/target binding,
all 13 phases and the records codecs. There is no migration-v1 ledger, lockfile,
phase engine, process probe, helper launch, install or runtime registration here.

## Admission and lifetime

`app/port.JournalAdmission` is borrowed from the one authoritative Release
operation owner. It must cover accepted byte/profile provenance, the existing
exclusion domain and complete stopped-writer/helper proof. Its local
`JournalGate` accessor returns the same serialization gate to every consumer;
each adapter must not invent an independent gate or acquire a new host lock.
Callbacks run under this gate and must not acquire it recursively. The verifier
has the owner's existing bounded budget and cannot probe a refused/unknown
original helper or derive quiescence from a path, PID or record.

`JournalUnknown` and `RetainJournalUnknown` refer to retained local state in
that owner, shared across all handles. They perform no IO and do not create a
second persisted schema. A failed invoked verifier retains uncertainty before
another consumer can invoke it. Any possible persistence failure also retains
uncertainty locally and in that owner. Read, Close, cancellation and a new
adapter cannot release it. Cold startup needs the application's original
operation reconciliation and real quiescence; New is not a recovery/retry API.
This slice does not implement that composition or cold reconciliation.

The directory is fixed by trusted composition, never by a transport request.
The operation directory name must match the exact alpha operation ID. Both it
and its immediate state parent must be canonical, private, owned directories.
Held descriptors and named device/inode/mode/UID/GID are rechecked. Directory
link count and timestamps may change as native entries change; they do not
identify a new directory generation.

## Read and compare-and-swap

Read accepts only a private, owned, single-link regular file. It uses no-follow
and nonblocking open, a 65,536-byte read cap, before/open/after/named native
identity, size, mtime and ctime checks, exact byte length and the existing bounded
decoder. A FIFO or symlink introduced between stat and open cannot become a
blocking read or followed record. Confirmed absence requires a stable held/named
directory generation and a second absent observation. Errors return no view and
expose classified codes only.

Revision binds the complete operation, directory generations, file metadata and
exact bytes. It is a CAS witness, not authority or proof of prior durability.
The writer validates the existing helper's 8192-byte encoding bound, exact
binding and the expected revision before any possible mutation. It then:

1. Rechecks the borrowed admission and creates one exclusive private random temp.
2. Writes all bytes, fsyncs the file, verifies its identity and closes it.
3. Rechecks the same admission, exact CAS witness, temp and directory generations.
4. Publishes once, fsyncs the held operation directory, then measures exact bytes
   and the same published object before acknowledgment.

An absent destination uses native no-replace rename. Existing-record CAS uses
the shared borrowed gate plus authoritative exclusion of every other writer.
It is not an atomic compare-and-rename primitive against a noncooperating
external writer. Measured races refuse before mutation, or retain Unknown after
possible mutation; a later observation cannot manufacture admission.

After create has been invoked, write/sync/rename/readback/ACK errors return
`UPDATE_JOURNAL_PERSISTENCE_UNKNOWN`; neither a prior record nor an apparently
absent destination permits another write. Temporary evidence is left in its
exact operation directory on uncertainty. No automatic cleanup, rollback or
second write is performed. Cancellation before create causes no write.
Cancellation after possible creation lets the original local persistence drain
finish under the retained owner's budget, then returns Unknown instead of
acknowledging success.

Successful CompareAndSwap proves only this call's complete journal persistence
sequence. Read alone proves no fsync, helper exit, package acceptance, startup
permission, install completion or permission to redispatch an earlier operation.

## Evidence and remaining exits

Focused tests use actual disposable Darwin filesystem descriptors, private modes,
symlinks, hardlinks, FIFOs, directory/file replacement, exact read bounds,
native no-replace collision, concurrent consumers, permission denial and a
closed-descriptor fsync failure. Fault checkpoints cover partial write,
file/parent sync, rename, final readback and ACK loss. Injected ENOSPC and
sync/ACK errors are not a real full-device, power-loss or storage-controller test.
The all-phase persistence cases retain current-alpha parsing compatibility.

The admission fixture is symbolic; it does not prove accepted profile/build
provenance, helper/writer quiescence or installed behavior. Positive native UID
measurement and a separate predicate-only negative are tested. The actual
foreign-UID negative is explicitly skipped without root; no privilege escalation
is attempted. Linux compilation is not native Linux persistence evidence.

Application phase transitions, restore/retained/download record persistence,
durable unknown reconciliation, boot/helper integration, installed migration and
mandatory R4 remain open. No active TypeScript/Python implementation is deleted.
