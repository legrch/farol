# Explicit connection-check coordination

Status: proposed implementation decision. Source behavior is based on
`a91048f34013edabe05730b697b11349ffdc3de8`.

## Scope and evidence

This decision covers the explicit connection-check control only. Workspace
continuity is a separate, unapproved proposal: real-reboot evidence is still
missing. This decision neither approves automatic folder rebinding nor changes
workspace identity, permissions, enrollment or filesystem admission.

After a normal startup, saved setup and a new current challenge can coexist with
no current attachment. The toolbar calls `runManualConnectionPrompt`, which sends
`chatgpt.run-deep-test` to `runManualDeepTest`; its current-attachment guard then
refuses. The existing `verifySecureMcpApp` can instead obtain the first receipt
from the current challenge. The fix must use the correct verification route,
not remove ordinary deep-test admission.

The source-realistic renderer characterization is retained in current-task private
evidence at `_output/evidence/stability-handover-a91048f3/toolbar-routing-regression.txt`
and `toolbar-routing-red.log`. It renders and clicks the actual enabled toolbar
button with saved setup and no attachment; the wrong deep-test dispatch is
observed. The original 16 renderer and 12 extracted-dispatch tests passed separately on the same a91048f3 source; the distinct passing-run receipts are listed below.
Those scripted-host checks do not establish a provider or installed result.

## Selected direction and alternatives

Prefer a small adaptation of the existing Go connector verification owner and
durable attempt machinery. Introduce a narrowly named connection-check application
service only where the existing contract cannot own the explicit operation's
identity, mode selection and custody. New backend policy belongs in Go; Desktop
provides browser/native adapters and mechanical ports. Reuse one existing
verification engine, one settings writer and one effect claim; do not build a
generic task framework or duplicate operation/authority stores.

Rejected alternatives are removing the deep-test attachment guard; merely invoking
the fresh renderer helper while dropping the caller's operation identity; implicit
repair/reconnect; and opening a temporary chat before protecting the current draft.
They respectively weaken ordinary admission, lose one-shot custody, change state
without the requested action, or risk abandoning user work.

## Contract and ownership

One explicit command carries the original UUID operation ID and a retained route
reference. The host resolves current exact app, workspace or explicit empty
catalogue, build/runtime/computer/connector generations and scope. The trusted
owner selects bootstrap from an unused current challenge, status from an exact
current attachment, or blocked. The renderer cannot assert readiness or settlement.

Same ID and same input returns the retained result or observes the original
attempt. Changed input refuses. Duplicate IPC, lost replies, rerenders and two
controls cannot Send twice. Persist a claim before browser dispatch. Preserve old
attempts and uncertain custody; adapting legacy records must not delete a claim,
recreate its operation or mark an unknown effect settled.

Keep preparation, durable dispatch intent, acknowledged Send and exact receipt
confirmation distinct. A proven predispatch failure is not-sent; ambiguous
dispatch or postdispatch result is unknown. A refusal after dispatch cannot imply
nothing was sent. Delivery acknowledgement is not receipt confirmation and cannot
release an unresolved effect. A late receipt observes only its original bound
attempt; it does not authorize redispatch.

The current Go challenge/status receipt owner and final binding checks remain
authoritative. An acknowledged Send is not a successful connection test. A local
readiness check or a retained old receipt does not satisfy a fresh status check.
No startup provider Send, ordinary deep-test admission change, app substitution,
implicit repair or separate-app verification fallback is included.

## Browser boundary

Describe the explicit action as a one-time check in a temporary chat. Before
navigation, inspect the original retained document for text, staged attachments,
active generation and ownership. Recheck just before navigation; unavailable or
changed observations refuse before effect. Do not copy drafts into another store.
Retain exact temporary/model/app selection and the final pre-Send document fence;
unrecognized layouts or models produce a specific safe result, never a guessed
selection. The browser adapter must expose dispatch certainty rather than letting
an outer generic error manufacture a not-sent result.

## Verification and rollout boundary

First establish a RED for saved setup + current challenge + absent attachment
through the actual command/handler. Then prove exactly one Send and a bound receipt
through scripted browser/native ports. Cover status with fresh correlation,
duplicate IDs, changed payload, lost reply, crashes at claim/dispatch/receipt,
postdispatch binding change, late receipts, existing draft/attachments, owner edits
during preparation, page activity, wrong app/model, and unknown publication.
Keep startup zero-Send and ordinary deep-test guard regression checks.

Do not migrate unrelated Chat orchestration, folder policy or settings commands.
Strict DTO/bridge generation, import/type checks, targeted tests, full CI and
independent exact-source review precede integration. Packaged/installed/provider
qualification and owner decisions remain separate. This decision does not claim
any new implementation, installation or provider witness is already complete.

## Durable identity ownership to implement

The existing challenge-keyed claim does **not** already retain the command UUID,
request fingerprint or result phases. Its schema 2 is the legacy separate-check
record, not the format for this new operation. Do not claim otherwise or relabel
old records. This decision requires extending one Go-owned attempt store, using
an injected private storage adapter over the existing attempt namespace:

- The operation record is the durable source for the explicit command UUID,
  canonical validated caller-input fingerprint, captured scope digest, mode,
  correlation IDs, monotonic dispatch/receipt phases and retained typed result.
  Lookup the original UUID before resolving a new runtime scope. Same caller input
  observes that original record; changed caller input refuses. A scope change
  never silently becomes a new attempt for an existing UUID.
- The existing challenge-named exclusive claim remains the bootstrap one-shot
  fuse. New claims bind their operation UUID and scope/record correlation using a
  new version distinct from existing schemas 1 and 2. Old claims remain immutable
  consumed fences, with no invented UUID, not-sent phase or recovered result.
- Operation records and the legacy-compatible fuse belong to that **same** attempt
  owner and private lease, not two authority stores. No grant or settings copy is
  introduced. A bounded strict lookup of owned operation records resolves UUIDs;
  no independent mutable index is authoritative.
- Persist the operation record before preflight so a known refusal can be retained.
  Prepare its exact scope/document before dispatch. At the final effect boundary,
  install/sync the bootstrap fuse when needed, then publish/sync dispatch intent
  before permitting the browser activation. Status mode uses its stored fresh
  check correlation and the same operation phase fence rather than pretending an
  old attachment challenge is an unused bootstrap challenge.
- A partial/lost operation save, fuse publication, intent write or result update
  remains fenced by this owner. A fuse without a settled operation transition
  cannot authorize Send or be deleted to manufacture a new attempt. Crash after
  intent is unknown unless original correlated evidence proves dispatch certainty.
  Successful file writes without required directory sync/readback are not proof.
- Final result persistence and acknowledgement preserve the original monotonic
  phase and uncertain effects. Capacity bounds never delete unresolved records.
  Repeated observation is read-only; it neither reclaims a challenge nor advances
  an unknown operation by dispatching again.

This is required new implementation, not a guarantee supplied by the current
challenge-only TypeScript helper or in-memory Go verifier. Route the active
explicit path through this sole owner and retire its duplicate active writer;
retain legacy readers/fuses and separately governed existing workflows. Verify
schema/partial-write/close/sync/duplicate/crash cases against actual stored bytes.

## Named evidence for this decision

The source-bound original passing runs are separate from the intentionally failing
characterization. Current-task private receipts, with SHA256 for independent readback:

- Original renderer suite: 16 passed: `_output/evidence/stability-handover-a91048f3/baseline-renderer.log`, SHA256 `d9565d5f531574674685cd4f01693b186378c53a521412da07d4a7e53ff0d59b`.
- Original extracted-dispatch suite: 12 passed: `_output/evidence/stability-handover-a91048f3/baseline-dispatch.log`, SHA256 `8e0c94dea83662f82b051a29ef78d142f33cadd0ebf6a033ece057540bc3fbda`.
- Actual toolbar characterization: 1 failed, 16 skipped: `_output/evidence/stability-handover-a91048f3/toolbar-routing-red.log`, SHA256 `5a241da00d8d343b24634918d3b83659887c43fedc89ed1e06ba1b92118ade2a`.
- Exact added characterization case: `_output/evidence/stability-handover-a91048f3/toolbar-routing-regression.txt`, SHA256 `361ba42a3236630e436e266d0b385310a4b1cc6e85406c5fdbef84ce86499d6d`.
