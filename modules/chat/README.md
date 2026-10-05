# Chat source foundation

The pre-K0 Turn/stream/browser-port preparation now builds under Core's accepted
root Go module. The post-K0 admission seam publishes current-owner policy for
ordinary Chat. `app/services/lifecycle.Service` now owns the live queue, fresh
journal claim, private admitted handles and one-shot browser intent/settlement.
See [ADMISSION.md](ADMISSION.md) for the published guard and
[LIFECYCLE.md](LIFECYCLE.md) for actual owner semantics and constructor requirements.
Normal core-enabled Desktop now composes the native journal, browser exchange,
in-memory results and React conversation facade. The
[controlled normal desktop witness](../../docs/desktop-core.md#controlled-normal-desktop-chat)
proves two deliberate turns within one backend lifetime. Durable answer recovery,
provider-used clean retirement, production control/output profiles and ordinary
next-user-turn support in the external Responses adapter remain open. Existing
TypeScript routes outside this accepted slice retain their separate consumers.

## Turn and five-slot scheduling

`domain/turn` is pure state. Its application owner must serialize access and
persist each accepted change before the corresponding native effect. `Dispatch`
records one Send intent; it does not itself send, persist or prove acceptance.
`Accept` is separate evidence. A lost native reply, cancellation after Send, or
unresolved lifecycle never permits another dispatch. Unknown results are sticky.
Generic `Finish(cancelled)` is refused; only the conservative `Cancel` path may
classify local cancellation. A confirmed post-Send cancellation needs a separately
correlated evidence API after Desktop/Core agreement.
Only an independently designed reconciliation path could settle them; ordinary
late callbacks cannot rewrite them.

A request has admitted, pending, running, awaiting-owner, result-ready, delivered,
cancelled or unknown state. Known refusal/failure remains a distinct result
outcome. The pure `result-ready` state describes known result metadata. The
application owner publishes it only after an exact known receipt from the accepted
result retention port. That port's injected source fixture does not prove durable
answer storage or client delivery. Acknowledgement
of the exact result and lifecycle settlement are separate requirements for reuse.
`Settle` requires affirmative `QuiescenceEvidence` for the exact binding and retained
result, with an observation sequence after the latest delta. `SettlePrepared`
requires affirmative `DisposalEvidence` for the exact reservation and cancellation
result when no document was bound. Local Cancel, a generic terminal result, absent
confirmation, stale generations or delivery ACK alone cannot release a reservation.
Acknowledging an unknown result leaves the slot occupied, even with cleanup evidence.

Computer call IDs are unique within a turn. Resolved IDs remain in a fixed,
content-free deduplication array; they cannot be requested again. A late resolution
for an earlier call cannot unblock the current call, output or completion. The
preparation cap is 128 unique Computer calls per turn, refusing further requests
instead of evicting old correlation evidence. Turn value copies share no mutable
call history. Post-K0 application budget policy must agree this conservative cap.

Ordinal 1 through 5 is presentation only. Owner/session/task/turn/operation and
turn generation are durable identity. Backend incarnation and slot generation
are leases. Desktop view ID, view generation, document generation and expected
conversation are a separate exact browser binding. Every browser transition checks
the entire binding. The sixth eligible request waits. FIFO skips a later turn
whose task still owns a slot, so it cannot occupy a second view. Reuse advances the
slot generation; historical snapshots retain their old identity and binding.
`ActiveBinding` additionally checks current ownership before opening a live chat.

The scheduler has bounded pending (256) and retained request metadata (1024)
capacity. It refuses admission when saturated instead of evicting deduplication
or unknown tombstones. These are conservative preparation bounds, not a history
retention policy; durable compaction must be agreed with the result/journal owner.

Snapshots and retained result descriptors contain metadata only: no prompt,
answer, raw exception, cookie or browser storage. They do not serialize the intent
digest. Reading a snapshot, hiding a view or rendering Activity is not delivery
acknowledgement or lifecycle settlement.

## Browser capability proposal

`app/port/browser.go` is a consumer-owned application interface for Desktop/Core
agreement. It is not a second wire schema. Application/domain/contract/wire values
must be explicitly mapped. Only Core owns the canonical generated Desktop bridge;
React components consume Desktop's narrower window facade.

Capabilities are Prepare, Send, bounded Observe, exact Cancel and prepared Dispose.
They bind the exact lease/document/conversation and carry the same absolute deadline
budget. Send has transient prompt input and a digest, no arbitrary script or URL.
Observe exposes selected semantic events, no cookie or storage dump. A page has at
most 128 events, 64 KiB UTF-8 text per event, and 256 KiB combined text/code bytes.
An optional smaller request limit caps cardinality. Optional classification codes
must use `[A-Z][A-Z0-9_]*` and at most 120 ASCII bytes; raw exceptions, control
characters and malformed UTF-8 are refused. `ValidateObserveResponse`
rejects oversized pages, invalid UTF-8/kinds, wrong binding, non-contiguous sequence
and gaps before application; Core independently bounds the encoded wire frame. Cancellation
requested, confirmed terminal, already terminal and unknown are distinct.

After K0, the application owner must freeze mappings with Desktop, validate every
unknown boundary response, reject stale/gap events, require durable intent before
Send and retained result before delivery, and classify IO errors without retry.
It must explicitly map a validated Quiescent event to `QuiescenceEvidence`, or a
confirmed prepared Dispose response to `DisposalEvidence`; the domain imports no
browser DTOs. Tests supply synthetic positive and negative confirmations only.
No hidden-window, transport disconnect or missing reply is quiescence evidence.

## SSE delivery preparation

`domain/stream` holds only bounded transient payload needed for client delivery:
128 frames, 64 KiB per frame and 256 KiB per scoped buffer at most. It writes no
journal or Activity text. Every ingress/egress payload is copied. Per-turn scope
includes profile, verified backend incarnation, owner, session, task, turn and
turn generation. Sequence counters never wrap. Core's wire mapping must encode
64-bit counters losslessly; these types do not redefine the Desktop envelope.

Retention preserves full replay of retained frames, including acknowledged frames.
Only acknowledged frames may be evicted; saturation is sticky and preserves
unacknowledged content. An explicit `After` gap requires the future authoritative
observation/snapshot path. Neither replay nor reconnect dispatches a provider.
Terminal is the last append, while its retained frame remains available for
redelivery. Reading, writing and client acknowledgement are different facts.

Each client has its own cursor. A blocked live write cannot be overtaken. Drain
has one supplied monotonic deadline, capped at the current task SSE's 250 ms;
a repeated write cannot reset it. Timeout/disconnect closes only that cursor and
retains the result for another client. A fast subscriber progresses independently.
The tests subscribe successfully before simulating blocked live publish, then
exercise drain, timeout, disconnect, retention, gap and stale incarnation paths.
These are pure writer-outcome fixtures, not socket/drain or live-provider evidence.

The existing Responses model server is a separate adapter awaiting its owned
post-K0 cutover:
message/commentary/answer and reasoning status items share FIFO with tool calls;
a tool-call response terminates a round, not its conversation. Continuation must
validate the complete issued call and canonical previous outputs. Semantic-source
sequence is contiguous, unlike the older Turn's merely increasing delta sequence.
Source observer failures, cancellation and inconsistent final answer are sticky.
The relay must drain the original upstream after downstream disconnect without
retrying it. UTF-16 prompt limits cannot be replaced by Go byte/rune lengths.

This slice does not implement Responses HTTP framing, semantic-source validation,
model authentication, tool continuation, SSE socket cancellation or journal restore.
The browser port proposal also needs explicit Computer-call/semantic-block payload
agreement with Desktop/Core; no generic invoke/eval route may fill that gap.

## Parity map

| Existing source/test family                                                                                   | Go preparation evidence                                                                                                                   | Remaining cutover evidence                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/chat/domain/turn.ts`, `tests/unit/turn.test.ts`                                                  | Separate Send/acceptance; increasing deltas; completion needs a delta; exact generation/call; cancellation and lost tool ACK stay unknown | Application Computer execution and same-call result delivery                                                                |
| `run-turn.ts`, `chat-failures.test.ts`, `chat-turn.test.ts`                                                   | Same logical turn cannot get another operation dispatch; repeated/foreign/late events rejected; refusal differs from unknown              | Atomic admission/journal failure windows; real provider prepare/dispatch; Computer delivery                                 |
| `live-task-registry.ts`, `route-b-task-lifecycle.test.ts`                                                     | Five leases; sixth waits; same task cannot own two views; release needs settled lifecycle and exact delivery ACK                          | Real WebContentsView creation, navigation, document observation and close/drain                                             |
| `chatgpt-task-journal.ts`, `chatgpt-task-journal.test.ts`                                                     | Known result metadata survives undelivered observation; unknown is non-retryable and not reusable                                         | Existing journal format, private-file bounds, atomic writes and restart reconciliation                                      |
| `event-stream.ts`, `mechanisms.test.ts`, `runtime-sse.test.ts`                                                | Bounded retention; exact/duplicate ACK; retained replay; terminal-last; independent cursor drain/timeout/disconnect                       | Real socket backpressure and Core gap/snapshot mapping                                                                      |
| `codex-chatgpt-provider.test.ts`, `farol-model-streaming-transport.test.ts`, `chatgpt-visible-output.test.ts` | Source behavior vectors documented above; no Responses parity claim                                                                       | FIFO semantic/tool rounds, exact continuations, final-output validation, body/framing/UTF-16 bounds and same-upstream drain |

The queue deliberately adds waiting where the current registry returns capacity.
The Go Turn also rejects previously used Computer call IDs, strengthening the
legacy domain primitive's correlation fence without changing its TypeScript callers.
The synthetic lifecycle fixture declares provider outcomes; it performs no browser,
HTTP, native host or filesystem durability observation. It is not live acceptance.

## Source checks under the accepted root Go module

Use Core's root module and the installed toolchain; do not create a nested module:

```sh
GOTOOLCHAIN=local GOPROXY=off go test -race -cover ./modules/chat/...
GOTOOLCHAIN=local GOPROXY=off go vet ./modules/chat/...
node tooling/check-go-architecture.mjs
```

Chat production domain/app/contracts use approved pure standard-library and
module-owned dependencies only. Injected tests label their synthetic owner,
persistence and serialization evidence. They prove no installed or provider route.

The required broader gate is one canonical `task ci:fast` run reserved through
Lead. On this accepted base it includes `task test:core` (root Go race/vet,
generated bridge and import checks, transitional nested Go checks, protocol and
strict desktop bridge checks). Targeted tests or prior pre-K0 gate evidence do
not replace that exact new-range gate or its independent review. A source build
still does not prove that Go owns production admission or the shipped model route.
