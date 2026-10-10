# CONTEXT source handoff

Branch: `feature/chat-context-checkpoints`. Base B0:
`99aca15ffe16b435e59b19c20ff48e06bd56960d`, tree
`92047a064fede82658c37cf0f0a76004f6ce291c`.

Coherent source commits:

- `4846414ccdfdf04ee06fbf98ae711e8cfa9afaec`: bounded policy, indivisible
  exchanges, exact unresolved identities, source map and domain regressions.
- `426e4213f2fee2a3ddfb0d6e08c978c54c9848df`: source-bound checkpoints,
  recovery, untrusted optional summary, existing result-port adapter and actual
  provider request materialization/composition tests. Source tree:
  `c5fca555d2ed9dbf10c9f9883663450161af9786`.
- `8462ce80cb9d0c17e0409210dc3382d1547ae800`: demonstrated malformed UTF-8
  import correction and exact serialized-budget edge regressions. Source tree:
  `f11bc469deb100b5cafefbaf1fd9916595e9792f`. See
  [acceptance-audit.md](acceptance-audit.md) for the C1–C7 audit.

SOURCE and PORTABLE are delivered. Controlled COMPOSED means the actual Go
ResultsSource/service/gate/materializer with injected source/store ports and
real result retention, not shipping boot or a live provider. Both source commits
were normally pushed with exact remote readback. Shipping integration, LIVE,
MAC/native qualification and formal review remain open. No main merge, tag,
release, native compaction call or new database is included.

## Measured result

The 1,000-round synthetic conversation has 4,001 original events. The actual
request retains 57 events in complete exchanges and emits 26,926 bytes / 23,286
code points / 7,762 estimated tokens, preserving exact UNKNOWN `tool-1`
references. No estimated value is reported as provider usage. Dense recovery
also passes with 8,192 events and 4,095 UNKNOWN call/result pairs.

The 1,200-round UTF-8 benchmark measured 33,132,464 ns/op, 12,408,453 B/op and
29,032 allocations/op (three iterations, Linux AMD EPYC). This is fixture
performance, not a production latency or total prepared-state heap guarantee.

## Verification and original failures

At the exact app commit, targeted domain/app race tests and vet, architecture
enforcement, long-conversation materialization and benchmark pass. Independent
bounded inspection found receipt-aliasing and oversized typed recovery risks;
regressions and fixes are included. This inspection is not formal Critic R3/R4.

The existing compaction/reconciliation/provenance suites passed 42 tests across
three files. The initial checkpoint-authority fixture failed to listen on
loopback with EPERM; its supported local-network rerun passed the remaining
test. No live provider or native runtime effect was tested.

`task test:core` at the app commit exited 201. Generated wire and architecture
checks passed; root race tests failed in existing Computer packages:

- `TestRepositoryConfigNativeOrdinaryReadCreateEdit` refused
  `WORKSPACE_PATH_REFUSED (native-workspace)`.
- `TestNativeMutationPublicationSerializesSoleStoreWithdrawal` did not enter
  publication in eight settings/connector cases.
- `TestCreateRefusesUnsafePrivateDirectoryAndLock/lock-mode` reported
  `unsafe authority owner acquired`.

Those paths are outside this lane and were preserved. The aggregate gate remains
failed. Its skipped checks were run independently: root vet, nested release
race/vet, desktop wire and Go architecture contract tests, strict desktop types
and root types all pass.

The frozen app commit's `task ci:fast` also exited 201: 445 files / 11,093 tests
passed, 51 files / 576 tests failed, 7 files / 305 tests skipped and 2 tests todo.
Toolchain, types, lint, format and TypeScript architecture passed before the
coverage suite failed. Original categories remain native platform unsupported,
startup hook, lock/platform limits and the unrelated selected-view layout
assertion (x=302/width=878 vs x=296/width=884). Renderer coverage and later gates
were not reached. No unchanged broad gate is scheduled again. See
[integration.md](integration.md) for corrected development regressions and limits.

## Narrow shared-owner requests

The exact consumer types and obligations are documented in
[integration.md](integration.md), with original owners in
[source-map.md](source-map.md). Implement only the following negotiated seams:

1. OriginalResults: immutable original prompt/tool records plus qualified
   existing DurableResults reads and same-live-lease source-head checks. Refuse
   gaps and non-atomic history; retained answers cannot reconstruct prompts.
2. CheckpointStore: extend the existing owner with source-head CAS, exact
   operation/digest receipts and durable admission/UNKNOWN observation. Nil
   observation must prove absence; lost ACK never authorizes another write.
   Keep source originals or exact reconstruction and existing journals intact.
3. INFERENCE: map Materialized.JSON plus its original identity sidecar into the
   real client, rechecking original account/model/consent before transport.
   Estimated budgeting needs a qualified model estimator and response/tool
   reservations. No new boot/contract edit is included here.
4. Optional summary: map the existing one-shot summary owner, with exact source
   and prompt-version binding and independently authorized durable usage. Its
   input is selected original context; it is not a reconstruction of omitted
   history. Text remains untrusted data and cannot restore authority.

The existing desktop compaction owner retains its RPC/completion semantics.
This branch provides no second engine, source pruning, permissions from summary
text or redispatch of unresolved operations.
