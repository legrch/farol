# Workspace continuity: durable transition decision

Status: accepted for implementation at
`1b04095ca9eca47c6d8f761f76f21254441f9e78`. Source foundation:
`3a1bd24610901d3a59c2970f0683d14f57a8782d`.

The cumulative R4 decision review completed General, Security, Architecture,
Strong and Frontier coverage. The host rejected the returned P2 as a defect of
this decision: it identifies a legacy implementation gap that the explicit
construction constraints below already forbid. Closing that gap and its fault
test remain mandatory before feature activation. The additional finding checker
returned an invalid result format; it supplied no accepted finding disposition.
Earlier candidate reviews remain unaccepted; no coverage was imported from them.
This records a chosen design, not code, package, installation or release acceptance.

This selects construction constraints BEFORE implementation. It claims no
realized runtime transition or fault-test result; those are explicit later
acceptance gates, not evidence this artifact purports to supply.
The accepted [continuity scope](workspace-continuity-decision.md) remains fixed.

## Decision and success criteria

Use one narrow Go-owned write-ahead transition journal under the existing
Computer access owner's protected lifetime lock. Keep the existing TS Settings
writer as the sole writer of `config.json`. Stage new publication until the
required receipts, cleanup and final native checks are known.

Success means an explicitly enrolled directory on the current internal startup
Data filesystem survives ordinary reboot/device renumbering without changing
workspace ID or rights. Different/ambiguous roots, unfinished effects and missing
proof stay refused. Do not add a second approval owner or generic Settings engine.

The safety guarantee starts at a CONFIRMED durable admission intent, before any
operation-owned native workspace handles, withdrawal, Settings mutation or
publication. It is not a promise of lossless audit before the first durable
record, or of caller observations that were never durably recorded.

## Existing facts and trust boundary

C0 observation, C1 held startup-Data anchor, C2 strict optional continuity reader
and C3 held candidate are committed but not production-wired. Their host/native
checks are checkpoint evidence only.

The access Store restores protected current bytes; its current state does not
identify a cross-owner transition or historical RPC delivery.
`authority-transition.ts` is an in-memory reservation, `run-marker.ts` replaces
its marker, and the generic Settings commit has a disk-read fallback.
`boot/computersettings.go` admits by publication correlation, not merely Chat's
active Boolean. Preserve exact fence-revision and desktop pending exclusion.

Assume the trusted running OS, declared filesystem sync/rename guarantees and
protected Farol state. Privileged startup-volume/state rollback, lying storage,
and lossless recording of events before durable admission are outside this
guarantee. Keep all prior APFS eligibility, clone, path, ownership and race guards.

## Owner and durable record

The existing Go access owner owns a bounded strict versioned journal in its
private directory. Use its protected descriptor-relative I/O, lifetime lock,
CAS, sync/readback and classified failures. Keep access snapshot schema 1
unchanged. The journal never creates an approval or renews a grant.

Retain original operation UUID/request digest, profile/computer/workspace IDs,
fixed requested root, complete stable permission fingerprint, expected Settings
revision/generation, trusted boot UUID, backend/host lifetime correlation,
phase, old/new binding and continuity digest when measured, per-effect IDs and
exact known receipts. Native anchor runtime nonce is additional prepared
evidence; it is not the backend lifetime ID.

Closed phases distinguish admission intent, native preparation, each effect
intent, each acknowledged result, terminal certificate and unresolved outcome.
Bound capacity; never evict unfinished/UNKNOWN custody or silently recycle IDs.
Same UUID/different payload and a competing operation while fenced are refused.

## Separately owned prerequisite drain

The existing Computer MCP drain is an independently admitted prerequisite owned
by its current lifecycle/operation owners, not an effect hidden inside the new
transition before its WAL intent. Preserve `stopAndConfirmComputerMcp`,
`WorkspaceConfigurationDrain` and stopped-Settings publication ownership.
They must finish their original stop/cleanup and stopped-state publication/
readback with known confirmations BEFORE the new transition is admitted.
A thrown, stale, malformed or UNKNOWN result refuses transition admission;
observe the existing stop only, never repeat it under a new transition UUID.

Capture the new transition's Settings revision/generation/policy snapshot only
AFTER that known prerequisite completion. An uncertain drain/record cannot be
treated as a completed preflight or resumed from equal Settings bytes. See
`main.ts`'s `configureDrainedWorkspaceChange` and
`workspace-configuration-drain.ts`: their original result gates `apply`.
The new WAL guarantee covers only the newly admitted continuity operation;
it does not claim custody of preceding operations owned by another lifecycle.

## Write-ahead ordering and first-record limit

1. Under the existing Go admission/mutation serialization, reserve the operation
   and verify settled dependent work, quit/update/recovery and all other admission
   predicates. TS holds its authority reservation and sole-writer exclusion.
2. Measure the fixed trusted kernel boot UUID without acquiring operation-owned
   workspace/anchor handles. This is a native metadata scalar, not caller input.
   Persist the original admission intent with that UUID and exact request.
3. Only after file/directory sync and exact readback CONFIRM this intent may
   acquisition or any covered effect start. An unknown first-intent publication
   fences the current runtime; do not retry it or dispatch the next step.
   A late I/O result after cancellation/poison cannot cross this admission barrier.
4. Now acquire the C1 anchor and original C3 candidate chain, check the same boot,
   persistent tuple, current startup-Data instance, original path and complete
   policy. Persist prepared evidence before withdrawal.
5. For legacy enrollment, keep the original fixed-root candidate held across
   the explicit native picker confirmation and requalify it afterward. The
   picker result must name that same root and operation; a different selection
   is a scope change, not an enrollment of the old workspace. Preserve
   ID/rights/exclusions/Commands/Git choices. Cancellation after admission uses
   the known-refusal rule below; do not leave it as an automatic UNKNOWN.
   Never enroll from equal inode, Verify or upgrade alone.

If the FIRST intent was never confirmed, the trusted service has dispatched no
covered effect. After qualified normal owner retirement/startup, a strictly
validated prior journal with no intent cannot prove whether an uncommitted
metadata attempt occurred; it establishes only that no admitted transition's
covered effects can be missing, under the stated durability assumptions.
Do not invent an operation receipt or a historical success/timeout from absence.
An observed uncertain metadata write remains an uncertain I/O observation in
its original caller; this rule is not authority to retry that call.

Once an intent was confirmed, every later uncertain acquisition, Close, journal
update or logical effect has an already durable original UUID/boot/fence. A
restart must retain that nonterminal fence even if a later record update was
lost. Missing/corrupt protected state never becomes an empty journal/default
approval. This distinction applies only to the first metadata-only admission
barrier, never to a provider, file, command, Settings or publication effect.

## Cross-owner protocol

TS drives short Go RPCs: Admit/Prepare -> Withdraw -> strict Settings CAS ->
Stage -> Finalize. Go retains native handles/state between calls, not mutexes
across awaited TS work. Never call into TS while holding Store, ingress,
activation or transition locks. Every admission path honors the reservation.

Before EACH covered effect persist its intent, then dispatch it once, then
retain the exact original-operation result. Do not infer a missing result from
equal current bytes.

- Withdraw once, retain exact fence/store revision, and settle old admissions.
- TS alone uses conditional expected-revision save and exact readback. Advance
  revision/generation and change only eligible binding/continuity evidence,
  preserving the complete agreed policy and invalidating stale checks.
  Use a narrow strict path, never generic fallback-as-success.
- Requalify both original native chains before staged Go CAS/publication.
  Keep Settings, Chat and connector admission unavailable even when new approval
  bytes exist. Require exact operation/fence/revision/generation/digest ACK.
- Recheck chains and current policy, then Close each native owner once with a
  classified receipt. Unknown cleanup does not authorize a numeric-fd retry.
- Construct the terminal certificate only from prerequisites ALREADY
  acknowledged: consent, Settings commit/readback, Go publication ACK and known
  cleanup. Confirm its protected publication before current activation.
  Current activation failure is not a usable-completion result.

A known refusal/cancellation BEFORE withdrawal has its own closed terminal
certificate kind. It requires positive original-runtime proof that no withdrawal,
Settings or publication effect was dispatched, and known cleanup receipts for
every acquired native owner. Confirm/qualify its journal publication with the
same rules. It releases ONLY its own transition reservation: no new approval,
grant, supersession or revival of withdrawn handles. Current admission still
uses the unchanged protected policy and native guards. Do not infer this
certificate after restart from absent receipts; a missing cleanup receipt or
any uncertain/partial authority effect uses the nonterminal recovery rule.

The stable permission fingerprint is the complete OWNER-CONSENT projection:
owner/computer/workspace and fixed root, access, exclusions, owner-authorized
capability limits and network, selected Commands, file/Git choices and owner
restrictions. Ephemeral device/FSID, revisions, generations, timestamps,
verification observations and publication receipts are separate facts.

Do not copy `ShellVerified` across a rebind or treat it as enduring consent.
It is current readiness evidence: `ownerSettingsComputerApproval` derives it
from current generation/build/root checks, and `connectorshell.go` gates shell
preparation on it. Preserve and revalidate that exact effective-approval field;
invalidate stale proof and withhold shell capability until fresh current checks
qualify it. Likewise recompute effective capabilities/Commands from current
readiness within unchanged owner-authorized limits. The effective approval/
publication digest binds those current fields; it is not the stable consent
digest. Current admission enforces binding, generation, expiry, `ShellVerified`
and finite-grant restrictions. Neither fingerprint renews authority.

## Terminal certificate and caller knowledge

The certificate is a commit record, not proof its own write/RPC returned.
It must not encode its future fsync/readback or activation as already observed.

After qualified retirement of the old owner and exclusive protected ownership,
a successor may establish CURRENT durability of the exact existing certificate:
guarded descriptor-relative read, strict validation, file sync, directory sync
and exact reread under unchanged identity/digest, as in access `disk.confirm`.
A failed qualification stays fenced. A crash during qualification requires
fresh qualification by the next owner, not replay of a logical effect.

Only a complete valid certificate with the receipts required for its closed
committed/refused kind qualifies.
Equal Settings/Store bytes, intent/prepared records or missing prior ACKs cannot
supply a certificate. Reconciliation may report the original UUID's qualified
logical commit; it does not repeat save, withdraw, publish, finalize or Close
and does not itself activate a connection.

Caller delivery is a DIFFERENT fact. This Go journal does not promise durable
custody for a timeout/success observation made after certificate construction.
Preserve any caller observation that its owning mechanism actually recorded;
do not rewrite an existing UNKNOWN as received success. With no durable
caller-observation record, report `not_recorded`, not an inferred success or an
invented historically observed timeout. No independent generic caller journal
is proposed. A qualified logical commit and unrecorded/uncertain RPC delivery
can coexist; expose that distinction without replay.

## Restricted new-consent recovery

A nonterminal intent or missing prerequisite receipt remains unresolved.
For this rare V1 recovery require explicit NEW native folder confirmation after
a valid DIFFERENT trusted `kern.bootsessionuuid` from the original intent and
a qualified exclusive access-store lock. Same boot, PID reuse, run-marker
absence, a new runtime nonce, missing boot proof or lock uncertainty refuse.
Do not add a same-boot new-consent alternative without a new decision.

The trusted OS boot boundary proves old processes/descriptor owners cannot
still act; it is not proof that their effects succeeded. Other owners' unsettled
effects remain gated by those owners. Preserve the original UNKNOWN record.

Successful new consent atomically publishes its COMMITTED terminal certificate AND a
supersession link naming the exact parent/successor UUIDs/request digests,
historical receipts and fixed profile/computer/workspace binding. The parent
outcome remains UNKNOWN; only its admission fence is monotonically discharged.
Unknown/partial publication is not discharged until the exact valid certificate
is qualified under the terminal-restore rule. Malformed/cyclic/mismatched links,
foreign binding and incomplete successors stay restricted.

Startup performs two independent checks: validate the historical journal/
discharge graph against its own original records; then qualify CURRENT protected
Settings/Store approval and fresh native admission. Historical revisions/digests
are not compared to all later Settings versions. Preference edits, authorized
scope changes/removal, remount and repeated restart do not resurrect a validly
discharged old fence. A new pending/UNKNOWN effect has its own unresolved fence.
Late parent replies are observations only, never activation.

## Compatibility, alternatives and acceptance

The 0.5.23 source at `a91048f34013edabe05730b697b11349ffdc3de8`
defines a strict workspace object without continuity in
`src/pkg/product-settings/contract.ts`. This supports static rejection inference,
not installed downgrade qualification.

Qualify compatible Settings/journal readers and usable recovery before enabling
a writer. Pending update/recovery blocks enrollment/rebinding. Do not select
0.5.23 as compatible after enrollment, erase outcomes via profile rollback,
reset the profile, or delete a journal to clear a fence. A local qualified
recovery can avoid requiring two public releases, but is not assumed ready now.

Device-pinned access with manual reconfirmation remains the conservative
fallback before persistence; it leaves the reboot burden. Reject this choice
if write-ahead ordering, single ownership, native requalification, compatible
recovery or the state distinctions cannot be implemented. No deadline waives
these predicates. Final code, package, installed slot and release gates remain
separate from this decision.

## Decisive state oracle and verification

Test the complete protocol at every intent/effect/result/certificate boundary:

- Unknown first-intent I/O: ZERO workspace-handle acquisition or covered effects;
  late completion cannot dispatch them after cancellation/poison.
- First intent absent after qualified restart: no fabricated history; old
  protected state and normal current admission still require qualification.
- Picker cancellation or known refusal before withdrawal with all native cleanup
  confirmed: qualified refused certificate, reservation released, no grant added.
- Confirmed intent followed by acquisition/Close/record uncertainty: original UUID/
  boot/fence survives; no automatic fresh operation or replay.
- Prerequisite drain/record UNKNOWN: no new continuity admission or relabelled
  stop retry. Known completion: snapshot only the resulting current revision.
- Stale ShellVerified/build/generation/root proof: no restored shell capability;
  changed owner consent refuses the stable-policy comparison.
- Same UUID/different payload, competing operations, stale revision/generation/
  policy, active Agent/connector/update and invalid native identity: refused.
- Settings rename/readback or publication ACK unknown: nonterminal, restricted.
- Complete certificate visible after final rename crash: qualify CURRENT
  durability; missing prior receipt, changed bytes or failed sync remains fenced.
- Lost final RPC: qualified logical commit with caller `not_recorded` or an
  actually retained UNKNOWN, never guessed delivery or repeated effect.
- New consent unfinished/failed: old fence remains. Atomic qualified successor
  link: historical UNKNOWN retained, old fence discharged.
- Sidebar edit, legitimate scope change/removal, device change and repeated
  restart after discharge: fresh current checks, no historical revision trap.
- Corrupt/foreign/cyclic graph or newer unresolved effect: restricted.
- Same boot/missing boot/lock contention during new-consent recovery: refused.
- Late callbacks, expired finite grants and original FD reuse: no activation.

Inspect actual picker, generated wire, admission/activation and lifecycle callers.
Use source-bound fault tests plus native directory replacement, mount/ancestor,
current-Data and cleanup cases. Then qualify enrolled-root restart/reboot,
ordinary file/command use, zero implicit provider Send, compatible update/
recovery and the installed public slot. Read-only metadata/prototype witnesses
do not substitute for production feature acceptance.
