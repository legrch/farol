# Computer TaskGrant reissue and execution leases

This is a source prerequisite for Go activation. It ports the lifetime behavior
of frozen TS `24be563456c8570025542da4234bce2c1eb8626d` using the existing Go
`authority.Derive` and sole `AccessRepository` owner. It adds no Task/Turn engine,
public request, wire schema, boot registration, executor or production fallback.
The native state-owner dependency is unaccepted Computer `9ee44d8` projected
into this writer from accepted `acb131d`.

## Two lifetimes

| Value           | Admission and expiry behavior                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outer TaskGrant | Freshly derived under independently current owner approval and an already admitted sealed ceiling. Its 12-hour lifetime is capped by current approval expiry. An expired template can supply the same ceiling only with trusted current task admission. |
| Execution lease | One private snapshot and deadline for one admitted operation. Ordinary/read/mutable budgets are 15 seconds; composite verification is 120 seconds. The deadline is capped by approval expiry at admission, independently of the outer expiry.           |

Renewal changes time alone. Owner, session, task, task epoch, authority ID,
Computer ID/generation, participant identity/role/ownership/parent, physical root
identity, Git metadata, scopes/exact paths, exclusions and capabilities remain
the sealed ceiling. Current approval must equal the sealed approval policy,
ignoring expiry alone. Even newly approved roots or capabilities refuse renewal
under that ceiling rather than being imported. The native owner separately
retains generation and participant-lineage tombstones across restart.

`execution.Service.Admit` observes current state and derives through existing
policy rules. It does not write a new durable participant, update consent,
re-admit a revoked identity or extend a previous operation. Returned `Lease`
values keep private copies and expose only independent snapshots. Concurrent
requests or a new issuer after reconnect cannot replace another lease.

The existing grant expiry convention remains inclusive. The execution deadline
is exclusive: at the exact deadline, no new execution phase/disclosure is
admitted. Invalid clocks, durations and safe-millisecond overflow refuse.
Reissue and lease policy are pure; the wall clock is injected through the existing
consumer `port.Clock` and supplied by native composition.

When the admission clock includes a monotonic reading, the fixed execution
deadline retains it even when persisted owner expiry caps the budget. The cap
keeps the same wall instant; a later wall-clock rollback cannot extend the
original elapsed execution budget. Current owner checks can still refuse early.

## Current trusted task admission

`port.CurrentTaskAdmission` is a consumer-owned projection port, not an owner of
Task/Turn lifecycle or consent. Its real adapter must be supplied by the existing
trusted Task/Chat owner and bound to the exact route admission. `TaskBinding`
projects the existing authority identity, participant ID and trusted turn ID.
Request-body generation/turn/call IDs remain correlation until their existing
owner binds them. An ambient latest-task lookup or body-built binding is invalid.

The callback is mandatory, synchronous and exactly once. Missing admission
refuses with existing `AUTHORITY_TASK_MISMATCH`; unavailable or malformed owner
behavior is classified with existing nonretryable authority-store vocabulary.
No default/fake `current=true`, cached consent, global singleton or ambient
per-operation context exists. The real owner must ensure a revoked task/turn
identity cannot be resurrected under the same task epoch; Computer does not
invent a second revocation journal for that owner.

Every lease snapshot checks both owners again, including after native IO and
immediately before existing app response construction. A different current turn,
task identity, participant lineage/policy or Computer approval policy refuses.
A current owner expiry can stop execution early; renewal cannot extend its
fixed deadline. Closing the old native owner after restart makes old leases
unavailable. A new issuer requires the original seal plus independently current
owner and task admission; decoding a launch document alone is insufficient.

## Lock order and operation ownership

Lead selected this source order; the real owner adapter and activation remain
unqualified:

```text
Computer AccessRepository.WithSnapshot callback
  -> existing current Task/Turn admission callback
    -> synchronous admission or response construction
```

Computer's native state qualification finishes before its inspect callback;
therefore it also finishes before entering the task gate. The task projection
must perform no native IO anywhere in `WithCurrent`, including before its callback.
Both callbacks forbid reentrancy, owner mutation, unrelated waits and native IO.
The owning Task/Chat adapter must never acquire Computer while holding its task
gate. Native workspace IO runs after initial callbacks return and before final
callbacks. Native Store qualification must never run under a Task-held gate.
A revocation completed before disclosure wins; one completed after disclosure
does not retract admitted bytes. The adapter must honor this order for every
cross-owner operation; a reverse acquisition is not supported.

Task completion/revoke first invalidates admission under its own gate and
releases it before any separate Computer revoke/update. While persistence or
both coordinated effects are unsettled, it must never expose stale positive
admission or claim successful coordinated revocation. The real Task/Chat owners
must validate their lifecycle, persistence and unknown semantics. Computer owns
none of those effects. Published Chat/Task callback contracts and the Computer
[peer adapters](admission.md) now supply the source mapping. Their concrete real
owners and persistence are still missing; a provider/journal `Status` call, independently copied startup
state or cache is insufficient.

A root/contract assembler can admit a lease for the parsed owning operation and
inject that exact lease into existing app services. For a read, the proposed
composition is `workspace.New(lease, nativeWorkspace, clock)` followed by the
existing read contract. Keep the same lease through admission, IO and disclosure;
never call `Admit` again between phases. A lease belongs to one operation, not a
connection, service-wide current execution or permission to dispatch effects.
The real operation owner selects the matching fixed budget. Native timeouts and
cancellation remain separate enforcement; this slice adds no timer/process
executor or claim that a timed-out child was stopped.

The implemented cross-module mapping belongs in infra/peer/admission and
consumes only the existing owner's published contract. Core owns shared transport/schema;
Task/Chat owns the actual admitted turn binding; root composition owns lifetimes.
The proposed port is not a license to import another module's app/domain or add
common commands here. Lead owns the shared contract/lock-order decision.

## Effects and evidence limits

Reissue is observation and pure derivation. It never admits durable mutation
intent, clears a journal, dispatches shell/Git, retries admission/IO or replays
possible effects. Classified errors preserve original wrapped unknown state.
A qualified later current-state observation does not turn the original unknown
publication into a successful outcome. Existing mutation and process journals
remain unchanged and continue to own exact operation IDs and unknown intent.

Clock-controlled tests cover expired outer grants, new trusted fixture turns,
new issuer/reconnect, concurrent leases, deadlines, current expiry,
revocation/generation/policy/physical-root/lineage changes and mandatory task
proof. Real disposable native store/filesystem tests cover read/list across
renewal, cold restart, tombstones and retained unknown authority publication.
These fixtures prove neither real ChatGPT turn admission nor connector
reconnect. No production/public Go route is activated here; no TS/Python executor
is removed. Mutable, verification, shell and Git executors are not supplied by
this slice. Budget tests are not execution parity for those operations.

Required R4 review remains pending under the existing Claude quota/no-Astra/no
fallback fence. Shared trusted ingress, current owner settings/launch migration,
Core registration, packaging/install and live same-chat Brain/code acceptance
remain Lead-owned activation prerequisites. Read-only local/native tests cannot
replace that live acceptance.
