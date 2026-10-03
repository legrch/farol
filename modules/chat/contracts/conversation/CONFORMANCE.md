# Owned conversation and model mapping

This is an in-process Chat consumer contract and a Desktop mapping target, not a
new root wire schema. Source fixture support does not imply installed support.
Go owns admission, queue, policy, retention and semantic output. Desktop owns
physical browser operations and validates its sender/session at the existing bridge.

| Operation    | Required input/evidence                                                                                           | Invariant                                                                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/admit | Fixed TurnBinding, pinned Selection, transient prompt                                                             | Canonical intent digest committed before browser work; no Codex intermediary.                                                                                                                                                                                                            |
| Prepare      | Current BrowserLease plus NewSaved/OwnedSaved Target                                                              | Exact returned lease/document; Saved=true; OwnedSaved returns the SAME provider conversation. No arbitrary URL/history access.                                                                                                                                                           |
| VerifySend   | Exact BrowserBinding, requested model/effort/account/connector/grant, digest, previous settled UserTurnID/ReplyID | Fresh non-secret EvidenceID for this one Send; Go compares every field each turn.                                                                                                                                                                                                        |
| Send         | Same binding/digest and verified witness                                                                          | Desktop rechecks one-shot witness at Send; stale selection returns NotSent; submitted is not provider acceptance.                                                                                                                                                                        |
| Observe      | Exact binding and contiguous after-sequence                                                                       | Accepted supplies the next observed UserTurnID, distinct from the previous settled UserTurnID; answer/completion carry that UserTurnID and a new ReplyID. Stable SegmentID; committed UTF-8 semantic text. Redraw of same segment is deduplicated; changed committed segment is refused. |
| Result       | Exact live conversation/turn handle                                                                               | Explicit retained content, completeness and requested/observed selection; no new browser Send; read does not ACK.                                                                                                                                                                        |
| ACK/release  | Initiating-client ACK plus exact Quiescent event                                                                  | Existing Go queue releases only after delivery and lifecycle settlement.                                                                                                                                                                                                                 |
| Follow-up    | Same live owner/conversation, new operation/turn identity                                                         | Same provider conversation; new current scheduler lease generation after release, no inherited model witness or observation cursor.                                                                                                                                                      |
| Model events | Same owning Turn and bounded existing stream buffer                                                               | Incremental text before provider terminal; retained replay never redispatches; no timer-dribbled final result.                                                                                                                                                                           |

`testdata/followup.json` is synthetic, non-private canonical mapping input for Go
fake-port tests and Desktop conformance. The real adapter must revalidate model,
account and connector on both sends. Remounts preserve logical output identities;
physical document generation remains exact for each observation.

First checkpoint supports text events only: response.created, output item/content
part added, output_text.delta/done, content part/item done and terminal outcome.
It does not advertise function/custom tool execution, compaction, provider history
read/archive, restart restoration or full Codex compatibility. Those need the next
bounded source increment and selected-client/native qualification. The existing
Responses endpoint will consume this executor; no additional endpoint is created.

Exact Go mapping: `port.ConversationTarget` carries Mode, ConversationID,
PreviousUserTurnID, PreviousReplyID and Selection. `port.VerifySendRequest` and
`port.SendVerification` repeat the previous logical IDs and selection alongside
BrowserBinding and IntentDigest. `port.BrowserObservation` carries UserTurnID,
ReplyID, SegmentID and the unchanged exact BrowserBinding. Selection contains
Provider/Alias, AccountID, ModelID, Effort, ToolsEnabled, ConnectorID and
ConnectorGrantID. BrowserBinding carries the caller profile/backend/owner/session/
task/turn/operation identity, SlotOrdinal/SlotGeneration, ViewID/ViewGeneration,
DocumentGeneration and ConversationID. Caller ownership is authoritative; the DOM
proves mechanics and never creates ownership. Root wire mapping remains separate.

## Source checkpoint bounds

The facade captures one admitted Turn per opaque handle. Follow uses the latest
settled handle in the same owned lineage; older results remain independently
readable. NewSaved rejects an already-owned provider conversation. Prepare's
consumer Binding is the original authoritative caller binding, including epoch
and participant, not fields inferred from DOM. The selected account/model/effort/
connector is pinned for this text checkpoint; each Send must freshly observe it.
A mismatch/lost verification is sticky uncertainty with zero Send; a lost Send
reply is Unknown and cannot be retried. Owner Resume records an explicit action
and never dispatches. The live owner retains a consumed witness ID set bounded by
its existing MaxRequests registry, without a new Task engine or durable schema.

Prompt and output are each capped at 8192 UTF-8 bytes. The current bounded Observe
call requests one semantic event; callers explicitly observe subsequent pages.
AnswerDelta means a committed segment, not a changing partial DOM block; SegmentID
must stay stable across redraw/remount. Equal bytes with different IDs are both
emitted. Mutation of committed bytes fails closed. Transport queue bounds remain
128 frames / 64 KiB per frame / 256 KiB retained; frame ACK permits eviction and
an explicit reconnect gap. Business ACK remains separate and requires known
lifecycle quiescence before reuse. Source snapshots contain no prompt/answer.

No endpoint, polling job, boot registration or durable journal kind/schema was
added. Existing TypeScript serving remains active until Root/Desktop composition
and selected client/native qualification. Tools and compaction are not supported
by this checkpoint; text events contain no fabricated usage, reasoning or encrypted
continuation. Retained live handle replay performs no Browser.Send. Process restart
restoration remains outside this contract.

## Selection evidence and root attachment

Selection also carries Mode (standard/pro; empty is an unqualified detail), and
Effort is the immutable resolved route string, not a new universal vendor enum.
Optional ModelResolution maps the existing owner-config alias/executor, requested
mode/effort (empty retains omitted), resolved Selection, ConfigSHA256 and an exact
TranslationID. It is included in the canonical intent. Missing resolution remains
ResolutionSource=unknown; supplied resolution is configured evidence, not provider
admission. Fresh owner/selection checks produce AdmissionSource=chat-policy and
ObservationSource=pre-send-browser-verified with the witness ID. This names the
actual strength: no claim about hidden model internals, quota or unspecified fields.
Requested/resolved/admitted/observed are independent immutable values in the facade.

Normal root attachment proposal (owned by Lead): existing `farol serve` composition
injects the bridge-backed Browser implementing Prepare, VerifySend, Send, Observe,
Cancel and Dispose, plus the existing journal/result ports and infra/intent.SHA256.
The same lifecycle.Service is captured by contracts/conversation.New. Root maps its
current caller/config DTOs explicitly to Input/ModelResolution, captures the opaque
handle from Create or Follow, drives PrepareNext/Send/Observe and consumes Events
through infra/responses.Encode at the existing Responses endpoint. Result delivery
and frame ACK use their separate methods. The internal agent captures this same
facade directly. The bridge adapter maps Target/Selection/previous IDs and the exact
physical binding to the existing TS driver. It must validate fresh proof/one-shot
witness and echo VerificationID; no alternate endpoint or executor is required.
Boot/schema/normal-entrypoint selection and disabling the accepted TS alternative
remain Root integration work. C12 is NOT proven by this source checkpoint.

The barrier-backed facade test holds provider terminal generation while the actual
consumer reads an encoded useful delta, then releases terminal and reads the actual
retained result. It qualifies the service/facade/encoder path only. Independent DOM
rendering, physical accepted-send ledger, durable filesystem restart and real socket/
Go-Electron bridge witnesses remain separate Desktop/Lead/native work. Lost Send
reply, model mismatch, same-chat follow-up, five-plus-one, exact generation and
conservative ACK reuse already have CPU tests; they are not live qualification.

## Provider binding refinement

NewSaved prepares an explicit Home physical binding with no provider CID. Accepted
echoes that exact binding and carries ProviderConversationID/UserTurnID independently.
The existing owner journals Home -> Bound once and only then publishes provider
ownership. Follow requires that bound CID and the existing real ACK/quiescence.
Legacy already-bound source/journal values remain readable; new Exchange bindings
are explicit home/bound and do not infer a Home page from an empty ID.

Input.Required is trusted route capability policy, pinned in the canonical intent.
Model is mandatory; a selected mode and enabled connector are mandatory controls.
Effort requirements follow the declared route, without lowering them for tests.
Observed is field-level SelectionFacts with canonical Value, literal public control
text, Source and capture time. Missing optional facts project unknown; missing
required facts refuse Send. Alias/account/grant values remain configured pinned
scope. Root/Desktop qualify catalogue mapping, capture freshness and atomic final
Send revalidation; source doubles do not attest the provider or native browser.
