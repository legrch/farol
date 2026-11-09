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

The current source exposes the wrong route directly: the toolbar click selects
`runManualConnectionPrompt`, which configures `chatgpt.run-deep-test`; the backend
requires `currentConnectorAttachment`. The verifier's separate current-challenge
path supplies the feasible bootstrap alternative. This inspectable call graph is
the basis for the decision, without treating a fixture result as provider proof.

The historical toolbar RED case remains an illustration, not a source-qualified
execution claim. Current P1 checks have a new independently inspectable source
binding described below. They do not claim that the future P2 route is implemented.

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

## Origin-bound status correlation to implement

The baseline does not already provide exact status-call correlation. In
`boot/computerverification.go`, host registration stores an expected ID and a
later socket observation receives that ID even when it did not originate from
the diagnostic. The public `computer_connection_status` input currently accepts
only `{}`. A delayed old or unrelated status call can therefore appear to confirm
a newer attempt. The existing socket test carrying a check ID cannot establish
the real empty-input path. This is a required implementation correction, not a
property demonstrated by the baseline tests.

Add an optional bounded `checkId` to the existing strict public status input and
propagate the exact supplied value through `connection-status.ts` and
`ConnectorVerificationBridge.observe` to the socket query. Its existing RPC DTO
already has that optional field; generated validation must remain consistent.
Ordinary `{}` callers retain their passive status response, without a diagnostic
acknowledgement. Do not stamp the currently expected ID onto an uncorrelated read
or leak an older acknowledgement into a plain socket response.

Only the sole Go attempt owner may arm the exact diagnostic expectation after
its durable dispatch intent/readback and before permitting Send. Generate a fresh
cryptographically random diagnostic ID, with its purpose distinct from a bootstrap
challenge, and bind it to the retained operation UUID, fingerprint, scope, current
attachment and exact connector/runtime/backend/Computer generations. The socket
may acknowledge only that supplied ID on its original admitted slot, binding and
active attempt. A missing, wrong, late, retired or unarmed ID cannot settle it.
A second UUID cannot overwrite an unresolved expectation for the same scope.
Host observation may retain the matching receipt only for its original attempt.
Timeout ends waiting, not uncertain-effect custody; restart does not infer success
from lost in-memory correlation or authorize another Send.

A client with a cached empty input schema remains compatible for passive reads,
but cannot satisfy the new explicit diagnostic without carrying its ID. Preserve
that limitation as a typed, truthful unconfirmed result; do not fall back to an
uncorrelated read, renew a consumed bootstrap challenge or request reinstallation
as a hidden repair. This bounded choice does not promise that every cached client
can immediately complete a fresh diagnostic. A separate compatibility mechanism
would need its own reviewed decision. Reusing nonce-bearing bootstrap verification
was rejected here because it changes sealed-challenge admission, receipt semantics
and potentially native metadata work. This amendment adds no native enumeration,
workspace grant or bootstrap verification. The nonce demonstrates a correlated
bound tool invocation, not cryptographic proof of provider account or model.

Require an actual public-MCP-to-socket-to-Go regression: arm attempt A, then attempt
B only after lawful A retirement, deliver A's delayed empty-input status and wrong
or old ID, and prove B remains unconfirmed. Deliver B's exact ID and confirm only
B. Also cover unrelated passive reads, a retained historical attachment plus plain
status, cached `{}` inputs, unknown keys, a second pending UUID, stale slot and
post-intent uncertainty. Update the misleading direct-socket test; preserve
ordinary status and bootstrap behavior. Relevant test seams include
`boot/computerconnectionstatus_test.go`,
`tests/unit/go-computer-connection-status-mcp.test.ts`,
`tests/unit/go-computer-connection-status-projection.test.ts`,
`tests/unit/desktop-connector-verification.test.ts`, and
`tests/integration/connector-verification-mcp.test.ts`.

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

A fresh run used the actual Git checkout at
`f35d6401efa940a117d74ae9926561a0ca481947`, tree
`f19c81033bd8f847aa14a0b189f3078ac6109ff3`. Before and after execution, the controller
read every one of 3,748 tracked files and checked its bytes against the selected
Git blob object. The before/after manifests match. Node was 24.20.0. Each log
contains that source reference, exact command/cwd and source-manifest digest;
the receipt records each actual process exit code. The only test-configuration
instrumentation supplies an explicit root and private cache directory.

These selected tests all exited zero: 110 renderer, 16 helper and 12 extracted
backend-dispatch cases. Their scripted ports do not establish provider, installed,
reboot or full CI results. In particular, the current P1 code still uses the wrong
explicit-check route; these passing suites are not a P2 success claim.

Current-task evidence is under
`_output/evidence/stability-handover-a91048f3/source-bound-f35d6401/`:

- Controller receipt with source, command and exit records: `source-bound-receipt.json`, SHA256 `2f364e8d8c0d0d50307a2d50d7695e381b2b654a0ce4d9da47d2bccf5eef8d4f`.
- Raw-file SHA256 inventory and canonical manifest digest encoding: `EVIDENCE-INDEX.json`, SHA256 `cc8cdc93c171e11f5bb64a11918f11754ef84fb5a30cc5504c7112f718dc3cfc`.
- Exact executed controller, matching receipt runnerSha256: `source-bound-runner.py`, SHA256 `9aea12e72177c681b34d2bcc3fab862c15633136d7fb083a164538011f10b7d9`.

The same directory contains both full manifests, the exact instrumented configs
and renderer/helper/dispatch logs. These are private review evidence, not public
runtime resources. The earlier count-only baseline logs lack an independent
run-to-source record and are not used as source-qualified support for this decision.
The original historical RED remains preserved separately; source inspection and
the new, explicitly scoped receipts are the evidence used here.
