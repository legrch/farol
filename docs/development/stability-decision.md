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

## Decision feasibility references and bounded native evidence

The desired reboot behavior above is an acceptance objective, not an executed
reboot claim. This decision selects a design for implementation; production
activation still depends on the separate qualification gates.

Primary platform references:

- [Apple getattrlist manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html): persistent object-ID semantics across unmount/mount, creation time, returned attributes and capability validity. Its older object-ID examples do not replace modern 64-bit attributes.
- [Apple XNU attribute definitions](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/attr.h): `VOL_CAP_FMT_64BIT_OBJECT_IDS` requires `ATTR_CMN_FILEID`/`ATTR_CMN_PARENTID`; `ATTR_VOL_UUID` and returned-attribute bits supply the other measurement inputs.
- [Apple stat manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/stat.2.html): current device/inode and native birth-time fields. A device ID is not a machine identity or persistent consent record.

Source-bound experimental measurement already exists as an unapplied proposal,
not production authority. Its archive SHA256 is
`7cdc71abc39e6c633562203c1881cb8890c7078bc906f65ae32db0bcb33d247a`.
The current task retains it at
`_output/evidence/workspace-root-pro-a91048f3/` with per-file hashes and
`HOST-VERIFICATION.json`. The native adapter requests descriptor-bound attributes,
checks supported/valid capabilities and lossless decimal IDs, and leaves its
comparison result non-authorizing.

A new independent Go 1.26.2 darwin/arm64 probe ran those exact primitives:

- Read-only measurement through the Data-volume `/Users/...` firmlink succeeded.
- A disposable APFS image was genuinely detached and remounted after another
  owned image occupied the released device slot. The current device ID changed;
  volume UUID, directory file ID and birth time remained equal, as did the inode.
- All exact owned images were confirmed detached, then removed with the compiled
  probe and its cache. Initial command-argument and fixture-permission failures
  remain recorded separately; they are not counted as successful remount tests.

The bounded receipt is
`_output/evidence/stability-handover-a91048f3/native-continuity/remount-receipt.json`,
SHA256 `571a00af129e575e9981b8dd4a03278d467387b63c55385aefc6d69c0d6b1864`.
The same directory retains the probe/script, firmlink observation, original failed
setup receipts and `SUMMARY.json`. These are private current-task evidence, not
required public runtime resources. They prove native readability and this actual
remount case, not a real reboot, migration/publication, automatic rebinding or
clone/restore protection. Those remain explicit later acceptance gates.

The actual-button characterization mentioned above is named
`STABILITY toolbar routes explicit verification without requiring an existing attachment`.
It renders `ConnectionTestButton` with `toolbar=true`, saved setup, ChatGPT
destination and `attachment=null`, verifies that the button is enabled, clicks
it, and observes the unwanted `chatgpt.run-deep-test` command. The failing
assertion requires this explicit check not to use that attachment-dependent route.
Its exact case and RED output are retained in
`_output/evidence/stability-handover-a91048f3/toolbar-routing-regression.txt` and
`toolbar-routing-red.log`; the original renderer suite has 16 passing cases.
The separate extracted-backend refusal is a characterization of the guard that
must remain, not a request to remove it. These scripted-host tests establish
routing/preconditions only; no provider request or installed operation occurred.

## Actual reboot observation, 2026-11-10

After the owner manually restarted the Mac, the same read-only Go 1.26.2
observer measured the same fixed approved path. The boot-session identity
changed; the observer binary and all measured source hashes remained equal.
APFS volume UUID, persistent directory file ID and birth time all matched the
pre-reboot observation. Both measurements exited zero. The device number and
inode also remained equal in this particular reboot; it does not reproduce the
separate device-renumbering remount case above.

The task retains exact before/after observations, source manifest, controller
and comparison under
`_output/evidence/stability-handover-a91048f3/reboot-observer/`.
This closes only the missing read-only real-reboot metadata witness. It does
not qualify production enrollment, migration/publication, automatic rebinding,
installed app connection, provider calls or updates. No folder approval or
Farol profile was changed by this observation. Earlier review outcomes remain
unchanged; the updated decision still needs independent acceptance before
production wiring.
