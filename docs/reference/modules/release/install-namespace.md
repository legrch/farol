# Installed application namespace preparation

The desktop selects the Go apply/recovery/rollback helper entries; the retained
`resources/native/update_helper.py` is no longer dispatched. Its `rename_checked`
and `exchange_checked` operations have a Go primitive in
`modules/release/infra/native/installmove`, composed by those entries. This primitive moves directory
entries; it owns no update policy, durable journal, admission lease, recovery,
installation or relaunch decision. The existing Release owner must compose it.

`PrepareRename` and `PrepareExchange` capture two exact borrowed parent files,
canonical device/inode identities, fixed leaf names, an original absolute
deadline and the owner's fence. Only `Farol.app`, `staged.app`, `previous.app`
and `failed.app` are accepted leaves. They are individual components, never
paths. The caller retains descriptor lifetime, authoritative writer exclusion
and the named physical routes until `Run` actually returns. The primitive never
closes, unlocks, seeks or reconfigures a borrowed parent.

The default `OwnedParent` role requires an effective-user-owned directory with
no group or world write. The explicit `SharedApplicationsParent` role is
restricted to the `Farol.app` leaf and preserves the Python reference helper's separate
shared-parent predicate: root ownership, no world write, and group write only
for group 80. Trusted composition selects that role only after verifying the
physical root and `/Applications` route. Selecting a role or supplying an inode
grants no authority. Unknown roles refuse; private parents keep their predicate.

Before an effect, the primitive checks directory types, parent and entry
identities, ownership, expected source presence and rename destination absence.
It pins original entries without following links and snapshots their complete
device/inode/mode/uid/gid identity. The owner fence then revalidates the accepted
complete app trees, named routes, lease, slot binding, journal and admission.
The primitive checks its physical observations again after that callback.
Expected device/inode values alone do not attest accepted contents or modes.

Darwin rename uses `RENAME_EXCL`, preserving destination absence atomically;
exchange uses `RENAME_SWAP`. There is no weaker syscall fallback. Success
requires exact moved or swapped identities, both parent fsyncs, and another
physical readback. Entry and parent metadata changes refuse before dispatch or
remain uncertain after dispatch. Same-directory moves still fsync both roles.
Named-route replacement remains the existing owner fence's responsibility;
the primitive continues to use the held original handles.

An operation consumes its attempt before I/O, including cancellation and fence
refusal. Copies share that consumption. A repeated or concurrent call cannot
dispatch another native effect and returns uncertainty. Expected refusals,
unexpected infrastructure failures, and possible effects remain distinct. No
failure requests retry, rollback, journal clearing or adoption of a directory.
Only explicitly classified kernel no-effect errors can be ordinary refusals;
readback, sync or cancellation uncertainty after dispatch cannot become success.

The earlier caller deadline and original operation deadline apply throughout.
Filesystem syscalls run synchronously and may block inside the kernel. A timer
cannot prove that such a call stopped: custody remains held until its actual
return, and expiry after dispatch remains outcome unknown. The enclosing helper
owner must retain its original-process and lease fences if waiting expires.

Linux production constructors explicitly refuse. Disposable Linux tests inject
a private `renameat2` backend to exercise namespace behavior, collisions,
metadata replacement, fault classification, cancellation and borrowed-handle
custody. Synthetic shared-parent metadata does not prove `/Applications`
permissions. Darwin cross-compilation proves compilation only. Actual APFS
exchange, installed update/recovery/rollback, package resources, clean-Mac and
OTA acceptance remain separate and are not established by this preparation.

The Go helper composition (existing input/protocol, handoff custody, process
observation, app verification, slot and journal owners, namespace effects,
private launch capture and terminal mapping) is selected by the desktop with no
Python fallback. The remaining retirement exit is the deletion packet for the
Python file; native and installed qualification remain explicit gates.

## Private launch tree copying

`infra/native/installcopy` prepares the descriptor-relative copy used before a
shared-install target can be launched from a private image. The caller lends
two exact directory handles: an accepted source and a newly created, empty,
private destination. `Prepare` captures their complete metadata and original
deadline. `Run` consumes one shared attempt, including cancellation or refusal;
copies of the operation cannot dispatch another copy.

Traversal never follows a link. Regular files require a single link, effective
user ownership, safe modes and stable full metadata; destination creation is
exclusive. Partial writes are completed, source modes are preserved, owned
files and directories are fsynced, and complete bounded inventories are checked
again around the owner's final fence. Symbolic links retain their literal
relative text. The final app-tree verifier separately decides whether those
links stay within the accepted image. Production bounds are 100,000 entries,
1 GiB of copied file bytes, depth 128 and 4096 bytes per link.

Copying is not an atomic source snapshot or a same-user exclusion boundary.
Creating a directory or link does not atomically return a newly created handle.
The existing owner must retain route, lease, slot, journal and admission custody,
verify the complete independently expected target digest and app identity, and
publish or launch only through its existing effect fences. This primitive never
publishes, removes, rolls back, adopts or executes an image.

Native call attempts retain possible private effects, including a failed call
after partial mutation. Exclusive `EEXIST` proves no creation by that call;
earlier possible effects stay retained. Native I/O and cleanup errors remain
internal, with closed outer codes and exact private causes. Concurrent
cancellation cannot hide them or authorize replay. Borrowed descriptors keep
their offsets, flags and locks, and remain physically held until synchronous
I/O actually returns; a deadline cannot prove a blocked kernel call stopped.

Portable tests use disposable Linux files and bounded fault seams, including
collisions, no-follow races, partial mutations, post-fsync metadata changes and
cancellation during cleanup. Three actual UID/GID mutation cases require
privileges and remain skipped in this Cloud environment. Darwin builds were
cross-compiled only. Native, packaged, installed and clean-Mac qualification,
and removal of the retained Python helper, remain open.
