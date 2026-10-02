# Chat preparation

This module is a pre-K0 preparation slice. It is not connected to the production
model route, Electron host, React facade, HTTP server or durable journal. The active
TypeScript implementation remains authoritative until its vertical cutover.

## Turn and five-slot scheduling

`domain/turn` is pure state. Its application owner must serialize access and
persist each accepted change before the corresponding native effect. `Dispatch`
records one Send intent; it does not itself send, persist or prove acceptance.
`Accept` is separate evidence. A lost native reply, cancellation after Send, or
unresolved lifecycle never permits another dispatch. Unknown results are sticky.
Only an independently designed reconciliation path could settle them; ordinary
late callbacks cannot rewrite them.

A request has admitted, pending, running, awaiting-owner, result-ready, delivered,
cancelled or unknown state. Known refusal/failure remains a distinct result
outcome. `result-ready` means known result metadata is available, not that answer
bytes have been durably saved. The future application must publish this state only
after its accepted result owner has retained the actual result. Acknowledgement
of the exact result and lifecycle settlement are separate requirements for reuse.
Acknowledging an unknown result leaves the slot occupied.

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
Observe exposes selected semantic events, no cookie or storage dump. Cancellation
requested, confirmed terminal, already terminal and unknown are distinct.

After K0, the application owner must freeze mappings with Desktop, validate every
unknown boundary response, reject stale/gap events, require durable intent before
Send and retained result before delivery, and classify IO errors without retry.
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

The existing Responses model server is a separate adapter still awaiting K0:
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
The synthetic lifecycle fixture declares provider outcomes; it performs no browser,
HTTP, native host or filesystem durability observation. It is not live acceptance.

## Checks before the root Go checkpoint

Use the installed Go toolchain without inventing a second module:

```sh
GO111MODULE=off go test -race -cover ./modules/chat/...
GO111MODULE=off go vet ./modules/chat/...
```

Go domain packages use only pure standard-library dependencies and have no IO,
clock, Electron, transport or other module imports. Once Core's root module is
integrated, run these packages through that module and its dependency checker.
Continue testing the existing nested native Go module during the transition.
The current `task ci:fast` also remains required; it does not discover Go tests
or prove that Go is part of the shipped artifact.
