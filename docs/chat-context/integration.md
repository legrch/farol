# Bounded Chat context integration

Base: `99aca15ffe16b435e59b19c20ff48e06bd56960d` (tree
`92047a064fede82658c37cf0f0a76004f6ce291c`). Policy/source-map commit:
`4846414ccdfdf04ee06fbf98ae711e8cfa9afaec`. App/composition commit:
`426e4213f2fee2a3ddfb0d6e08c978c54c9848df`. Branch:
`feature/chat-context-checkpoints`. This feature does not change shipping boot,
wire schemas, contracts, existing journals, authority or release behavior.

## Delivered packages

| Package             | Source and portable result                                                                                                                                                                                                                                                                 | Remaining integration                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 source map       | [source-map.md](source-map.md) inventories the actual B0 history/results/stream and transitional checkpoint owners.                                                                                                                                                                        | Owner-qualified complete source snapshots; completed-only history cannot reconstruct original prompts/tool rounds.                                                               |
| C2 budget           | `modules/chat/domain/contextbudget` separates canonical UTF-8 bytes, code points and injected estimated tokens, with explicit response/tool/envelope reservations.                                                                                                                         | Inject account/model capability evidence and a qualified estimator. Estimated tokens are not provider usage.                                                                     |
| C3 grouping         | Complete exchanges, full scoped turn identities, globally unique provider call IDs, exact result matching, all UNKNOWN exchanges and latest user intent remain mandatory. Incomplete sources return exact unanswered references with PENDING classification.                               | Map actual original events without truncating references or inventing tool outputs.                                                                                              |
| C4 checkpoint       | Source binding, revision/range/IDs and injected SHA-256; immutable prepared plans; closed import decoding; one-shot publish and observation-only recovery through controlled ports.                                                                                                        | Existing checkpoint-store adapter with source-head CAS and durable operation observation. No new database or existing store/schema change is included.                           |
| C5 optional summary | Explicit one-shot optional port; exact source/prompt version, untrusted label, UTF-8 and budget checks; failures leave original safe context.                                                                                                                                              | No network summarizer is composed. A future provider adapter needs separate authorized usage and durable admission/observation.                                                  |
| C6 interruption     | Portable before/after-write, lost/mismatched ACK, concurrent publish, stale append, revoked account, missing result, interrupted/late summary, hostile imported permission and bounded recovery cases. Existing compaction regressions exercise actual B0 adapter ACK/completion behavior. | Linux controlled store effects are not native crash/fsync qualification; no new compaction RPC or live retry is implemented.                                                     |
| C7 consumption      | `Service.Materialize` builds complete explicit Responses-style history and checks actual emitted JSON bytes/code points/estimated tokens. UNKNOWN outcome and exact tool operation data reach provider input independently of misleading prose.                                            | INFERENCE must use this value in its actual client and recheck its original account/model lease immediately before transport IO. No Browser IDs or previous-response dependency. |

## Consumer composition

Construct `contextcheckpoint.New(Dependencies)` with an existing Chat-owned gate,
source owner, SHA-256 digester and estimator. The service never performs provider
dispatch. `ResultsSource` reuses `port.DurableResults.Read` for owner-qualified
completed answer publications and takes original prompt/tool events from
`OriginalResults`; it does not turn retained answer text into recovered prompts.
`OriginalResults.CheckOriginal` must pin the same live activation and disclosure
lease, account/model selection and exact immutable revision after every read.

Call `Prepare` with owner-issued checkpoint/operation IDs and an explicit policy,
then `Materialize` with the same binding. Preserve `Materialized.Window.Source`,
original event IDs and `Unresolved` beside the wire JSON. Tool outputs are encoded
as quoted JSON data containing source outcome, original turn, tool operation and
result event IDs plus exact original text. Their prose cannot turn UNKNOWN into
known completion or redispatch permission. Optional summary text is quoted user
data and never a system/developer instruction.

The provider body intentionally contains only model, explicit input and
`store:false`. INFERENCE owns endpoint restrictions, effort mapping, response
limits, tools/consent and transport. This is a tested context consumer seam, not
a new standalone provider client or live entitlement claim.

The continuation adds `MaterializePlan` and a detached source/policy-bound
receipt for the pinned flat INFERENCE input and HTTP envelope. See
[plan-compatibility.md](plan-compatibility.md) for actual fixture readback,
canonical hashes, reservation tests and precise consumer-side identity limits.
C7 has fixture consumption; shipping boot/store/authority integration remains
open. Original Materialized.JSON and the pinned application InputHash are
different representations and must not be substituted for one another.

## Exact shared-change requests

1. The existing Chat/context source owner should implement `OriginalResults`
   using its original immutable prompt/tool source records and exact qualified
   result publications. Preserve gaps/non-atomic observations as refusals.
   Capability epoch/account/model values are correlation, never grants. The
   adapter must not reacquire a fresh lease to make an old snapshot current.
2. The existing checkpoint owner should implement the new consumer-local
   `CheckpointStore` port, preserving its existing private source/checkpoint
   store. `Publish` must atomically validate expected source head and original
   current lease, record checkpoint/operation digest once and return an exact
   receipt. `PublishRefused` is allowed only with proof of no write; nil/error,
   mismatched receipt or post-IO loss of current source stays UNKNOWN. Observe
   must read only the original operation and supply independently bounded bytes;
   `DecodeCheckpoint` and recovery both reject unbounded/imported fields.
   Observing lost-ACK content does not acknowledge publication, delivery or
   compaction and does not permit another publish. Keep source originals or an
   exact owner-qualified reconstruction path; do not silently prune journals.
   A nil observation must prove the original operation absent, including durable
   admission and UNKNOWN bookkeeping; an inconclusive observation is an error,
   never permission to redispatch. Restart preparation observes before admission.
3. INFERENCE should consume `Materialized.JSON` and its identity sidecar through
   an owner-controlled mapped seam, verifying the complete selected binding and
   original consent immediately before send. No cross-service import, published
   contract or boot edit is included in this branch.
   For the inspected plan client, explicitly map `PlanView.Items` and retain
   `PlanReceipt`/Window: its ordered InputHash is not the original wire hash.
   Bind full source/UNKNOWN identity and all reservations to the admitted
   operation; the current ContextSelection fields alone do not express these.
   Check the actual emitted bytes against ProviderHash/policy before IO.
4. Keep `src/apps/desktop/codex-host-compaction.ts` under its current owner.
   Its current one-shot RPC waits beyond immediate ACK. Any future Go adapter
   needs transferred schema qualification and explicit event/operation binding;
   this branch adds no second compaction engine.

## Reproduction and evidence limits

Use the repository's declared Go 1.26.2, Node 24.20.0 and npm 11.19.0, with
task-owned caches or the verified Linux dependency cache. No network is required
for the new Go fixtures:

```sh
go test -race ./modules/chat/domain/contextbudget ./modules/chat/app/services/contextcheckpoint
go vet ./modules/chat/domain/contextbudget ./modules/chat/app/services/contextcheckpoint
go test -run TestLongConversationMaterializesBoundedCompleteRequest -v ./modules/chat/app/services/contextcheckpoint
go test -run '^$' -bench BenchmarkSelectLongUTF8Conversation -benchmem ./modules/chat/domain/contextbudget
node tooling/check-go-architecture.mjs
git diff --check
```

The 1,000-round composition fixture uses the real ResultsSource, service, gate,
SHA-256 and materializer plus controlled source/store/read ports; real
`results.Memory.Retain` validates the retained result setup. It selects 57 of
4,001 events, emits 26,926 bytes / 23,286 code points / 7,762 estimated tokens,
and retains exact UNKNOWN `tool-1` call/result references. Values are fixture
measurements, not upstream token usage. Domain benchmark uses 1,200 rounds.

Hard limits: 8,192 source events, 64 KiB/event text, 16 MiB canonical input,
4 MiB outbound budget, 8 MiB checkpoint import, 16 MiB total serialized prepared
windows and 1,024 reserved operations per service lifetime. Capacity never
evicts originals or a known plan. The prepared byte cap measures serialized
payload, not total Go heap; benchmark allocations and fixture limits are reported
separately. Ports and estimators must be safe for the application's concurrency.

Original failures retained: malformed summary UTF-8 regression (fixed); initial
compiler cache/module-cache permission and offline module-cache setup failures
(resolved using verified Linux caches); an initial loopback checkpoint-authority
fixture returned EPERM (then passed with supported local network access).
`task ci:fast` exited 201 after successful toolchain/type/lint/format/architecture
checks; its broader suite failed, including native platform unsupported cases,
`GO_BACKEND_NODE_STARTUP_HOOK`, lock/platform limits and an unrelated selected-view
layout assertion (x=302/width=878 vs x=296/width=884). No shared foundations were
changed to hide these failures. Remaining gates: aggregate CI, existing storage
and INFERENCE shipping composition, qualified formal review, live provider and
Mac/native qualification. SOURCE/PORTABLE/controlled COMPOSED are distinct from
shipping integration, LIVE, MAC and release acceptance.
