# Context source map

Inspected base: `99aca15ffe16b435e59b19c20ff48e06bd56960d`, tree
`92047a064fede82658c37cf0f0a76004f6ce291c`. Paths below describe that base,
not proposed shipping capabilities. This inventory adds no provider or storage effects.

## Existing owners and usable data

| Source at B0                                                                                                                                                                   | Actual ownership, identity and bounds                                                                                                                                                                                                                                                                                                                                             | Context use and limit                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/chat/domain/turn/{turn,queue}.go`                                                                                                                                     | Content-free Chat turn/queue state; profile/owner/session/task/participant/turn/generation, browser/backend binding, result ID, sequence and call deduplication. Five slots, 256 pending, 1,024 admitted requests; 128 Computer call IDs per turn.                                                                                                                                | Preserve original operation identity and UNKNOWN state. State projections do not reconstruct prompt, arguments or result text and grant no retry.                                                                                                                                                                                                                               |
| `modules/chat/app/services/lifecycle/{service,conversation,caller}.go`                                                                                                         | Live Chat service owns prompt, output, events and unresolved caller state. Prompt/output are each 8,192 UTF-8 bytes. Caller argument/output/input limits are 64 KiB/512 KiB/1 MiB.                                                                                                                                                                                                | Prefer live owner observations. Admission copies prompt into the live handle and clears the input copy; this is not a durable complete transcript port.                                                                                                                                                                                                                         |
| `modules/chat/domain/stream/{buffer,cursor}.go`                                                                                                                                | Transient delivery scoped to profile/backend/owner/session/task/turn/generation; exact frame sequence. Default 128 frames, 64 KiB/frame, 256 KiB total; only acknowledged frames may be evicted.                                                                                                                                                                                  | Replay/After are observations, not result ACK or redispatch. Overflow is sticky; gaps cannot be called complete history.                                                                                                                                                                                                                                                        |
| `modules/chat/app/port/{lifecycle,resultstore,retention}.go`, `modules/chat/infra/results/{memory,durable,codec}.go`                                                           | Existing result owner retains exact terminal payload plus original binding, result and conversation metadata. Up to 1,024 results, 8 KiB/result, 8 MiB payloads; encoded record <=64 KiB. Durable publication binds qualified roots/digest/byte count.                                                                                                                            | Reuse known original result publications and owner-authorized reads. Journal is content-free; result payload is answer text, not all user messages/tool exchanges. Publication is data, not present read/Send/ACK authority. No generic checkpoint field exists here.                                                                                                           |
| `modules/chat/app/services/handoff/history.go`, `modules/chat/app/port/history.go`, `modules/chat/contracts/conversation/history.go`                                           | Read-only catalogue of completed retained results in the existing consumed handoff chain. Exact immutable head anchor; original backend+operation key; current read lease rechecked after IO. Page size 32, total <=1,024.                                                                                                                                                        | Useful original answer/source references. Completed-only history excludes unresolved operations and does not supply original user/tool transcript. Never manufacture a completed ancestor from orphan storage bytes.                                                                                                                                                            |
| `modules/chat/app/port/{caller,relay}.go`, `modules/chat/app/services/lifecycle/caller.go`                                                                                     | Caller scope retains root-turn/session/thread/turn/model and function item/call/name/arguments; production acceptance requires exact original call, scope, context and output call ID. Return receipt binds producer operation, call, output digest and bytes. Relay explicitly stores no tool arguments/result history payload.                                                  | Preserve full scoped identity and separate caller result return from provider consumption. A call ID alone is insufficient to join tools across turns/accounts.                                                                                                                                                                                                                 |
| `src/modules/chat/app/service/read-codex-task-history.ts`, `src/modules/chat/app/port/codex-task-history.ts`                                                                   | Existing admitted App Server read port validates exact thread/project/cwd and turn. Turn search <=32 pages of 100; item read <=50 entries and 32 KiB text. Output explicitly says `non-atomic`, `single-page-text-only`; nontext items are omitted.                                                                                                                               | Reuse for bounded display/observation where appropriate. It cannot prove complete tool pairing or atomic source revision; omissions must remain visible. No Codex session database access is needed.                                                                                                                                                                            |
| `src/modules/chat/domain/{context-continuity,checkpoint}.ts`                                                                                                                   | Existing transitional context epoch/operation state and checkpoint envelope. Binding: owner/task/hostThread/session/providerProfile/model/mode; source boundary/cursor and summary provider operation. Structured checkpoint content has bounded lists (64), UNKNOWN references (160 characters, <=64), per-text limits and caller-supplied byte budget.                          | Reuse semantics: dispatch-observed UNKNOWN, exact binding, repeated request conflict, summary validation, reconciliation of known receipts and unresolved effects. Existing envelope has no transcript source hash/revision/range. Structured summary constraints remain untrusted prose, not grants.                                                                           |
| `src/modules/chat/app/{service/compact-context,port/checkpoint-store,port/context-repository,port/context-summarizer,port/host-context-bridge,port/context-source-control}.ts` | Existing compaction service consumes explicit repository, checkpoint store, summarizer, host bridge and source control ports. Summarizer distinguishes request from observation; execution tools are empty. Host confirmation and source retirement are separate transitions.                                                                                                     | Existing production port composition should remain owner-controlled. `CheckpointStore.put` returns void and has no source-head compare-and-swap receipt. Source retirement is an effect, not required for pure context selection tests.                                                                                                                                         |
| `src/modules/chat/infra/repo/private-context-store.ts`                                                                                                                         | Existing private persistence for sessions, checkpoints, immutable-per-operation raw host source history, summaries/summary attempts/admission/retirement. Default source record <=1 MiB and <=4,096 items; session 64 KiB; checkpoint content/record 256/384 KiB. Atomic write uses temp write/fsync/rename/directory fsync; exclusive admission uses link publication and lease. | Reuse this accepted owner for a negotiated adapter, rather than add a permanent Go conversation database. Existing checkpoint/source put checks identity then renames; it is not a source-head CAS receipt. Default checkpoint retention is eight with explicit protected IDs and pruning; preserve originals/reconstruction independently and do not widen pruning implicitly. |

## Inbound serving differs from outbound inference

`src/apps/desktop/farol-model-endpoint.ts` is the authenticated loopback Responses
facade for a client calling Farol. It bounds its inbound body at 1 MiB and relays
once to the running Route B provider. `src/apps/desktop/codex-chatgpt-provider.ts`
serves that host request through the existing browser conversation route. Its
`promptFromInput` sends only trailing user messages because the browser already
holds earlier turns; its 128 Ki-character cap is JavaScript string length, not
a provider token budget. Copying this behavior to direct SIWC would lose history.

`modules/chat/infra/responses/sse.go` encodes existing outbound delivery frames
for that inbound serving API; it is not an outbound SIWC client or history selector.
At B0 there is no Go direct-plan inference client. INFERENCE owns its new
`modules/chat/app/services/inference/**` and
`modules/chat/infra/clients/planresponses/**` implementation. That consumer needs
an explicit bounded history value with original scoped call/result pairing,
mandatory instructions and current user intent; it cannot rely on a browser
conversation/document ID or `previous_response_id`.

`src/modules/chat/infra/client/host-compaction-codec.ts` handles the existing
inbound host compaction variants and retained user tail. Its
`authoritativeHistoryFacts` currently keys tools by unscoped `call_id`, truncates
UNKNOWN references to 160 characters and accepts delivered outputs as receipt
evidence. Those semantics do not qualify new exact scoped grouping. Reuse the
owner's observations through an explicit validating mapping; do not present a
text-only or lossy old checkpoint as an exact source snapshot.

`src/apps/desktop/codex-host-compaction.ts` already makes one
`thread/compact/start` request and separately waits for qualified completion
notifications. Immediate RPC ACK is not completion. Keep its timeout/failed
result and original operation identity; a portable controlled adapter test does
not qualify provider-native compaction or authorize a second live call.

## Narrow integration requests

All following changes need the integrator's named writer; this lane does not
edit the listed reserved paths. No shared DTO needs to be invented to test the
independent CONTEXT service with controlled ports.

1. **Exact source snapshot adapter.** The existing Chat/history owner should
   supply an immutable snapshot containing source owner/revision/range/hash,
   exact scoped event IDs, original mandatory/user/tool contents and unresolved
   operation references. Map live lifecycle/result observations and, where
   applicable, stored raw host sources in
   `src/apps/desktop/codex-context-continuity.ts`. Refuse missing originals,
   non-atomic text-only history and ambiguous cross-turn/account tool joins as
   complete sources. Do not expand completed-only handoff history to silently
   include UNKNOWN operations or confer disclosure authority.
2. **Checkpoint publication adapter.** Extend the existing persistence owner
   narrowly around `src/modules/chat/app/port/checkpoint-store.ts` and
   `src/modules/chat/infra/repo/private-context-store.ts`, or an approved mapped
   Go Chat port. Accept checkpoint plus expected source head; return a receipt
   matching exact checkpoint digest/source revision and classify stale source,
   known refusal and outcome-unknown publication separately. Atomic storage
   write and acknowledgment uncertainty require independent tests. Preserve
   immutable source bytes or a qualified reconstruction path; keep existing
   journal/result record schemas untouched.
3. **INFERENCE consumption.** INFERENCE should adapt the CONTEXT bounded value
   into its actual request builder and recheck selected account/provider/model
   binding before use. Test the real application and client composition with a
   long synthetic source, exact retained UNKNOWN references and complete known
   call/result groups. No `boot/**`, contracts or shipping advertisement change
   is implied by this source-only seam.
4. **Optional summary mapping.** Existing `ContextSummarizer` semantics already
   distinguish request from observe and disallow execution tools. A new adapter
   must additionally bind prompt/version and exact source hash/range, reject
   oversized/invalid output, and render summary only as untrusted data. Do not
   spend live provider usage or import summary `activeConstraints` as permission.

## Existing regression evidence to retain

Relevant B0 tests include Go lifecycle caller/retention/history/stream suites
and `tests/{unit/checkpoint-reconcile,integration/checkpoint-authority,
integration/host-compaction-codec,integration/checkpoint-provenance-storage,
integration/codex-host-compaction}.test.ts`. This inventory did not execute
those suites and makes no native, live-provider or shipping-composition claim.
The new app composition must exercise actual production selection and recovery
functions, independently of these historical tests.
