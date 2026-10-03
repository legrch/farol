# Computer authority state owner

This slice provides the Go owner for one coherent current participant/approval
view. It implements the accepted `port.AccessRepository.WithSnapshot` without
changing workspace read/list, their published contracts, or the Desktop wire.
It is source and disposable-native implementation evidence, not an activated
production route.

## Ownership and lifetime

`infra/repos/access.Store` is created by trusted profile composition, once per
backend lifetime. Its private directory must already exist, be canonical,
owner-owned, and mode 0700. `Binding` supplies the exact profile, owner and
Computer identities from trusted host state. None comes from a workspace body.

`Create` is an explicit new-state operation: it writes an empty current view and
never replaces an existing file. It does not fabricate approval or participants.
`Open` restores an existing protected view; missing, unsafe or corrupt state is
unavailable. Do not turn an `Open` failure into a `Create` fallback. A possibly
published creation is observed through `Open`, not repeated.

The owner holds an exclusive native `flock` on its private lock file until
`Close`. A second owner, including another process, cannot acquire this state.
The root assembler drains admitted work, then calls `Close` once. The current
store has no background worker or provider/process execution. This lock protects
this exact private state; it is not a general profile process mutex.

Every approval update, admission, delegation and revocation uses this same owner
and its mutex. `WithSnapshot` verifies durable bytes, obtains independent values,
and calls its synchronous callback exactly once while that mutex remains held.
The callback must perform no native IO, repository mutation or reentrant call.
Workspace admission and final response construction already use this callback.
Native file IO remains outside it. An update completed before final disclosure
wins; a later update does not retract bytes already admitted by the callback.

`access.New()` remains the explicitly disposable K1 in-memory fixture. It is not
an activation fallback for `Create`/`Open`.

## Trusted ingress

The Go methods below are privileged composition methods, not wire methods:

| Method                                            | Current-state behavior                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Status(ctx)`                                     | Observe revision, approval generation and presence.                                                                                                                                |
| `UpdateApproval(ctx, revision, approval)`         | Commit current owner consent under the exact binding. An older generation is refused. Same-generation updates may change expiry only.                                              |
| `Admit(ctx, revision, admission, participant)`    | Derive from the current stored approval through existing domain rules. An existing identical participant is observed without a write; rebinding its identity or policy is refused. |
| `Delegate(ctx, revision, parentID, delegation)`   | Narrow the active parent's existing grant through the same domain rules.                                                                                                           |
| `RevokeApproval(ctx, revision)`                   | Remove approval and retain its last generation. Cached approval at that generation cannot restore it.                                                                              |
| `RevokeParticipant(ctx, revision, participantID)` | Revoke that lineage and retain its identities across restart.                                                                                                                      |

Revisions are optimistic concurrency checks inside native serialization. A stale
revision cannot overwrite a newer revocation. They are not stable operation IDs
or a second journal/claim engine. Tombstones prevent stale admission or startup
restore from silently resurrecting consent. Reapproval requires a later owner
approval generation; it is an explicit owner update, not renewal.

The existing `authority.Derive`, `Create`, `Delegate`, `Narrow` and authorization
rules remain the policy mechanism. Raw participants cannot be put into this
store. Restore validates binding, structural limits, counters, roles, scopes,
lineage and inherited exclusions. Store-generated input/output values do not
alias its current state.

The trusted approval producer must supply current owner-approved, physically
bound workspace identities. The trusted task/participant owner supplies the
admission identity and narrowing. The store validates their relationship; it
does not manufacture UI consent, import a request-supplied launch document, or
claim that UID checks alone prove which peer sent a command.

## Native persistence and uncertainty

`computer-access.json` and `computer-access.lock` live only in the directory
supplied by trusted composition. These are new Go current-state files; existing
TS owner settings, launch files and mutation journals are neither read nor
replaced by this adapter. The current-view format is a versioned canonical JSON
document. Counters are decimal strings; expiry preserves the existing positive
safe Unix-millisecond representation. Domain and public wire DTOs are unchanged.

State is bounded to 1 MiB and 256 retained participant identities. Workspace,
exclusion and exact-path bounds retain the existing admission limits. Saturation
fails closed before publication; identities or exclusions are never dropped.
The internal encoding has exactly one form: unknown, duplicate, missing,
differently cased keys, invalid enums/counters and trailing data are refused.

Native checks bind the directory and lock by descriptors and device/inode;
files are regular, single-link, owner-owned, mode 0600 and opened no-follow.
Reads check identity, size, mode, mtime and ctime before/after and against the
named entry. Authority bytes are checked on each snapshot/update. Unexpected
external changes poison the current owner rather than becoming absent consent.
All state writers must cooperate with this owner; these checks are not a sandbox
against arbitrary code running as the owner.

A mutation writes a private unique file, syncs it, rechecks the prior current
bytes, atomically renames, syncs the directory and observes the published bytes
before exposing the new revision. Temporary cleanup is limited to the exact
owned filename. A failure from publication onward is `CommitFailure` with
`OutcomeUnknown(err) == true`, unwrapping to the existing nonretryable
`COMPUTER_AUTHORITY_STORE_UNAVAILABLE` vocabulary. The owner becomes unavailable;
it never serves its previous cached grant after that result.

Reopening after the exact owner is closed begins as an observation of visible
current state. Reading and decoding a file alone never make authority usable.
`Open` must additionally sync the exact protected snapshot FD and its directory,
then recheck the same physical file, binding and bytes. Only that successful
native durability/reconciliation barrier enables the current view. A file-sync,
directory-sync, identity or post-sync observation failure returns no owner and
no authority disclosure. There is no weaker public restore constructor.

This barrier never writes a new snapshot, changes revision, re-derives a grant
or repeats the original update/admission. A published participant can become
observable current authority only after this separate barrier qualifies it;
the original mutation's returned unknown outcome is not rewritten as success.
An unavailable/corrupt view is retained honestly. No automatic mutation retry,
journal deletion, alternate executor or old TS/Python fallback is added.

The tests establish cold restart behavior and native sync acknowledgements for
the exact observed revision. They do not simulate power loss or prove storage
hardware crash durability. In particular, observation before a successful
barrier is not a durable-publication receipt. Unknown operational effects outside
this current authority snapshot remain owned by their existing journals.

## Integration proposals and activation limits

The root owner can construct the existing service chain using the new repository:

```go
// Values come from trusted profile composition, never the read request.
clock := access.Clock{}
owner, err := access.Open(privateComputerStateRoot, trustedBinding, clock)
if err != nil {
    return err // Unavailable; explicit new-state creation is a separate decision.
}
native := filesystem.New(trustedHome)
service := workspacesvc.New(owner, native, clock)
contract := workspacect.New(service)
// Register the existing desktop.ReadMethod with Core's exact backend context.
// Root lifetime drains work and closes owner once.
```

Proposed shared changes remain with their owners:

- Core/Lead `boot/application.go`: inject the repository/native/live clock into
  existing constructors and existing method registration; own drain/teardown.
  No read wire, handwritten socket protocol, or default approval is required.
- Desktop/Lead: transfer current owner approval updates and participant admission
  to this sole owner through the shared trusted ingress chosen with Core. Revoke
  authority before acknowledging a settings revocation. Independently mutating
  TS authority and relying on this Go mutex is not a coherent authority system.
- Core/Lead/Desktop: preserve the distinct meanings of backend incarnation,
  task epoch, Computer approval generation, and read-body correlation. Trusted
  current-turn binding must come from its existing owner before activation.

The accepted-base Go read still uses its original grant expiry behavior. This
slice does not port the separately frozen TS TaskGrant reissue/execution-lease
hotfix or claim same-chat renewal. That parity and its concurrent-operation
limits remain an explicit prerequisite before production activation. Current
settings/launch migration, public trusted-ingress registration, packaging,
installed state and same-chat Brain/code qualification are also not completed.
No active TS/Python executor is removed.

## Evidence

Disposable tests use real native files, protected directories, atomic publication,
filesystem reads and an exact owned child to qualify the lifetime lock. They
cover coherent concurrent mutation/disclosure, generation and lineage revocation,
immutable participant reuse, restart, unsafe files/roots, corrupt restore, bounded
schema, lossless counters, expiry and cancellation. The native read tests execute
`workspacesvc.New(store, filesystem.New(trustedHome), clock)` and refuse revoked
or changed authority before bytes are disclosed.

The clock and the file/directory-sync failures after a real rename or during
restore are controlled fixtures. They do not prove a real disk fault, power-loss durability, a current
owner's consent, installed filesystem/connector behavior or a provider turn.
Darwin/arm64 execution and Linux compilation are separate checks. Required R4
review remains pending under the program's no-Astra rule and current Claude quota
block; no alternative review route is silently selected.
