# Plan inference integration handoff

This is a source-only integration candidate on `feature/chatgpt-plan-inference`.
All implementation and co-located tests are confined to the accepted inference
app, `planresponses` adapter and inference documentation roots. No Browser queue,
Task provider client, boot, shared schema, journal implementation, Computer
authority, release or installed application was changed.

## Exact source

- B0: `99aca15ffe16b435e59b19c20ff48e06bd56960d`;
  tree `92047a064fede82658c37cf0f0a76004f6ce291c`.
- Application policy checkpoint:
  `a9855f9fb22d28583f78ba5eb5b3859e4f2e075d`.
- Production transport/composition checkpoint:
  `37a76f39d7ad94a3e1f27b438fa84d87fb985c3a`;
  tree `eca3882b7184af54a2df2c92bd0d33ef9c240539`.
- Bounded acceptance/fuzz checkpoint:
  `93e9c24efca0df6e43081373854911c8943a42ee` (the subsequent filename correction
  preserves all test bytes; its failed static check is retained below).
- Filename correction: `02654e0b851766eafdc207ae80204fd55004f9ef`;
  tree `10f969406999106481e0191c4bb94951b204c3dd`.
- Initial final handoff: `e2824968b72fb891774a4cdda7f0beaa2c893842`;
  tree `ea403e2c9439024cfa1d34706874d44e0a7b9694`.
- The subsequent pinned-consumer witness is confined to this documentation root;
  its script copies the test fixture into a disposable external adapter assembly.
  Production code remains exactly the implementation checkpoint above. Inspect
  the branch HEAD and export manifest for the final witness commit/tree.

## Seven-package result

| Package                         | Source result                                                                                                                                                                                              | Boundary still requiring its owner                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| I1 spike mapping                | Existing Browser/inbound SSE/account grant/model settings/Task paths classified KEEP or ADAPT in README.                                                                                                   | No replacement of accepted foundations.                                    |
| I2 SIWC credentials and consent | Explicit issuer/subject/issued client/host/epoch, requested **and** granted direct scopes, complete atomic rotating credential, private Grant fence, one-shot uncertainty and revocation policy.           | Trusted OAuth/OIDC/registration and actual selected secret-store adapter.  |
| I3 public Responses             | Fixed public endpoint, redirects refused, `store:false`, `stream:true`, explicit ordered no-tools history, bounded strict SSE and safe diagnostics.                                                        | Separately authorized one-shot live subscription/model entitlement check.  |
| I4 cancellation/post-IO         | Original deadline bounds all IO; original selection rechecked around IO and final publication; remote completion survives delivery withdrawal; entered publication errors remain UNKNOWN.                  | Real journal extension and physical delivery writer fence.                 |
| I5 actual composition           | Real Service + private account Grant + ConsentFence + HTTP builder/parser; additional real CredentialManager rotation/lost-reply/deadline composition.                                                     | Shipping boot wiring, real owner ports and host qualification.             |
| I6 model/context consumption    | Actual pinned MODELS Resolve and CONTEXT Prepare/Materialize reach the real Service + public builder/parser in a reproducible disposable assembly; exact history/hash, lifetime and no-replay checks pass. | Shipping mapped seam and explicit incompatible role/effort/wire decisions. |
| I7 App Server follow-on         | Inert public-plan stdio configuration and bounded renewal/clean original stop/new initialize/same-thread resume contract; stale/unknown lifetimes fenced.                                                  | Separately owned Task/process composition; no process or RPC launched.     |

The additional shipping-advertisement acceptance boundary is closed at source:
static inspection found zero inference imports/route identifiers in boot,
desktop/TypeScript shipping and neighboring module roots. This is source absence,
not qualification or activation. The actual lane source has seven packages;
unrelated workflow/compaction capabilities remain with their respective owners.

SOURCE is implemented. COMPOSED is demonstrated through controlled synthetic
ports and production service/adapter code, including exact public producer sources
for I6. See [CONSUMER-WITNESS.md](CONSUMER-WITNESS.md) for pins, executable
reproduction, actual nine-test/33-subcase results and mapping limits. This is
controlled composition; shipping producer imports/boot are not included.
PORTABLE targeted checks pass.
Aggregate acceptance is open; PUSHED must be established from the actual remote
branch receipt, independently of these source/test claims.

## Tested bytes and original failures

The declared Go 1.26.2, Node 24.20.0 and npm 11.19.0 were used, with Go module
downloads disabled and cached modules. Locked npm installation completed with
scripts disabled; no manifest or lock was changed.

- B0 private account-approval portable race baseline passed. An earlier broad
  Chat-suite invocation lost its terminal handle; its completion remains
  UNVERIFIED and is not used as a pass.
- `go test -race -cover -count=1 -timeout 60s
./modules/chat/app/services/inference
./modules/chat/infra/clients/planresponses` passed. Statement coverage:
  application 88.8%, adapter 87.1% after the acceptance additions.
- Bounded actual fuzz runs passed: app lifetime/no-replay 74,452 executions in
  6.016 seconds; stream fragmentation/fail-closed mutations 61,909 executions in
  8.916 seconds, each with two workers. Exact input item/encoded-byte and output
  text/event/line caps, every pre-terminal truncation, duplicate/late terminals,
  and real-consent publication closure/expiry passed. No additional production
  defect was found. Short fuzz runs are mutation evidence, not exhaustive proof.
- Targeted `go vet`, `node tooling/check-go-architecture.mjs`, owned Prettier and
  diff-whitespace checks passed. Root `go vet ./...` passed. Nested release Go
  race tests and vet passed on Linux; this is not Mac/native qualification.
- Root `go test -race -count=1 -timeout 90s ./...` exited 1 outside the owned
  roots: `TestRepositoryConfigNativeOrdinaryReadCreateEdit` in Computer
  filesystem reported `WORKSPACE_PATH_REFUSED (native-workspace)`;
  `TestNativeMutationPublicationSerializesSoleStoreWithdrawal` in Computer access
  reported `publication was not entered` for settings/connector mutation vectors.
  Owned inference packages passed within that run. No B0 reproduction of those
  aggregate failures was performed; they are not declared pre-existing defects.
- Desktop wire generator initially lacked `gofmt` on PATH; with the declared
  toolchain it did not terminate. Its bounded 45-second invocation timed out.
  Generated files were not changed; generator acceptance remains open.
- Stable `task ci:fast` timed out at its 180-second bound (wrapper exit 124;
  terminated task exit 143). It passed toolchain/type/lint/format/architecture
  stages, reached unchanged TypeScript tests and reported failures including
  Computer/delegation, native view, installed update, workspace snapshot and
  bounded-process tests. It did not complete coverage/Hunt/core/output gates;
  no aggregate pass is claimed, and the unchanged aggregate was not repeated.
- Working-tree secret scan and exact authored `B0..37a76f3` commit-range scan
  found no leaks. An earlier all-history scan exited 0 while emitting unavailable
  promisor/proxy history errors: that command does **not** prove all-history
  coverage. Original errors are retained in task-owned terminal evidence.
- Intermediate authoring failures remain recorded: pure-app `reflect` import
  (replaced with explicit full equality); missing shared test fixtures while
  parallel files were incomplete; missing mandatory Deadline options during the
  service/composition refactor; one mistyped static-script path. Subsequent exact
  targeted runs passed. These were test/development failures, not provider effects.
- The new test checkpoint's race/vet passed but its static run rejected
  `lifetime_fuzz_test.go` and `stream_fuzz_test.go` as `GO_SHORT_NAME`. The failed
  static result was inspected after that checkpoint commit. The files were
  renamed to `lifetimefuzz_test.go` and `streamfuzz_test.go` with unchanged bytes;
  corrected architecture and focused race seeds passed before the follow-up commit.

Bounded independent review found and regression-checked protocol case/Unicode
aliases, contradictory final item statuses, refreshed-ready restart admission,
clock rollback and post-publication uncertainty. Its final source-diff digest was
`8fed06764ba0266d522356532692bdc04a96362e0d685ffb961adedec1bab65b`
(application + adapter roots). This is an inspection receipt, not formal Critic
acceptance. Formal risk-based R3/R4 review remains REVIEW_PENDING; no model or
billing change was made to obtain it.

## Exact owner seam requests

1. **Boot/account owner:** inject `inference.Options` including
   `planresponses.OperationDeadline`, the actual private `accountapproval.Grant`,
   and `SelectedAccountSource.WithSelected`. The latter must serialize the whole
   callback against exact OAuth account/consent/catalogue changes and supply a
   verified current `AccountObservation`. Map the verified SIWC issuer/subject to
   that existing principal; a detached identity snapshot or scope list cannot
   mint a grant. No Browser slot admission is requested for direct inference.
2. **Secret/consent owner:** implement bounded `CredentialStore.Read` and full
   atomic `CompareAndSwap` plus one-shot `RefreshProvider` and live
   `CredentialPolicy`. Persist complete identity/consent/scopes/tokens/expiry/
   earliest refresh/generation/state/revision/**RefreshProduced** together.
   A revision must identify immutable complete bytes. Unknown/legacy origin must
   not default to trusted `RefreshProduced=false`. Every restarted manager refuses
   refresh-produced Ready records, even acknowledged rotations; independent owner
   requalification must advance account epoch and record revision. No durable
   reconciliation or OAuth UI implementation is supplied here.
3. **Journal/authority/delivery owners:** adapt existing journal capability to
   `Ledger.Reserve(ctx, Binding, intentDigest)` and content-free `Ledger.Settle`.
   Reserve atomically consumes the exact operation before IO; uncertainty is
   sticky across restart, never resolved by dispatching again. `Publication`
   performs bounded in-memory publication under the same original Authority;
   actual socket/host writer rechecks that authority immediately before its write.
   All IO ports obey the child context. No new journal/schema is requested here.
4. **MODELS owner:** map an accepted account-scoped selection into
   `ModelSelection{Slug, Effort, CapabilityEvidence, CatalogueEpoch}` together with
   exact `Selection.Account`. Confirm model and effort for that selected account;
   a cached catalogue is not entitlement. The disposable I6 witness consumes exact
   published source `3b8aaff57ae3599e01e8edad1a7a71cd6daf5cd9` without merging it
   into this branch. Preserve the full pin/capabilities beside the mapped digest;
   a later selection cannot rewrite a reserved intent. Exact unsupported efforts
   and account/route/billing mismatches are refused, never substituted.
5. **CONTEXT owner:** supply immutable ordered `[]InputItem` plus
   `ContextSelection{CheckpointID, InputHash, EstimatedTokens, TokenLimit}`.
   Compute the digest over the same canonical ordered input; preserve complete
   required prior function call/results and refuse unresolved rounds. Do not
   infer a guaranteed token count from the bounded estimate. The disposable I6
   witness consumes exact published source
   `6d459925fc02c14b761fa3d1001038cf007be402` without merging it into this branch.
   Retain the complete original SourceRef and UNKNOWN sidecar under the same
   captured Binding authority. Instruction role, absent effort and strict wire
   incompatibilities remain explicit owner decisions in CONSUMER-WITNESS.
6. **Task/process owner, future only:** map verified registration identity and
   account/model capability to `AppServerConfig`; own process creation,
   `ACCESS_TOKEN` injection, ambient tool/config isolation, original stop/join,
   initialize and retained-thread resume. Supply exact one-shot evidence to the
   immutable `AppServerLifecycle` under owner serialization. Existing proxy/Task
   client, Computer grants and provider effects are unchanged.

## Remaining gates

Production boot/secret/journal/physical writer composition; shipping MODELS and
CONTEXT mapped seams; aggregate generator/CI failures; formal review; authorized LIVE
SIWC registration/OIDC/direct inference and failure semantics; MAC secret
storage/process cleanup/resume; package/install/shipping qualification. No main
merge, release, native acceptance or live provider success is claimed.

The original GraphQL PR attempt returned `Forbidden` and remains held. No PR ID
is verified; [MANUAL-PR.md](MANUAL-PR.md) contains a source-only title/body.
