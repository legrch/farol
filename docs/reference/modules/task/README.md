# Persistent coding tasks

## Reference documents

- [Control contract](contracts/control.md)
- [Observation contract](contracts/observation.md)
- [Selected thread contract](contracts/selectedthread.md)
- [Configured model policy](contracts/modelpolicy.md)
- [Current Task settings comparison](contracts/currentsettings.md)
- [Saved current Task source](contracts/currentsource.md)
- [Claude client](infra/clients/claude.md)
- [Codex client](infra/clients/codex.md)
- [Parent Chat peer](infra/peer/parent.md)
- [Process peer](infra/peer/process.md)
- [Workflow runtime](infra/workflowruntime.md)

The optional trusted desktop launch pair `codexRead: { hostId: "codex",
trustedTemp }` reaches Go through `--codex-read-host` and `--codex-read-temp`.
Go validates the atomic pair and reuses the existing selected-thread reader,
authority and cleanup owner. Normal Electron startup leaves it unselected, so
this adapter wiring does not activate or qualify a Task tool. Native host,
account, packaged/installed advertisement and one-shot live-read acceptance
remain separate gates; saved source metadata does not select this route.

The pure configured-model decision is selected through Go on the desktop's
Task setup path; see the model-policy contract above. It opens no Task or
provider lifecycle. The lifecycle foundation below remains separate.

This is a root-compatible application-policy foundation based on accepted
K0/K1 `acb131d9e7d483296d4edac262cf881cddfb91bb`. The selected lifecycle owner
was prepared on source-only dependency `94c2beb1e81a08f7f36656d88fb4a59885ea5992`,
which is not an accepted main/runtime checkpoint. This Task lifecycle is not wired into the shipping
backend or MCP catalogue by the model-policy capability. No production filesystem journal, native provider
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

`infra/repos/task.Owner` is the concrete lifecycle/persistence publisher for one
selected coding task. It wraps the existing Task journal port and adds atomic
admission revoke through `port.AdmissionJournal.Invalidate`. The same selected
`Route` is injected into `app/services/task.NewOwned` and the published
`contracts/admission` controller. There is one owner per TaskID and backend/profile
lifetime; all writes for that task must pass through it. This is an owner of Task
state, with no Computer grant issuer or provider/process engine.

The trusted route binds owner/session/task/epoch/participant/Farol turn before
the create or follow-up intention. `SessionID` here is the Farol authority
session; Codex thread/turn and Claude session/invocation lineage are separate
facts. IDs in a caller request, backend generations and call IDs never issue
this selection. A follow-up requires a distinct trusted Farol turn and strictly
newer existing admission epoch in the same owner/session/participant scope.
This module validates that upstream identity; it does not generate an epoch or
grant. Cross-session migration is not implemented.

The owning service prepares `Task.Admission` in the existing aggregate. Journal
Admit atomically persists it with the complete intention and global operation
binding. A positive projection is published only after that new launch intention
has a known successful persistence acknowledgement. The provider effect has not
necessarily settled at this point: native execution during the provider turn
uses this admission, while the pending operation independently fences task
redispatch. Reads, replay, lookup, status and provider progress never issue a
positive projection. Old result identity remains retained during follow-up.
Terminal/needs-input/refused state closes admission; a cancellation request
revokes it without claiming provider termination. Unknown effect or persistence
acknowledgement closes the owner before returning uncertainty.

All journal writes fence inspection before IO. The state gate is released during
persistence; an unsettled write exposes unavailable. Completion and revoke
invalidate the publication token, so a later successful callback cannot restore
the previous positive binding. Revoke fences before waiting for an in-flight
writer and then atomically changes only the admission field, preserving pending
operation and provider/result evidence. A late Finish retains already durable
revoke. Old routes cannot revoke or publish a newer turn. A failed revoke
acknowledgement stays fenced and is not retried by this owner.

Construction/restart begins with no positive admission even when durable state
says active. Reconnect may read retained receipts/results but cannot restore
native authority or active steering. A known terminal observation can close
that retained state; a later properly selected follow-up can acquire admission
through a fresh settled intention. Active-task restart reconciliation requires
an accepted upstream authority/lifecycle decision and is not implemented here.
The existing unowned `New` constructor remains policy/retained-observation only
and cannot produce admission through the concrete selected journal. Zero
admission fields remain omitted from legacy intention fingerprints.

The callback path performs no journal/provider reads, native IO, polling or
Computer calls. Its value is copied under the owner gate and inspected once
synchronously. Missing/closed/revoked (`nil`) and unavailable (error) differ.
The contract copies DTOs and sanitizes owner failures; callback refusals are
preserved. Computer maps this published DTO in its consumer-owned `infra/peer`.
Ordinary Chat turns use the separate Chat owner contract. Lock order remains
Computer's qualified `AccessRepository.WithSnapshot` then Task `WithCurrent`.
Neither callback may reenter/mutate an owner. Task releases its gate before a
caller performs any separate Computer update; no Task-held path acquires
Computer.

`ExampleNewOwned` in `app/services/task/owner_test.go` is an executable composition
path: selected owner route -> Task service plus admission controller -> published
contract, false before launch / true during running / false after result. The
memory journal/provider in that example prove source policy only. Production
composition requires these explicit inputs from Core/Lead:

1. One exclusive qualified durable `AdmissionJournal` for the approved profile
   state. It must parse partial/corrupt data, enforce global operation binding and
   revision/reference CAS, preserve terminal results by dispatch, and atomically
   persist admission with intentions/receipts or revoke. Publication errors may
   follow durable writes and must remain unknown. Memory fixtures prove none of
   the filesystem ownership, mode, fsync, locking or crash-window obligations.
2. One owner per TaskID with trusted selections from the existing authority
   lifecycle; the same selected route for `NewOwned` and the admission contract.
   No alternate/raw journal writers, cache, latest-task lookup or request owner
   selection. Unknown/restart state needs explicit reconciliation before native
   authority is accepted. `Authority.Recheck` must qualify the same saved
   project/writer, physical roots, host/model binding and current upstream grant.
3. Computer's published-contract peer mapping and exact route/lease composition,
   with Computer calls only after Task gates are released. No production boot,
   shared schema or catalogue registration is added by this Task slice.

Provider progress uses a separate gate where lineage persistence is expected.
Record callbacks are serialized, their first failure is sticky, and completion
joins the gate and seals it before app policy reads lineage. Late callbacks cannot
write lineage. Providers still must join every callback before Dispatch returns;
the gate is not evidence that a provider/process has terminated. A persistence
acknowledgement loss or a refused receipt after lineage keeps the durable unknown
fence, even when a provider ignores its callback error.

## Provider adapter ownership

`app/port.CodexClient` fixes the selected existing server seam for Create,
Continue, Message, Cancel and Observe. `app/port.ClaudeHost` fixes Create,
exact-session Resume, supported Cancel and Observe through the accepted owning
native-process seam. Both receive the retained provider/project/writer/model/
effort/config binding and stable operation ID in the existing Task dispatch DTO.
Partial lineage and exact known/refused/unknown receipts use existing types.
All progress callbacks must join before return; callbacks are not process exit
or cleanup evidence. Supports reports qualified selected-host capabilities,
including false for unsupported controls; versions/help are insufficient.

Bounded adapter writers may own `infra/clients/codex/**` and
`infra/clients/claude/**` separately after this shared port checkpoint is accepted.
They implement `port.Provider` against their injected client/host and do not
modify the common service, journal, intent, admission owner or shared schema.
The Codex seam requires the selected already-running server, saved-project/model
catalogue, approval handling and exact thread/turn correlation. The Claude seam
requires accepted exact-session/invocation process ownership, startup/init/final
and terminal exit/cleanup evidence; resume remains distinct from steering.
Providing these ports does not qualify either host or authorize a second daemon,
live inference, background session copy, alternate auth/HOME/model or retry.

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

| Evidence                                  | Cases / limit                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure domain                               | Provider distinction, exact lineage extension, terminal/approval-blocked/unknown control policy                                                                                                                |
| Fake provider + atomic memory journal     | Bound create/replay, settings drift, concurrent claim, admission/provider/finish ACK loss, exact follow-up, unsupported control, cancellation requested vs terminal, revocation, result persistence loss       |
| Progress infra + admission owner/contract | Callback serialization/sealing, settled launch publication, no-IO gate, blocked write/revoke, stale finish, exact follow-up selection, authority/ACK loss, restart/reconnect nonactivation; memory-only policy |
| Parent delivery                           | Completion alone does not send; exact parent, lost ACK, reconnect, different-key duplicate refusal                                                                                                             |
| Real journal/native provider              | Not run; memory fixtures do not prove fsync, private file constraints, process cleanup, native session persistence or host capabilities                                                                        |
| Packaged/installed workflow               | Not run; no catalogue restoration or live acceptance is claimed                                                                                                                                                |

Remaining Lead seams: production durable backing/boot for the concrete Task
lifecycle owner and Computer peer/route composition; Computer authority/recheck
and process ownership contracts; one durable task
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
constructor/serialization and publishes a new contract; the subsequent owner
checkpoint changes admission persistence and revocation; that old result does not
approve these bytes. New independent provider/Critic runs are fenced pending
the Lead's accepted review/resource decision. Self-review is not panel acceptance.
