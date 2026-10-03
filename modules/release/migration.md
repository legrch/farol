# Migration admission lifetime

This is a source-only correction to the preparation checkpoint at
`9520caae2e7cfdb96b9863b6a4b38eaf9d7be750`. That earlier per-handle port is not
accepted for physical composition: two filesystem instances could both arm from
Prepared and a second could attempt a rename after the first returned Unknown
with an apparently present source.

Release's `app/services/migration.Service` now owns one atomic claim for the
complete bound operation. The bound operation, accepted alpha build and physical
source object are immutable. Boot constructs this owner once under Release's
already-held authoritative exclusion domain with an injected StateGate
serialization mechanism, and injects the same borrowed
`MigrationAdmission` into every filesystem instance. Constructing another owner
per Acquire, handle, retry or lost acknowledgment violates this contract.

The verifier and the claim serve different purposes. The injected
`MigrationGuard` proves accepted byte/profile provenance, complete stopped
writers/helpers, current exclusion and the measured pair. The claim prevents
multiple consumers from arming. It neither persists Dispatched nor replaces that
verification. A failed invoked guard verification fences the owner and subsequent
calls return locally; a new consumer cannot repeat the uncertain/refused
observation. Caller cancellation or crossed binding detected before invocation
does not call the verifier or consume the accepted operation.

The native consumer must follow this order:

1. Pin fixed accepted roots and read the exact bound Prepared projection.
2. Verify the fresh physical pair and already-held authoritative guard.
3. Atomically ClaimMigration once, then arm this handle. A failed or lost claim
   acknowledgment ends acquisition and never releases or renews the claim.
4. Release confirms durable Dispatched before MoveOnce.
5. The same armed handle rechecks binding, pair, guard and Dispatched, then makes
   at most one no-replace rename attempt.

Dispatched/Relocated acquisition observes only and never calls ClaimMigration.
A filesystem Close releases its descriptors only. Release owner Close prevents
new claims but retains the consumed claim and injected guard; it does not clear
a record, settle Unknown, permit profile startup or cancel an issued drain.
Source presence after Unknown does not rearm any consumer.

This claim is state in the one admitted Release operation, not a second journal,
lock engine, adapter ledger or global singleton. The concrete state gate lives
in Release infrastructure; policy remains in app, without importing sync.
Each service receives its own gate. Sharing a mutex alone does not merge two
invalidly recreated admission owners. Cold startup must reconcile the
sole durable Release record and original-owner quiescence before constructing a
new owner. New is not a retry/recovery API. An uncertain operation retains the
same owner/guard; Dispatched cannot regress to Prepared to obtain another claim.

The focused tests execute the real Release claim implementation under concurrent
callers, crossed/cancelled requests, owner Close, guard failure and lost claim ACK.
Consumer doubles exercise the two-instance unknown-rename counterexample and
observation-only acquisition. They do not qualify native rename, directory
durability, process quiescence or alpha provenance. Identity must run these cases
against its actual leased adapter and consume the committed corrected port.
Physical journal persistence, cold reconciliation, boot wiring and installed
migration remain later acceptance requirements.
