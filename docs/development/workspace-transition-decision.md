# Workspace continuity: durable transition addendum

Status: proposed. Exact source foundation: `3a1bd24610901d3a59c2970f0683d14f57a8782d`.
This narrows the implementation of the accepted workspace-continuity decision;
it does not accept implementation, installation or release.

## Decision and deadline

Before wiring enrollment or startup rebinding, choose how the existing sole
Computer owner retains original-operation custody across Settings writes,
publication, lost replies and process restart. No deadline waives a fence.

Recommend a narrow Go-owned durable transition sidecar under the existing
access-store lifetime lock, plus staged publication and a strict TS sole-writer
commit. Do not add a second Settings writer or generic transaction framework.

Success means the same explicitly enrolled directory can acquire its current
device binding after reboot without changing rights; no unfinished or unknown
operation can create or revive authority, including in recovery startup.

## Verified foundation and gap

C0 observation, C1 held startup-Data anchor, C2 strict optional continuity reader
and C3 retained candidate descriptors are committed, but not production-wired.
Their current host/native checks are checkpoint evidence only.

`modules/computer/infra/repos/access/store.go` restores and confirms current
protected bytes; its state does not identify a cross-owner transition or its ACK.
`src/apps/desktop/authority-transition.ts` is an in-memory reservation.
`run-marker.ts` replaces the old marker at startup.
`ProductConfigurationService.commit()` has a disk-read fallback on failure.
`boot/computersettings.go` admits by the acknowledged publication projection,
not solely by the Chat activation fence. None alone closes this gap.

## Proposed ownership and ordering

The existing Go access owner owns one bounded strict transition record in its
private directory, using its existing native lock, protected descriptor-relative
I/O, fsync/readback and unknown/cleanup classification. Keep Computer access
schema 1 unchanged. The sidecar is not approval evidence and never creates grants.

Persist original operation UUID, request fingerprint, profile/computer/workspace
binding, expected Settings revision and Computer generation, old/new root binding,
stable permission fingerprint, continuity digest, phase and exact receipts.
Use closed versioned phases and bounded retained terminal custody; never evict
unfinished/unknown records. Retention/admission limits must refuse rather than
erase evidence or silently recycle operation IDs.

TS holds its authority-change reservation and sole-writer exclusion across short
Go RPCs: Prepare -> Withdraw -> strict Settings CAS/readback -> Stage -> Finalize.
Never call back into TS while holding Go Store/ingress/activation locks.
Go keeps native handles between calls, not locks across awaited TS work.

1. Refuse unsettled dependent work, quit/update/recovery and concurrent changes.
   For legacy enrollment require an explicit native folder picker; preserve ID,
   rights, Commands, exclusions and Git choices. Cancellation does not mutate.
2. Acquire and qualify C1 anchor and C3 original candidate chain. Enforce the
   already accepted internal-current-startup-Data scope, persistent identity,
   live guards and runtime/boot correlation.
3. Durably prepare before withdrawal. Each side effect has a durable intent
   before dispatch and an original-operation exact outcome afterward. Ambiguous
   prepare/withdraw/save/publication/cleanup stays fenced, never becomes a new UUID.
4. TS alone conditionally writes the exact revision, advances generation and
   replaces only eligible binding/continuity evidence. Use a narrow strict path,
   without generic disk-fallback success. Exact committed readback is required.
5. Stage publication after native requalification and exact revision/policy checks.
   Stage must withhold every admission path, including Settings, connector and
   Chat, even if the Store already contains the new approval.
6. Require exact publication correlation/ACK, final original-chain/anchor checks,
   and one classified Close per owner. Close failure is not success or permission
   to retry a numeric fd. Persist exact terminal custody before enabling admission.
   An activation failure cannot be represented as a usable completed transition.
   Every subsequent operation still enforces live descriptor guards.
7. Startup/recovery read the sidecar before any publication or admission. Pending,
   unreadable or unknown state admits restricted diagnostics/recovery only.
   Terminal success still requires fresh native qualification; no old handles or
   finite Task/Codex/Agent grants are restored or renewed.

Do not infer historical ACK from matching Settings/Store bytes. A late result is
an observation of the same UUID/payload/generation only; retirement or drift
prevents activation. Explicit reconciliation may consume already-recorded proof
without repeating the effect. No automatic retry after unknown. Known not-written
abort may settle the original operation but does not revive withdrawn authority.
Document a useful recovery route for retained uncertainty; never reset the profile
or delete a journal to make the application green.

Stable permission fingerprint excludes ephemeral device/FSID, revisions,
generations, timestamps and publication receipts. It includes the complete
complete canonical approval policy: owner/computer identity, scope, access,
exclusions, capabilities, network policy, Commands, file/Git policy and owner
restrictions. Treat every policy field as included unless explicitly excluded
above; finite grant expiration is not silently extended by this fingerprint.
Separate continuity digest and new generation/publication digest bind live facts.

## Exact recovery contract

Recovery first opens the protected owner in restricted mode and inspects the
original record without executing its pending effect. It must expose the
original UUID, phase and classified known/unknown custody; raw filesystem or
provider diagnostics are not permission evidence.

A read-only reconciliation can return the original completed receipt only when
the journal already durably contains the exact Settings publication result,
correlated Go publication acknowledgement and terminal completion for that UUID.
It does not retry save, withdraw, publish or finalize, does not activate by itself,
and cannot turn an intent-only record or equal Store bytes into a receipt.
A later ordinary startup still performs fresh native qualification.

If that proof is absent, the operation remains unknown. The supported user
recovery is an explicit new Confirm folder action in restricted recovery, not
an automatic new operation: first prove retirement/drain of the exact old host
and backend, settle or retain every dependent effect obligation, and quarantine
the old native-handle owner with confirmed process retirement. Never re-close an
old numeric fd or reuse its handles. If retirement/cleanup is unknown or any
dependent operation is unsettled, refuse this recovery and retain the fence.

Then require fresh native selection and explicit confirmation of the complete
current scope and permissions. This is new consent, linked to the original
unknown UUID in durable custody; it is not proof that the original succeeded.
Validate and conditionally replace the exact current Settings revision through
the same strict writer and Go transition sequence. Do not erase or reinterpret
the old record. A new-operation limit includes these retained records and refuses
when full. A recovery failure retains both identities and their actual outcomes.

This recovery must be implemented and fault-tested before enabling enrollment
or automatic rebinding. Until then, pending state stays restricted and the
feature remains disabled. Profile reset, journal deletion, silent grant renewal,
automatic new UUIDs and profile snapshot rollback are never recovery procedures.

## Compatibility and rollout

The 0.5.23 source baseline at
`a91048f34013edabe05730b697b11349ffdc3de8` defines
`ApprovedProductWorkspaceSchema` as a strict object without `continuity`
(`src/pkg/product-settings/contract.ts`). This supports a static inference that the added key is rejected; it is not
installed downgrade qualification. A reader-only checkpoint
does not qualify installed recovery. Before any production writer, qualify a
compatible predecessor/recovery and the full update/promotion/rollback contract,
including journal readers. Unfinished update/recovery blocks enrollment/rebind.
An older binary that ignores the sidecar must never be selected as compatible.
Do not erase newer outcomes via profile snapshot rollback. Arbitrary 0.5.23
downgrade after enrollment is unsupported without a separately qualified migration.
This decision does not require two public releases: compatible recovery may be
qualified locally before the writer is enabled. Availability of such a predecessor
is an explicit release gate, not assumed to exist now.

## Alternatives, falsification and cost

Keeping device-pinned access plus explicit reconfirmation remains the safe
fallback and easiest rollback before persistence. It leaves the reboot burden.
Settings-only pending state or a new generic Settings engine creates weaker
custody or unnecessary ownership. Reading equal bytes after restart loses
operation history. Automatically retrying under a fresh UUID violates unknown
custody. Reject the recommendation if it cannot fence all actual admission paths,
retain original outcomes, or provide compatible usable recovery.

## Required checks before activation

Inspect the actual native picker, `identity-bound-workspaces.ts`, generated wire,
activation callers and update/recovery owners before coding their seams. Test
all intent/effect/ACK crash boundaries; original UUID/different payload; competing
operations; stale revision/generation/policy; native replacement and mount races;
unsettled Agent/connector/update; known not-written, unknown rename/readback,
lost publish/finalize reply; late callbacks, close failures, strict malformed
journal and recovery startup; legacy cancellation and successful enrollment.
Then actual enrolled remount/reboot, local ordinary file/command use, zero startup
provider Send, compatible package update/recovery and the installed public slot.
Model advice and checkpoint tests do not satisfy these final gates.
