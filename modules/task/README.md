# Persistent coding tasks

This is a pre-K0 application-policy slice. It is not wired into the shipping
backend or MCP catalogue. No production filesystem journal, native provider
transport, authority issuer or parent messenger is implemented by this slice.

`domain` owns coding-task identity and lifecycle. `app/services/task` owns
resolve, create, observation/result retention, supported control and parent
delivery. Consumer-owned ports are in `app/port`. Chat model turns and browser
slots remain outside this module. No nested Go module or private transport is
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

Before K0, run `sh modules/task/verify.sh`. It copies only this module into a
fresh disposable compile fixture with the recommended module path and runs
`go test -race` and `go vet` offline. It creates no repository module/protocol.
After K0 accepts the actual root module/toolchain, use the root Go suite and
retire this temporary scaffold. The existing nested native Go suite remains
separately required during migration.

| Evidence                              | Cases / limit                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure domain                           | Provider distinction, exact lineage extension, terminal/approval-blocked/unknown control policy                                                                                                          |
| Fake provider + atomic memory journal | Bound create/replay, settings drift, concurrent claim, admission/provider/finish ACK loss, exact follow-up, unsupported control, cancellation requested vs terminal, revocation, result persistence loss |
| Parent delivery                       | Completion alone does not send; exact parent, lost ACK, reconnect, different-key duplicate refusal                                                                                                       |
| Real journal/native provider          | Not run; memory fixtures do not prove fsync, private file constraints, process cleanup, native session persistence or host capabilities                                                                  |
| Packaged/installed workflow           | Not run; no catalogue restoration or live acceptance is claimed                                                                                                                                          |

Required K0/Lead seams: accepted root module and per-module constructor shape;
Computer authority/recheck and process ownership contracts; one durable task
journal adapter with typed partial/corrupt state and result retention; supported
Codex connection to the selected existing server; exact persistent Claude
process adapter; Task-only generated/MCP DTO mapping and production registration;
exact initiating-parent delivery route. Shared root/boot/schema/registration
files remain with their named owners.

Final acceptance is one bounded Codex task and one bounded Claude task, each
with a real Farol follow-up, plus independent parent delivery and lost-ACK
reconnect checks. Those are pending an integrated accepted backend and its
production owner; fake PASS cannot replace them.
