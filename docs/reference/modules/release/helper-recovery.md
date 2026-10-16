# Go installed-helper recovery policy

`app/services/helperrecovery` prepares the existing helper's `inspect_recovery`
and `reconcile` behavior in Go. The selected updater still invokes
`resources/native/update_helper.py`. This service has no CLI, selected runtime
adapter, new journal, background recovery loop or relaunch route.

The existing input application owner parses one independently captured request
through a consumer-owned port. Recovery then uses the same operation's verified
journal, complete no-follow entry observations, expected app-tree checks, native
namespace effects and durable journal publication through its runtime port.
Trusted composition must bind that runtime to the same request and retain the
existing lease, slot, routes and admission until actual native return. Input
validation and an observed pair grant no effect authority.

## Native port implementation

`infra/native/execution.With` implements the runtime port inside one active `helperroutes.WithFiles` borrow. Composition supplies the same parsed request, the existing operation journal, its original absolute deadline, and the existing owner's lease/slot/admission and retained-unknown callbacks. Raw descriptors or request fields do not replace the live borrow. This adapter opens no route, acquires no lease, creates no second journal and selects no CLI route.

The adapter observes the five fixed names with no-follow descriptor-relative queries and checks a complete second scan. Only `ENOENT` proves absence. Sequential mutation-sensitive scans are not an atomic namespace snapshot. `rejected-target.json` is a record-presence observation, never an app-tree or namespace-effect operand. App-tree checks compose the existing physical verifier with the pure identity policy. A negative match requires an inspected original verification refusal; opaque, cleanup, native and cancellation failures remain errors. Namespace effects delegate to the existing one-attempt rename/exchange primitive under the owner's fence.

Methods serialize actual synchronous native return, including cleanup. They capture the original deadline once and enforce it independently of delayed timer notification; later caller contexts cannot renew it. Retained interfaces refuse after `With`, including after a panicking callback. Each effect consumes its attempt before I/O or cancellation; uncertainty is retained by the existing owner and survives a fresh adapter. The journal uses `ReadHelper`'s 8192-byte preparse bound and the existing revision-based CAS. Readback supplies no startup, effect, helper-exit or durability acceptance beyond the existing repository's own completed persistence contract. A scope that already completed a namespace or journal effect retains uncertainty in that same owner if a later method, the application callback or scope cancellation prevents completion; a successful individual call does not settle the enclosing recovery.

Disposable native filesystem tests cover tree identity/digest observations, fixed entry mutation, rename/exchange identity readback and borrowed-handle preservation. Route/admission/journal seams in these adapter tests are symbolic; the production entry refuses a missing live borrow. Deadline, actual-return, scope, classification and retained-unknown tests do not prove a live lease, installed helper, real process exit, package or OTA/rollback acceptance.

## Application policy

`Inspect` is repeatable read-only preflight. `Reconcile` consumes one attempt
before any I/O or cancellation check, shared across copied wrappers. It never
retries a failed port, starts a prepared exchange in recovery, removes retained
state or replays a historical launch. A pre-exchange prepared pair records
`cancelled`; an already exchanged pair can finish naming its predecessor and
record `verified`. Repairs for the former two-rename crash gaps preserve their
existing exact-pair checks and predecessor-state refusal.

`domain.PredecessorStateUnqualified` retains the narrow measured-version guard
for 0.1, beta-3, beta-1-through-9 state readers and beta-1-through-11 completed
process readers. A false result makes no general state-compatibility claim.
Forward recovery of an incompatible predecessor is limited to `recover` at
`rollback_started`, with an intact exact target and predecessor and no staged,
failed or rejected-target entry. The pair is checked again after the owner
fence. Settled rollback retains the original distinction between an authenticated
source app and merely owned failed directory bytes.

Dependency failures retain their exact causes behind closed outer text.
Opaque or malformed errors remain internal; wrapping a refusal beside an I/O
failure cannot downgrade it. Concurrent cancellation keeps both causes. Every
possibly effective namespace or journal call retains uncertainty through later
failures, including inspected refusals. Bounded traversal of joined error causes
conservatively retains uncertainty for oversized or cyclic graphs. No failure
offers another dispatch.

The pure application checks its context around ports and final success. Native
ports must independently enforce the original absolute budget and earlier caller
deadline, including when cancellation delivery lags. They retain synchronous
process and descriptor custody; application context checks cannot prove native
cleanup. Final helper exit-70/exit-79 classification remains composition work.

Static outcomes from the original Python AST cover 4,354 phase/pair rows and
1,024 predecessor-version pairs, with the original source digest checked by Go
tests. Instrumented port tests cover effect/journal order, fence replacement,
one-shot consumption, cancellation and internal/unknown provenance. A separate
composition uses the actual Go input decoder and application owner, including
refused inputs that cannot reach a runtime. These fixtures do not verify native
trees, mutate an installation or establish Darwin, packaged, clean-Mac or OTA
acceptance. The existing `domain/recovery.go` startup assessment remains a
separate observational subset; it is unchanged by this preparation.

## Admitted installation policy

The unselected `app/services/execution` service owns apply and explicit rollback policy over consumer-owned `HelperInstallationRuntime`. Its independent captured-request parser has no effects or admission authority. The same trusted operation owner supplies the runtime only after its actual route, slot, lease, stopped-writer and continuation gates; this application opens no path, process, route or journal. Copies share a one-shot attempt consumed before cancellation or port I/O. Native ports independently retain original absolute deadlines and actual-return custody.

Apply requires the exact owned source/staged pair, no previous/failed/rejected entry, accepted tree observations and the same device before preparing the original journal from confirmed absence. It exchanges only the measured pair, verifies the displaced source, fences the move to previous, writes new_installed and checks the installed target. An opaque target-verification error remains an error. Only a confirmed negative tree match may restore the same predecessor, quarantine the measured failed target, durably record its rejection and write rolled_back. That settled negative update returns the existing target_verification code with no incomplete-scope error; it is not a successful update, helper exit, relaunch or startup proof.

Explicit rollback accepts only verified/completed/launch_requested with an exact owned app/predecessor pair and no staged, failed or rejected entry. The existing predecessor-state predicate refuses the known incompatible historical versions. It fences each destructive namespace transition, preserves the failed target and verifies the restored source before rolled_back. It does not manufacture rejected-target evidence for an otherwise accepted target. Every later failure after a confirmed effect remains uncertain, including a known refusal; joined or opaque errors retain their causes behind closed text and cannot inherit a nested refusal classification. Symbolic policy tests assert ordering, pair custody, refused phases/versions, no-effect preflight, copied/concurrent one-shot behavior and late-result suppression. These are not native installation, process, lease, package or OTA evidence.
