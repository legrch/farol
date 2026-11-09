# Workspace continuity and explicit connection checks

Status: proposed, before production wiring. Source baseline:
`a91048f34013edabe05730b697b11349ffdc3de8`.

## Outcome and evidence

An approved folder must survive an ordinary reboot or remount without being
removed and added again. An explicit connection check must establish its first
receipt after restart without requiring an already-current attachment. Saved
onboarding is historical completion; current connection and test outcomes are
separate facts.

The current persisted workspace identity contains only device/inode. An observed
device-number change with the same inode refused access; its exact historical
cause is unproven. The toolbar invokes the ordinary manual deep-test path, which
requires a current attachment. The separate verifier can instead consume the
current challenge. An isolated actual-button test reproduces the wrong dispatch;
an extracted-backend test confirms the existing attachment guard. Those fixtures
do not prove installed/provider operation or real reboot behavior.

## Decision 1: one explicit verification route

Route visible connection-check controls through one bounded coordinator that
reuses the existing challenge/status verifier and exact receipt owner. Do not
remove current-attachment admission from ordinary deep tests. Do not repair,
reconnect, switch app, or send a provider request implicitly on startup.

The coordinator resolves bootstrap/status/blocked mode from trusted current state.
Carry the caller's original operation ID through strict command parsing,
idempotency, durable dispatch custody and result observation. Changed payload for
the same ID refuses. Duplicate IPC, lost replies and rerenders never cause another
Send. Preserve existing uncertain and legacy attempt records.

Before opening a temporary diagnostic chat, inspect and recheck the original
retained document for a draft, staged attachments, active generation and ownership.
Refuse before navigation when these cannot be excluded. Describe the temporary
chat behavior in the control's help text. Keep final app/model/document fences.

Keep known predispatch refusal, acknowledged Send, receipt confirmation and unknown
dispatch/verification distinct. A refusal after dispatch must not claim nothing
was sent. Delivery acknowledgement does not settle an unknown effect. Introduce
only closed, sanitized reason/stage evidence, without prompts or profile dumps.

Existing one-shot ownership should be reused where its contract fits. New backend
policy and retention belong to Go, composed in boot with consumer-owned browser
and storage ports; Desktop remains an adapter. Do not introduce another connector,
settings writer, generic task engine or competing verification state owner.

## Decision 2: persisted continuity, current native binding

Keep the shared live root identity as device/inode. Add a separate strict optional
continuity record on each approved workspace: policy/schema, computer/workspace,
fixed canonical path, APFS volume UUID, persistent directory ID, birth time, and
trusted explicit enrollment correlation. Bind its digest into generation/current
approval projection. IDs must preserve their full native precision.

Initial scope is qualified local writable APFS under a trusted kernel and protected
approval store. Refuse unsupported or missing attributes, invalid capability bits,
snapshots/read-only or ownership-ignoring mounts, ambiguous mounted identities,
different volume/folder/path, symlink/ancestor substitution and inconsistent
observations. A complete privileged clone or replay that reproduces both enrolled
identity and protected host state is outside the guarantee. Absence of a detected
duplicate does not prove that no unmounted clone exists. Known clone/restore or
ambiguous identity requires explicit reconfirmation. Do not claim protection
against indistinguishable physical histories or add an external identity service.

This scope is an explicit proposed security assumption for independent challenge;
it must not be silently accepted as evidence that metadata defeats full cloning.
The conservative alternative is device-pinned access with explicit reconfirmation.
Native bookmarks may supplement path selection but are not assumed clone-proof.

## Enrollment and transition

Legacy approvals do not acquire continuity from a matching inode, successful Verify
or a new application version. Offer one explicit native-picker Confirm folder
transition that preserves the workspace ID, rights, exclusions and command/Git
choices. A different selected root is a normal scope change. Cancellation or
uncertain publication preserves the original record and custody.

Go owns measurement/comparison, eligibility and one-shot transition custody.
Trusted host composition supplies the saved approval and expected revision; a
renderer path or caller-provided settled boolean cannot authorize a transition.
The host-only observation capability must work before old dev/inode-based normal
workspace admission and must expose no file enumeration or execution escape.

Withhold usable authority while changing its projection. Require settled existing
owners, no active dependent work, exact permission fingerprint and revision;
measure the fixed path through held no-follow descriptors; prepare and independently
requalify the new binding; commit through the sole settings writer with CAS/readback;
then activate only from exact acknowledged publication and final native checks.
Advance generation and retire old authority. Keep live descriptor guards for every
later operation. Unknown save/publication and descriptor cleanup remain fenced.
Never rewrite historical journals or revive old handles. Integrate same-build as
well as new-build startup; restore local runtime/challenge without provider Send.

## Compatibility and qualification

Qualify compatible readers before writing the new field. A predecessor used for
update rehearsal must understand the resulting profile; binary rollback must not
restore an old profile snapshot or erase newer outcomes. Private drafts with final
immutable bytes are the initial candidate mechanism: not-Latest alone does not
exclude a release from the current updater catalogue.

Required checks cover saved setup + current challenge + absent attachment;
duplicate IDs/lost replies; postdispatch unknown; drafts and attachments before
navigation; exact app/model selection; current fresh status evidence; unchanged
ordinary deep-test guards and startup zero-Send. Continuity checks cover actual
device-renumbering remount, real reboot separately, Data-volume firmlinks, different
volume/folder, same-path replacement, symlink/race, legacy/cancel, concurrent edits,
stale generations, unknown save/readback/publication and old-reader compatibility.
Synthetic identity changes and same-boot reopen do not prove reboot behavior.

Independent decision review precedes production wiring. Exact committed source,
full CI, native/package qualification, installed connection and update witnesses,
and the repository's integration/publication decisions remain separate gates.
The first useful implementation checkpoint is the explicit-check regression and
smallest custody-preserving routing slice, not a general orchestration rewrite.
