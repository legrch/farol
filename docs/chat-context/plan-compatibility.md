# Pinned plan-consumer compatibility

Producer checkpoint: `71c0ec8dee9fa5482f891ed483caf1d2f46ef15c`, tree
`c1d47bbc3a45b078d0b542117df41addbed132a5`. It continues CONTEXT F
`6d459925fc02c14b761fa3d1001038cf007be402` on the same assigned branch and B0.
INFERENCE read pin: `e2824968b72fb891774a4cdda7f0beaa2c893842`, tree
`ea403e2c9439024cfa1d34706874d44e0a7b9694`. The isolated checkout's actual
`input.go`, `types.go`, `service.go` and `planresponses/{client,json}.go` were
inspected. No INFERENCE files were imported into this product branch.

## Delivered producer boundary

`Service.MaterializePlan` consumes the real original `Materialize` result and
produces an opaque `PlanMaterialization`. `View(ctx)` checks the same current
source lease and returns detached closed `PlanItem` values, exact input/provider
JSON, original Window identity sidecar and a `PlanReceipt`. This is pure mapping
and correlation data; it performs no provider dispatch, storage publication,
authority admission or compaction ACK.

| Representation              | Exact semantics at the inspected pin                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original Materialized.JSON  | Existing nested Responses-style messages, original system instruction role, complete function rounds; its original bounded composition remains passing. It is not the consumer's InputHash bytes.                                                                                                                                |
| PlanView.Items / InputJSON  | Fields `Kind, Role, Content, CallID, Name, Arguments` in this order, including empty fields, using Go's canonical JSON/HTML escaping. Original instruction messages explicitly map to developer; optional summaries stay quoted user data. Results preserve their full quoted outcome/operation/turn/event JSON.                 |
| Receipt.InputHash           | SHA-256 of the ordered canonical application input, exactly matching real `inference.InputHash`. Neither provider body nor original transcript digest may be substituted.                                                                                                                                                        |
| ProviderJSON / ProviderHash | Exact pinned HTTP body: flat message content, original call arguments/output, `store:false`, `stream:true`, original effort in reasoning. No tools, previous-response ID, Browser ID or added execution capability.                                                                                                              |
| Receipt.IdentityHash        | Separate SHA-256 over original checkpoint/operation IDs, full source binding/range/revision/digest, all policy limits/reservations, input/provider hashes and measured usage. Identical selected provider text does not erase different original source/account/policy identity.                                                 |
| Budget                      | Both canonical application input and exact HTTP bytes must fit every original dimension after reservations; each also has the pin's 256 KiB cap and 128-item cap. Token estimate is the larger input/wire estimate; TokenLimit subtracts the original token reservation. All byte/code-point reservations remain in the receipt. |

Returned views cannot mutate retained items, bytes, UNKNOWN identities or receipt
hashes. Repeated unchanged preparation produces the same bytes and receipt. A
new source (including omitted original bytes), input order, account or reservation
has a different identity. Every expose rechecks the original source; none grants
permission to reacquire a lease or reuse an unresolved operation.

## Actual fixture consumption

The committed [disposable fixture](fixtures/pinned-plan-consumer_test.go.txt)
was run with byte-identical producer files in the isolated exact INFERENCE pin.
It uses real `ValidateRequest`, `InputHash`, `Service.Infer` and the real
`planresponses.Client`, with a controlled in-memory RoundTripper and synthetic
authority/ledger/credential/publication ports. No real credential, network send,
OAuth, provider usage or native effect occurs.

Readback: 1,000 rounds become **57 items, 27,847 canonical application-input
bytes and 26,060 actual captured HTTP bytes**. InputHash:
`e4189f1a06f091b68fa8fe500e0ba3720a822abf572feb3c8484ac251e4435c1`;
ProviderHash:
`9bf2075739818d2326d7c49d82c02a7256b9dc1f820d1d1cfff3cbd71c32cf8c`.
The actual body matches budgeted ProviderJSON byte-for-byte. Parsed tool output
retains UNKNOWN `tool-1` with the exact call, original turn and result event from
the sidecar. TokenLimit is 11,952 after reserving 2,048 estimated tokens. These
are synthetic measurements, not upstream usage or provider-native completion.

The actual inference service refuses reordered/edited items with the original
InputHash before ledger reservation or HTTP entry. Producer regressions cover
eight Unicode/escaping cases, detached mutation, stable repeated bytes, omitted
source changes, account/order/all three reservation identities, original
Materialized mutation, unsupported historical call IDs and fresh-lease exposure.
Additional conversion tests keep a request within its old representation's
budget while the mapped representation exceeds a reservation by one unit; all
three dimensions refuse without exposing a plan. Existing malformed-UTF8 and
original exact-limit cases were retained, not duplicated as another campaign.

## Minimal incompatibilities and precise remaining seam

1. An unmapped message with `Role:"system"` is rejected by the pinned
   ValidateRequest. Only original instructions map to developer; summary text
   cannot request this conversion. Sending original Materialized.JSON directly
   would also use the wrong shape/hash and omit the pinned stream/reasoning
   envelope. Use the explicit mapped projection and confirm captured bytes.
2. Source IDs can contain Unicode, but pinned HTTP call IDs/names/model slugs
   require ASCII letters/digits/underscore/dash/dot. The producer mapping refuses
   an unsupported call, rather than deleting it or inventing a replacement ID.
   It likewise refuses a required history above 128 items/256 KiB.
3. Function arguments `{"x":1,"x":2}` pass Go's json.Valid but are refused by
   the actual HTTP builder's strict argument JSON parser. The projection preserves
   original bytes; it is not a claim that every source argument is accepted by
   that parser. The fixture proves NotSent/Invalid with zero HTTP calls and no
   tool-free fallback. Depth/surrogate/duplicate-key qualification remains the
   transport owner's validation; malformed source pairing remains a producer
   refusal before projection.
4. The pinned ContextSelection carries only CheckpointID/InputHash/estimated
   tokens/TokenLimit. It cannot itself represent full SourceRef, UNKNOWN sidecar,
   IdentityHash or byte/code-point policy/reservations. INFERENCE's mapping owner
   must bind the original complete PlanReceipt and sidecar to its admitted
   operation, preserve them under its existing durable authority/journal seam and
   check actual final body equality plus policy before IO. Do not reuse a bare
   InputHash as whole-source identity: different omitted originals may produce
   identical selected input. An opaque CONTEXT AccountID is not automatically
   a verified INFERENCE AccountIdentity or consent grant. No shared contract,
   ledger/store/authority or boot edit is made by this lane.

C7 now has **fixture consumption**, not shipping integration. Original source
adapter and checkpoint-store CAS/durable UNKNOWN observation remain deferred to
their existing owners. Existing failed aggregate/native/layout gates are
unchanged; no broad gate was rerun for this supplement. Formal review, LIVE
provider, MAC/native, packaging and release remain separate gates.

## Reproduction

Use declared Go 1.26.2 with qualified dependencies. Set CONTEXT_SOURCE to a clean
checkout of the named producer commit or later docs-only continuation. The
following disposable overlay is test evidence; never merge it into a feature
branch:

```sh
git clone --no-checkout https://github.com/legrch/farol.git work/context-consumer-fixture
cd work/context-consumer-fixture
git checkout --detach e2824968b72fb891774a4cdda7f0beaa2c893842
mkdir -p modules/chat/domain/contextbudget modules/chat/app/services/contextcheckpoint
cp -R "$CONTEXT_SOURCE/modules/chat/domain/contextbudget/." modules/chat/domain/contextbudget/
cp -R "$CONTEXT_SOURCE/modules/chat/app/services/contextcheckpoint/." modules/chat/app/services/contextcheckpoint/
cp "$CONTEXT_SOURCE/docs/chat-context/fixtures/pinned-plan-consumer_test.go.txt" modules/chat/app/services/contextcheckpoint/pinned_plan_consumer_test.go
go test -race -run 'TestPinned|TestPlan|TestLegacyMaterialized' -v ./modules/chat/app/services/contextcheckpoint
```

Targeted producer race/vet and architecture checks pass; bounded independent
inspection found no concrete blocker. Original development evidence includes an
initial conversion fixture whose canonical source metadata exceeded its chosen
limit (corrected with a realistically escaped result) and a wrong-workdir copy
that stopped before any witness test (corrected by byte-verified overlay sync).
Neither was mislabeled as a product defect or as passing consumer evidence.
