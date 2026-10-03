# First install and adoption boundary

This specifies Release's required backend semantics for Distribution. It defines
no currently available CLI, second installer, Desktop wire schema or acceptance
receipt. Core/Identity/Lead must bind the final descriptor, identity, paths and
native parent/admission policy before executable integration. Distribution packages
and downloads accepted bytes, then consumes the single Release install/verify
contract; its DMG sidecar or user-reported digest is not baseline authority.

## Accepted input and evidence

A request binds one operation ID, an immutable Release-verified descriptor handle
and the selected accepted identity/profile. That descriptor must bind the actual
archive/package manifest, accepted source/build/channel, measured app tree and
resource/helper identities. It is not reconstructed from the DMG filename or a
self-reported checksum. The operation's fixed destination is chosen by accepted
composition, not caller-supplied paths, home overrides or mutable display names.

The proposed final production slot is `/Applications/Farol.app`; Dev remains
separate. The current alpha updater's `~/Applications/Farol.app` is a distinct
compatibility boundary requiring exact observation and explicit identity/adoption.
No old helper is redirected to the proposed slot and no baseline is fabricated
from the private promotion receipt format. Native authority must include accepted
parent ownership/permissions and a real profile/work exclusion domain; changing
system permissions, authentication or security policy is outside this contract.

Before effects, Release measures both fixed slots, verifies any existing app
against accepted identity/provenance and records durable intent under admission.
Denied/changing/unreadable evidence is unknown; it never means an absent install.
A hash-only match or closed window does not establish idle/profile compatibility.
Unknown original update/restore/migration operations remain fences, not invitations
to overwrite, move another slot or start another writer.

## Destination cases requiring explicit acceptance

| System slot                | Legacy alpha slot | Required behavior                                                                                                                               |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Both confirmed absent      | Absent            | Admit one first install only after accepted descriptor/admission/intent; never overwrite a later collision.                                     |
| Exact accepted app         | Absent            | Verify that physical installed tree before explicit baseline adoption; do not repeat copy/install.                                              |
| Absent                     | Present           | Observe and verify the legacy install. Its identity/adoption decision precedes any proposed slot move; do not silently create a second install. |
| Present                    | Present           | Report a destination/profile collision. Equal digests alone do not merge two paths or authorize selecting a writer.                             |
| Foreign, unsafe or unknown | Any               | Classified refusal or uncertainty; preserve existing data and intent.                                                                           |

Manual drag installation is not an accepted update baseline. First-launch adoption
must physically measure the app at the fixed slot against the trusted descriptor,
reconcile identity/profile and operation fences, and durably bind that same build,
tree and path. Release owns that baseline; Distribution cannot synthesize it or
reuse a receipt from another generation/path. Profile and journal relocation do
not rewrite unknown outcomes, accepted publications or old helper witnesses.

## Results and one-shot observation

- Installed: exact physical package/tree at the accepted fixed destination and
  confirmed durable baseline after completed admission/intent. This is not GUI,
  LaunchServices, provider or owner acceptance.
- Refused before effect: explicit proven pre-effect refusal with confirmed safe
  admission release. Missing readback or a transport failure is not this result.
- Outcome unknown: retain the original operation/intent/admission and observe that
  same ID. No second copy, rename, updater invocation or fallback executor.

Verification and operation observation remain narrow read-only capabilities.
They do not start the app, acquire authority by inspecting another process, clear
unknown records or replace explicit apply/recovery. The final command/method and
wire encoding wait for the accepted Core contract; publication/install remain the
integration owner's decision. Native first-install, drag adoption, legacy move,
collision, durability/crash, package and installed witnesses are still required.
