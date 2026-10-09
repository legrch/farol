# Root coding-task control facade (source candidate)

`New` accepts the actual existing `*task.Service` and retains it. Trusted Root
composition supplies the SAME `NewOwned` service and selected `Owner/Route` used
by admission and retained observation, with its real journal, authority and
selected Codex/Claude Provider adapters. This constructor performs no IO and
does not validate or manufacture those native/runtime prerequisites.

Public DTOs are independently owned here, with explicit conversions. No domain,
app or port type is aliased in the consumer interface. Root owns canonical wire
schema, serialization, normal entrypoints, MCP catalogue and provider binding.
This package creates no state engine, journal, provider loop, polling loop,
executor, model registry, Chat Turn or browser slot.

## Mapping

| Root operation      | Existing service/contract               | Semantics                                                                                                              |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Resolve             | Service.Resolve                         | Selected binding and exact declared capabilities; no provider execution.                                               |
| Create              | Service.Create                          | Existing durable intent-before-effect, exact selection, parent and same-key replay.                                    |
| Status              | Service.Status                          | May observe the exact known running provider and persist through the same owner; default DTO excludes result text.     |
| Result              | Service.Result                          | Same observation semantics, latest dispatch result and retention flag.                                                 |
| Continue            | Service.Control(Continue)               | Codex same thread, distinct turn, settled predecessor and fresh trusted admission route.                               |
| Resume              | Service.Control(Resume)                 | Claude exact session, new Farol invocation, settled predecessor and fresh trusted admission route; never active input. |
| Message             | Service.Control(Message)                | Only declared active-input capability and exact current issued reference.                                              |
| MessageExact        | Service.MessageExact                    | Existing active dispatch guarded in the original snapshot/journal CAS and replay fingerprint; no new turn or epoch.    |
| Cancel              | Service.Control(Cancel)                 | Only declared capability; requested ACK stays separate from terminal cleanup.                                          |
| Operation/reconnect | Service.Operation                       | Retained exact operation/lineage/receipt; no provider calls or replay effects.                                         |
| Observe metadata    | existing observation.Contract.Read      | Bounded retained events/result/delivery facts on the SAME service; no parallel facade here.                            |
| Admission           | existing admission.Contract.WithCurrent | Synchronous selected owner gate; no admission inferred from DTO values.                                                |

Continue/Resume/Message accept only task/operation IDs and message. They cannot
replace roots, provider/profile/model/effort, lineage or native handle. False
capabilities stay explicit; unsupported operations return
`TASK_CAPABILITY_UNAVAILABLE`. A provider name never supplies capability proof.
Codex thread/turn and Claude session/invocation are independent exact values.
Task InvocationID is not a Computer native process handle. Selected/resolved
Binding.Model is not observed/verified provider model evidence.

Facade construction/reconstruction leaves durable unknown, admission and
retained results with their owner. An unknown mutation remains fenced; reconnect
reads its original operation. A new key/model/provider cannot bypass it. Status
and Result do not observe a pending unknown invocation. Parent delivery remains
the separately admitted existing owner/service operation; no automatic send or
ACK is introduced. Status.DeliveryDispatchID is the dispatch marker stored by
that owner, not a delivery operation ID. A refused delivery also has this marker;
read the separate exact operation receipt/observation facts for parent ACK. Public errors are classified labels without private details;
non-classified provider receipt codes become `TASK_PROVIDER_REPORTED` with their
receipt state preserved.

## Source tests and limits

Tests compose this facade around the shipping `Service.NewOwned`, shipping
`infra/repos/task.Owner/Route`, real progress gate/fingerprint and the same
admission controller. Only the backing journal, selected authority and provider
boundary are scripted. Strict provider scripts check exact binding, operation,
parent, message, expected same-session reference and active admission. They do
not qualify actual Codex App Server or ClaudeHost capabilities, native CLI,
filesystem durability, process cleanup or installed production.

Existing observation source is already composed by Lead from the frozen O3/O5
packet. The control source compiles on exact base601 without copying or editing
that packet. Root must instantiate observation.New on this same service. Final
normal-root/cross-language/provider journeys remain separate acceptance work.
Full CI/race/native/live and commit remain held. No new test command is adopted.
