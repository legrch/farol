# Persistent private conversation handoff parity

Status: planned parity item for the existing Next writer. No Next implementation,
DEV onboarding, browser partition, port or runtime configuration is changed here.

Legacy's implementation candidate is described in `../../docs/persistent-chat-handoff.md`.
Its fixture results must not be presented as Next implementation or live-provider evidence.

## Scope

Add an explicit owner-requested persistent ChatGPT handoff consumer in Chat. Keep it separate
from temporary Consult, the Product Agent's correlated child task, and arbitrary native
Codex Handoff. A saved conversation, a dispatched native task, a running turn and a completed
turn are separate facts. Do not conceal an existing `NOT_SELECTED_U2` gap by relabelling
Product Agent as generic Handoff.

The default route should be a small deterministic adapter rather than an extra model or
permanent supervisor service. A future Codex/Luna helper must call the same narrow operation;
it must not gain browser access by pretending to be a read-only assignment.

## Acceptance backlog

| Item                 | Required evidence before parity is claimed                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit create      | Principal authority; strict bounded title/handoff/key input; no recursive creation from a delegate.                                                              |
| Exact delivery       | Empty normal surface, exact first-message digest, one occurrence, no duplicate send on lost response.                                                            |
| Persistence          | Canonical private URL plus fresh-navigation, full reload and original-message/history proof.                                                                     |
| Helper lifetime      | Reopen on a new owned surface after the creation helper has exited; process completion is not chat deletion.                                                     |
| Title                | Scoped rename and actual read-back; an unavailable rename is reported independently.                                                                             |
| Recovery             | Durable reservation, CAS updates, same-key replay, original dispatch reconciliation and app restart. No global chat sweep or new send after unknown.             |
| Native Codex Handoff | Saved-project binding, persistence independent of execution, exact issued-turn status; retain the current parity gap until separately implemented and qualified. |
| Isolation            | Next-owned partition/state/ports only. No read or mutation of Legacy profiles, runtime or installed links.                                                       |
| Live qualification   | Correct signed-in account, intended message once, actual private reopen URL, history after restart, unchanged temporary Consult defaults.                        |

## Integration seam

Keep pure contracts and closed state policy in Chat domain/app; inject the browser and
receipt-store ports in boot. Peer access must go through the owning module's published
contract. The shared material is the behavioural contract and acceptance cases, not a
cross-product mutable browser singleton or an import of Legacy infrastructure.

Do not import `integrations/farol-chatgpt-chat-bridge.mjs` into Next. Its Legacy partition
and runtime locations are deliberate. Reuse the digest/exact-message semantics through
reviewed fixtures while implementing the consumer within Next's module boundaries.

The existing Next writer owns implementation and native qualification. This document does
not start another writer, trigger a release, or change any completed DEV work.
