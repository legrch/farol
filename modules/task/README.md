# Persistent coding tasks

This is a root-compatible application-policy foundation based on accepted
K0/K1 `acb131d9e7d483296d4edac262cf881cddfb91bb`. It is not wired into the shipping
backend or MCP catalogue. No production filesystem journal, native provider
transport, authority issuer or parent messenger is implemented by this slice.

`domain` owns coding-task identity and lifecycle. `app/services/task` owns
resolve, create, observation/result retention, supported control and parent
delivery. Consumer-owned ports are in `app/port`. `infra/clients/provider` owns one
serialization gate per dispatch; `infra/intent` supplies the unchanged SHA-256
intention fingerprint. Trusted composition must inject both. These adapters
perform no provider calls and own no cross-operation singleton state. Chat
model turns and browser slots remain outside this module. No nested Go module or private transport is
introduced.

## Identity and effects

A task binds the selected provider host/profile, saved project and physical
canonical/writer roots, configured model alias, actual model/effort and settings
digest. Those values come from the authority/catalogue adapter. The request
cannot fabricate them. Later settings changes do not reinterpret a dispatch.
Claude's project identity must be supplied honestly by that adapter; it is not
claimed to be a Codex saved-project registry.

An operation binds its task, action, parent thread/turn, expected provider
reference and message fingerprint before one effect call. The journal must
atomically serialize task revisions and global operation IDs. Prompt content is
not stored in the intention. Unknown admission/effect/publication keeps a fence;
reconnect reads the existing operation through a separate `Operation` query. A new key cannot create the same task or
bypass an unresolved control/delivery. Partial lineage is retained independently
of a final effect acknowledgement and is readable through the operation query;
it never means completion. A refused receipt after recorded progress is
contradictory and keeps the operation fenced as unknown.

Codex continuation requires the same thread and a distinct turn. Active steering
requires the exact issued turn. Cancellation acknowledgement means requested;
only observation may confirm a terminal provider state. Claude resume requires
the exact session and a distinct Farol-owned process invocation, and cannot act on a running or
approval-blocked session. Capability flags are selected-host evidence, never
inferred from provider names. This service neither changes permission policy nor
implements approvals. A provider refusal cannot switch the selected executor.

A terminal result is retained by dispatch before the latest task view advances.
Sending it to the initiating parent is a separate durable operation. Parent
thread/turn IDs require trusted initiating-chat authority before creation and
again before delivery; an arbitrary caller-selected chat ID grants no access. A lost
parent acknowledgement keeps uncertainty without resending. A successful or
refused parent delivery cannot be repeated under a different operation ID for
the same dispatch.

## Selected current-task admission

`contracts/admission` publishes a narrow synchronous inspection surface for an
already admitted coding task. It delegates through `app/capabilities/admission`
to the selected existing lifecycle owner. There is no Task grant engine,
positive admission cache, native execution route or production owner in this
checkpoint. The owner port is an explicit integration prerequisite.

Trusted composition selects the owner and exact immutable owner/session/task/
epoch/participant/turn binding before native execution. `SessionID` here is the
Farol authority session; Codex thread/turn and Claude session/invocation lineage
are distinct facts. Caller request IDs, backend generation and call IDs provide
correlation only. New turns need a fresh trusted selection after the existing
owner settles its lifecycle transition; a request cannot remint admission.

The Computer consumer must adapt this published DTO from `infra/peer`; Task
imports no Computer internals. Ordinary Chat turns require the Chat owner's
contract and route selection, not this delegated coding-task contract. Computer
must never select an ambient latest task or use provider progress as permission.
The callback API is an internal owner inspection, not another wire schema.

Lock order is Computer's qualified `AccessRepository.WithSnapshot`, then this
owner's `WithCurrent`. WithCurrent entry and callback perform no IO, journal or
provider reads, polling, native measurements, mutation or reentrancy. Task-held
paths cannot acquire Computer. Completion/revoke invalidates admission under the
existing owner gate and releases it before a separate Computer update. An
unsettled durable transition must fence positive admission before possible
effects and throughout restart reconciliation; memory fixtures do not prove that
production obligation. Missing/revoked (`nil`) and unavailable (error) differ.
The contract copies values and sanitizes owner errors; consumer callback refusals
are preserved. No durable Journal adapter or boot registration is added here.

Provider progress uses a separate gate where lineage persistence is expected.
Record callbacks are serialized, their first failure is sticky, and completion
joins the gate and seals it before app policy reads lineage. Late callbacks cannot
write lineage. Providers still must join every callback before Dispatch returns;
the gate is not evidence that a provider/process has terminated. A persistence
acknowledgement loss or a refused receipt after lineage keeps the durable unknown
fence, even when a provider ignores its callback error.

## Existing source and catalogue inventory

At base `1eb30bd23df22c9581d277280f8e0699612786b5`:

| Existing owner / operation                           | Source behavior                                                                                                               | Production qualification / export                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PersistentCodexHandoff.create/status/result`        | Saved project, physical writer, immutable model binding, exact thread/turn/final item; durable one-shot intents               | Computer MCP exports when an admitted route exists; fixture/source evidence is not live proof                    |
| `PersistentCodexHandoff.message/continue/title`      | Exact active steer; same-thread follow-up; title CAS; independent intents                                                     | `AdmittedCodexTaskRoute` defaults control capabilities to false; tools are absent                                |
| Project resolve/preference/discovery/adoption        | Canonical root differs from writer; missing/ambiguous/partial remain distinct; preferences and adoption grant no control      | Discovery needs a separate grant; normal desktop issuer omits it; selected-thread observe/adopt remain read-only |
| `PersistentClaudeHandoff.create/status`              | Exact session, startup/init/final parsing, process exit and cleanup, recorded terminal, needs-input                           | Fixture-only grant; desktop issues no Claude grant; no separate result/resume/active control tool                |
| `RunAgentAssignment` / `recordSpawnLineage` / rejoin | Staged parent thread/turn/child lineage, same-assignment correlation, retained delegation and separate parent acknowledgement | Independent Agent host; no saved-project binding; production start/rejoin gate is false                          |
| `ensureCodexProject`                                 | Foundation and private journal exist                                                                                          | No production consumer/registration; not an exported capability                                                  |

Retain the existing physical-authority, catalogue completeness, deadline/revoke,
full bounded Codex final-item scan, read-only adoption, journal crash-window,
Claude startup/init/final plus exit/cleanup, and Agent correlation cases when
adapters migrate. The current tests do not qualify these adapter behaviors.
Do not discard old unresolved journals or invoke the old executor as fallback.
The old narrowly proven no-effect refusal/CAS behavior is inventoried above;
this conservative slice does not automatically retry it.

## Installed capability inspection

Read-only inspection on 2026-10-02 found Codex CLI `0.160.0` and Claude Code
`2.1.287`. Only version/help and Codex's offline schema generator ran. No second
App Server, provider inference, auth/session database read or background session
operation ran.

The generated Codex schema requires `expectedTurnId` for `turn/steer`,
`threadId`/`turnId` for `turn/interrupt`, and offers `thread/start`,
`thread/resume`, `thread/read` and `turn/start`. Effort is a nonempty string
validated against the serving model catalogue, not a fixed UI effort enum.
Schema availability does not qualify the selected running server, saved-project
binding, owner approval handling or production grants. See the official
[App Server contract](https://developers.openai.com/codex/app-server/).

Installed Claude help offers `--session-id`, exact `--resume`, persistent print
JSON/stream output and effort values `low`, `medium`, `high`, `xhigh`, `max`.
Background resume can create a copy when a session is already running; this
slice does not select that route. Print resume is not active steering. The
installed permission-mode choices also differ from the old fixture invocation;
retain that incompatibility as a qualification item. No `--bare`, alternate
HOME, credential copying, fallback model or latest-session lookup is selected.
See the official [headless contract](https://code.claude.com/docs/en/headless)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Verification and integration

The pre-K0 disposable module scaffold is retired. The existing
`sh modules/task/verify.sh` entrypoint now verifies Task packages against the
accepted root module without copying source or creating another module. Keeping
the tracked entrypoint also lets the current precommit source-identity gate
inspect the still-uncommitted retirement. Root checks are:

```sh
go test -race ./modules/task/...
go test -race ./...
go vet ./...
node tooling/check-go-architecture.mjs
```

`task test:core` and the full CI lane remain integration gates. Run the nested
`resources/native/go` suite separately if that transitional module exists in the
accepted integration tree; it is absent at this checkpoint's base. Full CI/native
GUI/package runs require the canonical Lead slot. Targeted Go checks do not
qualify provider CLI/process behavior or replace full CI.

| Evidence                              | Cases / limit                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure domain                           | Provider distinction, exact lineage extension, terminal/approval-blocked/unknown control policy                                                                                                          |
| Fake provider + atomic memory journal | Bound create/replay, settings drift, concurrent claim, admission/provider/finish ACK loss, exact follow-up, unsupported control, cancellation requested vs terminal, revocation, result persistence loss |
| Progress infra + admission contract   | Concurrent callback serialization, sticky publication failure, completion sealing, exact selected binding, absent vs unavailable, owner-gated revocation; no durable/native admission proof              |
| Parent delivery                       | Completion alone does not send; exact parent, lost ACK, reconnect, different-key duplicate refusal                                                                                                       |
| Real journal/native provider          | Not run; memory fixtures do not prove fsync, private file constraints, process cleanup, native session persistence or host capabilities                                                                  |
| Packaged/installed workflow           | Not run; no catalogue restoration or live acceptance is claimed                                                                                                                                          |

Remaining Lead seams: concrete admitted Task lifecycle owner and the Computer
peer/route composition; Computer authority/recheck and process ownership contracts; one durable task
journal adapter with typed partial/corrupt state and result retention; supported
Codex connection to the selected existing server; exact persistent Claude
process adapter; Task-only generated/MCP DTO mapping and production registration;
exact initiating-parent delivery route. Shared root/boot/schema/registration
files remain with their named owners.

Final acceptance is one bounded Codex task and one bounded Claude task, each
with a real Farol follow-up, plus independent parent delivery and lost-ACK
reconnect checks. Those are pending an integrated accepted backend and its
production owner; fake PASS cannot replace them.

### Review coverage

The two preparation commits are carried without other historical release work:
`53a5c1b` -> `e383837`, `e0addf2` -> `6b700b4`. The original P2 correction retains
uncertainty after recorded lineage. Its prior R3 delta review returned
`INSUFFICIENT_EVIDENCE`; the original finding was assessed resolved, but durable
Journal/downstream coverage remained insufficient. This checkpoint changes
constructor/serialization and publishes a new contract; that old result does not
approve these bytes. New independent provider/Critic runs are fenced pending
the Lead's accepted review/resource decision. Self-review is not panel acceptance.
