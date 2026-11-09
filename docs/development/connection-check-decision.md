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
observed. The existing 16 renderer and 12 extracted-dispatch tests pass separately.
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
