# Installed application namespace preparation

The selected apply/recovery/rollback helper is still
`resources/native/update_helper.py`. Its `rename_checked` and `exchange_checked`
operations now have an unselected Go primitive in
`modules/release/infra/native/installmove`. This primitive moves directory
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
restricted to the `Farol.app` leaf and preserves the selected helper's separate
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

The remaining retirement exit is the complete Go helper composition: existing
input/protocol, handoff custody, process observation, app verification, slot and
journal owners, namespace effects, private launch capture and terminal mapping.
The selected Python route stays in place until that capability is ready for
source cutover; native and installed qualification remain explicit gates.
