# Workspace continuity: scoped implementation decision

Status: proposed, before production wiring. Decide before implementing the next
folder-continuity slice. The accepted explicit connection-check decision is a
separate target and is not reopened here.

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

Initial eligible scope: qualified local writable APFS, trusted kernel and protected
approval store. Refuse missing/unsupported attributes or validity bits, read-only
snapshots, ownership-ignoring mounts, ambiguous mounted identities, different
volume/directory/path, symlink or ancestor substitution and inconsistent readings.
A privileged clone/replay reproducing all enrolled identity and protected host
state is outside the guarantee. No detected mounted duplicate does not establish
that no unmounted clone exists. Known clone/restore or ambiguous identity requires
explicit reconfirmation. This is a proposed trust assumption to challenge, not a
claim that filesystem metadata proves an uncloned physical history.

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
It is not active production source. Reviewers may inspect its exact Go packages
and the named native witnesses; no execution or extraction is required.

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
