# Retained task observation (source candidate)

`Contract.Read` delegates to the selected Task service and returns an independent
DTO. The existing Task operation journal owns the retained metadata. This adds no
event database, journal, Task executor, polling loop or cross-module dependency.
Trusted composition must supply the existing owner-qualified journal, authority,
provider and progress ports. This source contract is not an exported MCP handler
or proof of a production catalogue registration.

## Envelope, retention and evidence

Each compact event binds TaskID (`RunID`), DispatchID, selected thread/turn,
StreamID, generation, source receive position, journal projection sequence,
timestamp and kind. EventID hashes only allowlisted compact identity fields; repeated item/turn facts
keep their identity when evidence values change. Advisory plan snapshots use
compact counts because the provider supplies no plan revision. Exact replay
is deduplicated within the bounded tail; altered facts under an existing identity
fail closed. Replay older than the retained dedup window is rejected. The tail
retains 64 events per dispatch, with at most 32 returned per page. This bounds
incremental metadata per operation, not the total number of historical Task
operations in the existing journal.

Use an empty cursor for a snapshot. `Next` resumes the same stream/generation;
`More` means another retained page exists. Pruning reports `Gap` with the available
tail. A foreign/stale stream or generation reports `Gap` without events: request
a fresh snapshot. `SourceGap` marks incomplete source sequence or generation
history. Metadata contains no command, arguments, output, reasoning, transcript,
plan descriptions or prompt. Plan counts and model claims are `advisory_model`.
A command completion carries `provider_tool_receipt` only with the provider's
explicit completed status and integer exit code. Exit code zero does not establish
which test ran, its assertions or a general tests-passed verdict.

`provider_terminal` is a runtime notification, including the provider-reported
terminal lifecycle. It cannot settle a pending mutation or establish a retained
result. Only the existing exact-reference provider observation stored in the Task
journal establishes `Retained` and `ResultEvidence=task_journal`. Text requires
`IncludeResult=true`; no result is polled during this read. `Pending` and unknown
effects stay separate. An older dispatch remains readable across a newer Task
admission epoch under the same owner/session/participant and selected binding;
this read never grants admission.

Parent delivery is separate: request the exact `DeliveryOperationID` to inspect
its retained acknowledgement, after parent authority recheck. Result retention,
terminal metadata and the latest task delivery ID never imply parent ACK. Delivery
states are `not_observed`, `unknown`, `refused` or `acknowledged`. This read never
sends a delivery or retries an unknown operation.

## Actual selected Codex producer

`Client.DispatchObserved` uses the existing selected proxy and unchanged dispatch
RPC path. The proxy forwards only notification frames (never ID-bearing requests)
to a bounded metadata projection. Selected thread lineage must be durable before
turn dispatch. Up to 64 compact pre-ACK facts may be buffered, and none can enter
the journal until their exact turn matches the durable turn ACK. Overflow,
mismatched lineage or unknown publication makes dispatch uncertain and preserves
the existing mutation fence. No reconnect, second daemon or fallback is added.

The notification sink outlives the synchronous dispatch callback gate and uses
the selected client's lifetime. It captures allowlisted turn, tool, final model
claim and plan-update facts after dispatch as well as before its ACK. Foreign
threads/turns and reasoning/token notifications are ignored. One selected client
has one current observed dispatch route; a future qualified same-thread follow-up
must replace that route without changing its existing continuation RPC policy.
This candidate does not implement or duplicate that separately owned follow-up.

Non-observed providers/journals keep their previous dispatch path. Event metadata
is optional in operation images; empty metadata preserves the old canonical
image. A populated image requires this reader. Older readers reject the unknown
field, so deployment and rollback qualification remain separate acceptance gates.
Metadata publication never changes Task revision, admission, lineage or receipt;
uncertain publication fences the current owner without issuing admission again.

## Evidence limits

Hermetic tests cover the real Codex producer/parser/mapper through fake WebSocket
RPC, the Task service, bounded read DTO and result retention. Separate in-memory
storage tests cover journal restart, publication uncertainty and owner revocation.
These tests qualify source behavior only. They do not qualify native filesystem
durability, installed Codex/Claude capabilities, live tasks, parent delivery or
lost-ACK reconnect, MCP facade wiring, boot registration, production or release.
Claude capture awaits its separately owned selected capability constructor.
