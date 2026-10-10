# Coordinator branch archive — 10 October 2026

Status: archival source and documents only. No runtime activation, policy adoption,
current review acceptance, or package/live qualification is supplied by this archive.
The reconciliation baseline is `aa242b08f755618db8081b638e013b24ec1e28bb`.

The root coordinator owns the aggregate 25-branch disposition. This directory and
`_output/evidence/daily-stability-20261010/audit-coordinator.json` cover only the
seven named branches below; they do not duplicate or close that aggregate.

## Exact snapshots and original paths

[original-path-map.json](original-path-map.json) records every original path,
full source commit, archive path, Git blob object ID, byte count, and SHA-256.
Each payload is copied directly from its pinned Git blob without content changes,
including its original newline bytes. The full commit directory is part of every
archived payload path. Executable sources use `.ts.txt` or `.mjs.txt` so ordinary
TypeScript/MJS source discovery does not activate, compile, or lint these files.
No imports, package scripts, tool registrations, or test selectors are added.

| Snapshot                                      | Full source commit                         | Exact original files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution proposal                            | `ce91353d5d1c7f114ca9f276cdd44cdfa86d2f08` | [docs/proposals/verification-execution-contract.md](frozen/ce91353d5d1c7f114ca9f276cdd44cdfa86d2f08/docs/proposals/verification-execution-contract.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Final integration sequence                    | `c3b0c7ea147aad7871d6bfc88ba5112889528348` | [docs/proposals/coordinator-integration-sequence.md](frozen/c3b0c7ea147aad7871d6bfc88ba5112889528348/docs/proposals/coordinator-integration-sequence.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Frozen V0 parity inventory                    | `3c823c1b590a48baa31dcc5c8dd58109e81e96f8` | [docs/v0-parity-ledger.md](frozen/3c823c1b590a48baa31dcc5c8dd58109e81e96f8/docs/v0-parity-ledger.md); [tests/fixtures/v0-parity-baseline.json](frozen/3c823c1b590a48baa31dcc5c8dd58109e81e96f8/tests/fixtures/v0-parity-baseline.json); [tests/fixtures/v0-parity.selftest.mjs](frozen/3c823c1b590a48baa31dcc5c8dd58109e81e96f8/tests/fixtures/v0-parity.selftest.mjs.txt); [tooling/check-v0-parity.mjs](frozen/3c823c1b590a48baa31dcc5c8dd58109e81e96f8/tooling/check-v0-parity.mjs.txt)                                                                                                                                                                                       |
| Requested intermediate task-control candidate | `2a7ce30f81db4637e7ff130463648a4c7773b5ed` | [docs/task-control-candidate.md](frozen/2a7ce30f81db4637e7ff130463648a4c7773b5ed/docs/task-control-candidate.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Hardened four-file owner-message prototype    | `1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb` | [src/modules/chat/app/port/owner-task-messages.ts](frozen/1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb/src/modules/chat/app/port/owner-task-messages.ts.txt); [src/modules/chat/app/service/send-owner-task-message.ts](frozen/1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb/src/modules/chat/app/service/send-owner-task-message.ts.txt); [src/modules/chat/infra/native/native-owner-task-message-sender.ts](frozen/1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb/src/modules/chat/infra/native/native-owner-task-message-sender.ts.txt); [tests/integration/owner-task-messages.test.ts](frozen/1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb/tests/integration/owner-task-messages.test.ts.txt) |

The task-control document deliberately retains the requested intermediate
`2a7ce30f81db4637e7ff130463648a4c7773b5ed` snapshot. It is not the final document
at the branch tip. The four-file owner prototype retains the hardened snapshot
at `1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb`, not the original uncorrected
`f6efaba3bed7da6d26a6c1b7234872398e5f02e4` bytes. Internal relative links,
commands, original source paths, and historical statements are untouched; they
are provenance, not instructions to execute or restore their old destinations.

## Current owning implementation

At the reconciliation baseline, Go Task and Chat own backend policy, application
state, admission, orchestration, and native task execution. Desktop TypeScript
owns host/bridge and browser adapters. The permanent model route remains
`provider = farol`, `model = chatgpt`; current `AGENTS.md` owns the architectural
and verification rules. Frozen TypeScript application services must not be
reactivated as a second backend or used to bypass current model/host gates.

Owning source evidence, relative to the repository root at the baseline:

- `modules/task/app/services/task/control.go`: exact-dispatch Message/Continue.
- `modules/task/app/services/task/service.go`: complete intent comparison,
  same-operation replay, durable admission before effects, and sticky uncertainty.
- `modules/task/infra/repos/task/filesystem.go`: revision CAS, pending-operation
  exclusion, and finalization that cannot settle an uncertain receipt as success.
- `modules/task/infra/clients/codex/message.go`: exact active vendor turn and
  `expectedTurnId`, with no fallback to a new turn.
- `modules/task/infra/clients/codex/continue.go`: retained model/effort, exact
  completed parent, post-start history witness, and uncertainty after lost proof.
- `boot/taskprofile.go`: original Task owner and actual Chat parent rechecked at
  the provider write boundary.
- `src/pkg/owner-config/contract.ts` and `apps/desktop/task-current-settings.ts`:
  neutral configured aliases and qualified immutable settings selection.

These source mappings do not claim a new test pass, native durability proof,
installed feature, provider delivery, or whole-product acceptance.

## Unresolved capability differences

The owner-message prototype selects a native thread through an opaque,
conversation-scoped `selectionRef`, and distinguishes `steer-current` from
`native-queue`. Go MessageExact controls an existing owned Task dispatch;
`modules/task/infra/clients/codex/selectedthread.go` grants selected-thread reads
only. `modules/task/infra/clients/codex/proxy.go` does not admit
`thread/queue/add` or `thread/queue/list`. Therefore issued-task steering does
not close conversation-selected native-thread control or queueing. The archive
preserves that uncomposed proposal and its corrected claim-uncertainty fixtures;
it supplies no access adapter, queue qualification, or new authority.

The model-discovery candidate is also not fully equivalent to the Go route.
`modules/task/infra/clients/codex/catalogue.go` validates the exact model and
fresh bounded catalogue, but requires an effective effort to be bound before
qualification when that model advertises reasoning efforts. The old candidate
resolved an omitted effort from the advertised runtime default and retained it.
`modules/task/infra/clients/codex/client_test.go` explicitly covers refusal for
`omitted-effective-effort`. Preserve that current gate; do not copy the old
resolver into the client or guess a default. The legacy `codex_task_models`
yes/no/unknown display remains in
`src/modules/computer/infra/mcp/create-readonly-computer-mcp.ts`, whereas
`apps/desktop/bridge/task.ts` exposes no equivalent Go Task catalogue method.
These are source-evidenced capability differences, not regressions proved by
historical fixtures or permission to activate the legacy route.

## Historical reviews, proposals, and gates

The integration sequence pins an independent review to
`742487499577cf522cdc9279b7bceab51f8bf2da` and distinguishes its successor
`4f44f05c52efb09b95fcfed11795cb20658642c0`. Its review claims, estimated packets,
remaining gates, launcher/refusal history, Rust/helper preference, and statement
against a backend rewrite describe that older candidate. They do not replace
current Go ownership, current reviews, or current acceptance requirements.
The intermediate task-control document's role-profile configuration and
`product-settings.json` advice are superseded by current configuration.

The V0 fixture freezes baseline `eb146dc085277386f45c4e017fcfa60cb225001d`
and successor `f072ebbd79458e4c67ab595fc62d3696347fe55b`. Its missing/partial
rows are historical accounting, not today's product status. The checker only
accounts for the frozen inventory; its PASS cannot qualify source, packaging,
installation, or live use. The ledger discusses a handshake fix, but commit
`3c823c1b590a48baa31dcc5c8dd58109e81e96f8` contains no handshake source patch.
Current Go already negotiates `experimentalApi: true` in
`modules/task/infra/clients/codex/proxy.go`.

The execution contract remains a discussion-only RFC. Current `AGENTS.md` and
`docs/checkpoints.md` supersede its proposed checkpoint ordering. Its requirements
inventory and same-operation recovery scenarios remain archival design inputs,
not implemented interfaces, access grants, or a current defect list.

Any later implementation needs a fresh decision within the owning Go route and
its then-applicable source, aggregate, risk-review, native, package, and live gates.
Old PASS, failed, refused, or unknown receipts remain historical and cannot be
promoted, replayed, or transferred to newer bytes by this archive.

## Seven preserved branch pins

| Branch                                       | Exact preserved tip                        | Disposition                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/coordinator-execution-lanes-proposal` | `ce91353d5d1c7f114ca9f276cdd44cdfa86d2f08` | Archival proposal; checkpoint ordering superseded; no policy adoption.                                                                                  |
| `codex/coordinator-model-discovery`          | `4f44f05c52efb09b95fcfed11795cb20658642c0` | Configuration/refresh fixes retained; Go dispatch checks supersede TS; catalogue capability differences remain.                                         |
| `codex/coordinator-owner-message-hardening`  | `c3b0c7ea147aad7871d6bfc88ba5112889528348` | Hardened prototype and final sequence archived; issued-task safeguards superseded; conversation-selected queue remains uncomposed.                      |
| `codex/coordinator-parity-contract`          | `3c823c1b590a48baa31dcc5c8dd58109e81e96f8` | Exact historical inventory archived; accounting is not current parity or acceptance.                                                                    |
| `codex/coordinator-task-control`             | `2f1cbaccd008d6d04be1d299870d531acdee5e1e` | Six original patches separately disposed; obsolete profiles rejected, configuration retained, Go control supersedes TS; intermediate document archived. |
| `codex/owner-session-message-prototype`      | `f6efaba3bed7da6d26a6c1b7234872398e5f02e4` | Original prototype provenance retained; corrected snapshot archived once; arbitrary native-thread control/queue remains unresolved.                     |
| `codex/task-active-message`                  | `973dad807de31c26e3d850c07bd162fdd431c980` | Issued-task steer and safeguards superseded by Go; no old journal or unconditional registration restored.                                               |

Verification for this archival change is limited to direct Git-blob byte/SHA comparison,
map completeness, JSON parsing, scoped whitespace inspection, and changed-path
inspection. No tests, native execution, profiles, commits, or publication are run.
