# Workspace continuity: scoped implementation decision

Status: decision accepted for implementation at
`5876dc2c56a65b924a463c11bf4a8a72ac89eb87`; production wiring and feature
qualification remain open. The accepted explicit connection-check decision is a
separate target and is not reopened here.

The cumulative R4 decision review completed with General, Security, Architecture,
Strong and Frontier coverage. The wording finding about the missing-pair case
was fixed and independently rechecked by both originating reviewers. This records
a design decision, not source, package, installed or release acceptance.
The read-only observation foundation was subsequently integrated in
`56acc40f20b5dbd19cb318eebe7e5d81303b762a`; it changes no workspace authority.

## Question and outcome

Should Farol retain a strict persistent continuity identity separately from its
current device/inode binding, then requalify the current binding after ordinary
APFS remount/reboot? The goal is to stop requiring remove/re-add for the same
approved directory while preserving its workspace ID, rights and exclusions.
A different or ambiguous root must remain blocked. No deadline waives admission.

Preferred direction: qualify compatible readers first, then explicit enrollment
and one Go-owned transition. Backend policy stays in Go and settings publication
uses the existing sole writer. No production activation is claimed by this packet.

## Proposed contract

Retain current device/inode for every live descriptor guard. Separately enroll
strict versioned continuity evidence: computer/workspace, fixed canonical path,
APFS volume UUID, lossless persistent directory file ID, birth time and explicit
native-picker enrollment correlation. Bind its digest into the current approval
projection/generation. Follow the enrollment and publication protocol in
[the earlier proposal](stability-decision.md#enrollment-and-transition), including
withheld authority, settled dependent owners, exact permission fingerprint,
expected-revision CAS/readback, no-follow descriptors, independently requalified
binding and acknowledged publication before activation. Unknown save/publication
or descriptor cleanup never authorizes another transition or old-handle revival.

Legacy approvals never gain continuity from an equal inode, a successful Verify
or an upgrade. Offer an explicit Confirm folder transition preserving workspace
ID/rights/exclusions/command choices. A different selection is a scope change;
cancellation preserves the original record. Measurement before ordinary workspace
admission is a host-only observation capability with no listing, content read or
execution escape. Do not reset credentials, rewrite journals or silently reacquire
permissions. Same-build and new-build startup must both use current native guards;
restore local runtime without provider Send.

## Narrow v1 eligibility and clone fence

The initial general-local-APFS recommendation is withdrawn. A real native
experiment byte-copied a detached disposable APFS image, then mounted its clone
at the original path while the original remained unmounted. UUID, file ID and
birth time matched; device changed. Only fixture-image bytes were copied, not
Farol state. Thus this metadata tuple cannot distinguish those physical images.
The complete reproducible controller and observations are named below; the
counterexample does not depend on accepting a reviewer's conclusion as evidence.
Earlier reviews remain unaccepted, without coverage carried to this target.

V1 automatic recovery is limited to directories on this Mac's current INTERNAL
startup Data filesystem. External disks, disk images, network mounts, other APFS
volumes and unproved startup provenance remain device-pinned/manual-confirmation
cases. An `Internal` flag, a familiar path, matching UUID or absence of a mounted
duplicate is never sufficient by itself.

Add a Go-owned trusted native startup-anchor port. It must acquire the current
system root and its paired Data mount independently of caller input, prove both
are local internal APFS and the Data mount belongs to the current startup volume
group, and hold no-follow descriptors through the check. Candidate and trusted
Data descriptor must have equal CURRENT kernel filesystem identity and device,
with consistent mount data. These values are ephemeral comparison evidence,
not persisted cross-boot identity. Requalify the anchor/descriptor chain before
publication and final activation, keeping the original runtime/boot epoch.
Missing, unsupported, stale, conflicting or replaced anchors refuse automation.

A bounded allowlisted native adapter may use the trusted system disk utility's
structured root/Data metadata to establish pairing, combined with descriptor-bound
kernel observations and strict before/after consistency. Fixed host-owned queries
only; no caller paths/commands, raw diagnostic disclosure or ambient shell. The
actual adapter and current platform interface need qualification before wiring;
missing fields must refuse rather than infer provenance from the path. The
existing probe does NOT implement this anchor. Its classifiers stay non-authorizing.

This rejects a copied workspace volume mounted at the old workspace path: even
with forged/copy-matched UUID/file ID/birth, it is not the current trusted startup
Data filesystem instance. An attacker-controlled ordinary mount cannot nominate
itself as that anchor. Scope assumes the trusted running OS and protected Farol
state; privileged replacement/restore of the startup Data filesystem or alteration
of startup policy is outside this guarantee, WHETHER OR NOT Farol state is copied.
Known restore/boot-environment changes require explicit reconfirmation. Do not
claim cryptographic physical-history or protection from privileged startup replay.

Keep the existing attribute validity, writable/ownership, fixed-path and
symlink/ancestor/race checks. The prior broader proposal remains relevant to
transition mechanics only; this section controls v1 eligibility/trust scope.

Compatible readers must qualify before a writer persists the optional field.
Older-reader rejection, downgrade and interrupted publication must be assessed
before choosing a predecessor for update testing. Never roll back a profile
snapshot to erase newer outcomes. The existing strict live guards remain until
the full transition is accepted. Each implementation slice gets its own source
checks; the final feature needs native/package/installed/update qualification.

## Alternatives and reversibility

Device-pinned access plus explicit reconfirmation is the conservative fallback:
less implementation risk but retains the recurring owner burden. Native bookmarks
can support selection but are not assumed clone-proof. Do not weaken the guard to
inode-only or canonical-path equality and do not add an external identity service.
Reader-only delivery is reversible; persisted state and active transitions need
qualified compatibility and recovery before activation. Cost of delay is repeated
manual recovery; it does not justify silently broadening filesystem authority.

## Decisive native evidence and limits

The task retains an unapplied observation-only source proposal in
`_output/evidence/workspace-root-pro-a91048f3/farol-workspace-identity-a91048f3-NOT-APPLIED.zip`,
SHA256 `7cdc71abc39e6c633562203c1881cb8890c7078bc906f65ae32db0bcb33d247a`.
Its 17 Go observation files are now integrated in the checkpoint named above,
without production composition or authority wiring. The archive remains the
original proposal input. Reviewers may inspect current Go source and the named
native witnesses; no execution or extraction is required.

- A disposable APFS image was actually detached/remounted after another owned
  image occupied the released device slot: device changed; volume UUID,
  persistent file ID, birth time and inode matched. The Data-volume firmlink
  observation also succeeded. Receipt:
  `_output/evidence/stability-handover-a91048f3/native-continuity/remount-receipt.json`,
  SHA256 `571a00af129e575e9981b8dd4a03278d467387b63c55385aefc6d69c0d6b1864`.
- The owner actually rebooted the Mac. The same Go 1.26.2 observer and source
  hashes measured the same fixed path across different boot sessions. UUID,
  file ID and birth time matched. Device/inode did not change in this boot.
  Full kit, before/after JSON and source manifest:
  `_output/evidence/stability-handover-a91048f3/reboot-observer/`.
  `comparison.json` SHA256:
  `705f53a36ff54ea8b08a8274e1e25cfa4a9c5ee2c63539232f0c4936d45e8d95`.

These read-only witnesses establish metadata persistence in the two named native
cases, not production migration, consent/publication, automatic rebinding,
installed connection or update safety. The old incident's exact cause remains
unreconstructed. Earlier reviews stay unaccepted; these new observations do not
retroactively change their outcomes.

Platform references and their bounded semantics are linked in
[the native feasibility section](stability-decision.md#decision-feasibility-references-and-bounded-native-evidence).
Modern 64-bit file IDs and returned capability bits are required; older object-ID
examples are not sufficient implementation guidance.

## Falsification and rollout checks

Before wiring, challenge the trust scope, availability of a single transition
owner, compatibility order and precise failure/unknown handling. Reject the
preferred design if it admits a different directory or requires treating an
unconfirmed publication as authority. Test replacement, symlink/ancestor race,
different volume, invalid attributes, legacy/cancel, rights changes, stale
revision/generation, active dependent work, partial save/readback/publication and
restart at every transition boundary. Replay no unknown effect.

Then qualify actual enrolled-root behavior on remount and reboot, ordinary file
and command use under current guards, compatible update/recovery and the installed
slot. The existing read-only witness is not a substitute for these feature tests.

## Current anchor feasibility observation

The current Mac reports equal nonempty APFS volume-group IDs for the fixed system
root and Data query, both internal APFS. Held descriptors for the Data directory
and the selected home directory report equal current device/filesystem IDs.
The selected sanitized properties and probe limits are retained at
`_output/evidence/stability-handover-a91048f3/startup-data-anchor/observation.json`.
This is preliminary interface feasibility, not proof of full ancestor safety,
anti-clone admission, boot-policy attestation or implemented transition behavior.

Require tests where a clone-shaped tuple with a DIFFERENT current filesystem
instance is rejected, including no concurrently mounted original. Also reject
external/image/unpaired anchors, missing root/Data group evidence, mismatched
kernel/device/metadata observations, mount replacement and boot/runtime changes
between preparation and publication. Qualify the positive current startup-Data
case, then the full enrolled-root feature across reboot separately. The earlier
remounted images remain metadata witnesses, not newly eligible v1 workspaces.

[Apple statfs manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html)
documents descriptor-bound filesystem statistics; it does not make a filesystem
ID a persistent or cryptographically authentic volume identity.

## Native clone and anchor-boundary experiment

A new standalone experimental native controller now exercises the proposed
observation mechanism, independently of the unapplied Go comparator and future
settings transition. Review its exact code and receipt at
`_output/evidence/stability-handover-a91048f3/native-anchor-clone/`:

- `probe.py`, SHA256 `e3a8391df5aad6790afd52ed1b803947a4670f53d231b43e63048eeb8c561147`;
- `receipt.json`, SHA256 `4a294f84971bfa79c15927cde3268941a8f44994958196ea26d6578806f20401`;
- `SUMMARY.json` and `README.md` name the original Go observer/source, runtime,
  cleanup inventory and reproduction/qualification limits.

The controller checks fixed system/Data group properties before and after held
no-follow descriptor walks and obtains actual descriptor filesystem/device IDs.
Its native positive case accepts the existing home directory as on current Data.
A real byte-copy image retains the original directory tuple with a different
device and no mounted original; both original and clone are rejected as outside
startup Data. No original startup Data or protected Farol state was copied.

An owned initially eligible directory is then shadowed by the fixture image while
its old Data descriptor remains held. Fresh observation rejects the shadowed path
and records the different reopened filesystem. A same-Data directory replacement
still passes the filesystem-only filter but fails the separate directory identity
comparison, showing why both checks are required. An actual prior boot-session ID
from the earlier reboot witness is rejected against the current epoch. The case
named `missing_pair_record` empties only the retained expected anchor; it proves
expected-anchor mismatch rejection, not acquisition rejecting missing root/Data
group fields. That acquisition case remains unqualified and required before
production wiring. No real system-volume replacement was performed.

The Python/native prototype establishes these interface and observation-boundary
cases; it is NOT the Go production adapter, a live lease, settings CAS, actual
authority publication or full feature acceptance. In particular it does not prove
that the future adapter holds its validated descriptors through publication.
The disk images are real clones but neither is an eligible startup Data volume;
privileged startup replacement remains outside the stated trust boundary.
All exact owned images were confirmed detached and removed with their scratch
copies. Hashes were checked at archival, not as a whole-Git before/after execution
manifest. Preserve these limits when evaluating feasibility and later Go tests.
