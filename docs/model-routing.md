# Farol provider and model identity

Status: accepted naming and extension contract. The implementation currently serves
one ChatGPT route. Default-resolution policy below is a requirement for the pending
public model-selection/Send integration, not a claim that live selection is complete.

## Wire identity, not development generation

Codex configuration has independent provider and model fields:

```toml
model_provider = "farol"
model = "chatgpt"
```

App Server uses the equivalent `modelProvider: "farol"` and `model: "chatgpt"`.
The provider table is `model_providers.farol`. Farol receives the provider-local
`model` in a Responses request; that request body does not need another provider
selector. The endpoint and authenticated connection already select Farol.

`farol/chatgpt` is a derived display name (`provider/model`), never the wire model.
A slash is not interpreted as an instruction to switch providers. Supplying
`model: "farol/chatgpt"`, the former `farol-next/chatgpt`, or an unregistered model
to the current production route is a refusal before a model operation, not an alias
rewrite. Whitespace, case and punctuation are not silently normalized.

The canonical constants, provider-local name schema and exact current catalogue
live in `src/pkg/model-route/contract.ts`. The ordinary generated Codex config,
app-owned host launch, route evidence, parent/child checks and endpoint use the same
identity. A model catalogue label is not proof of the upstream execution model.

Only `chatgpt` is advertised by the production route today. No DeepSeek, Kimi,
version pin or additional effort is enabled merely by adding syntax for a name.
The low-level continuity test composition still accepts its two exact historical
Mind/Drive fixture IDs as distinct configured fixtures; neither is offered by the
production catalogue, nor treated as a spelling of `chatgpt`.

## Default aliases and explicit pins

`chatgpt` is a **floating default alias**, not a fixed version pin. It requests the
latest qualified default supported by the ChatGPT adapter and available to the
current account for the requested capabilities. "Latest" must not be computed by
lexically sorting labels, guessed from an API catalogue, or inferred from whatever
happens to be selected in an unrelated browser conversation.

A future explicit pin has an independently registered provider-local name, such as
`chatgpt-gpt-5.5`. This is a naming example, not an availability assertion. A pin's
meaning does not drift when a newer model ships. If its required selection is no
longer available, return a specific unavailable result; do not substitute the
default or another provider. Adding a pin must not rename or change the semantics
of the existing `chatgpt` alias.

The same rule can be used by a future upstream: `deepseek` for its qualified default
and `deepseek-<explicit-target>` for a pin. These are extension examples, not
implemented integrations. Register each complete ID explicitly. Never select an
adapter by splitting the ID at the first hyphen or using `startsWith("chatgpt")`:
that would silently turn a misspelled pin into the default route.

Provider-local IDs use lowercase ASCII letters/digits with dot or hyphen separators,
start with a letter and are bounded to 128 characters. A syntactically valid name
is not necessarily available. The exact catalogue, not the name grammar, decides
availability. An adapter must separately prove its transport, tool, context,
streaming and cancellation capabilities before its entries can be offered.

## Resolution lifetime

Resolve a floating alias for a new logical task, not on every network round trip.
Record requested alias, resolution policy/revision, the independently observed
upstream model and supported effort, account/profile identity without credentials,
and the task/conversation/build binding. Unknown observations stay unknown.

Before Send, the supported public controls must prove that the requested selection
is effective in the same document. The existing pure model-observation validator
is not itself that browser proof. Navigation, same-URL reload or a changed selection
invalidates old observations. Capture/validation and the actual send require the
existing atomic submission boundary; a previous successful check is not a reusable
permission to send after another asynchronous operation.

A continuing task keeps its resolved selection through tool rounds, recovery and
compaction. Upgrading the default alias affects new tasks. Changing an active task's
upstream model is an explicit transition, not an incidental effect of a catalogue
refresh. A provider retiring the bound model may make continuation unavailable; do
not pretend a stable ID can guarantee upstream availability.

A default child inherits the parent's virtual route **and resolved selection**.
Codex's inheritance of the provider-local alias alone does not prove that two
separate ChatGPT conversations selected the same upstream model. Farol must carry
and verify the resolved binding when it creates the child's conversation. It may
narrow the child's permissions, but naming or model selection never widens them.

This naming migration implements the permanent wire identity and exact alias
catalogue. Persistent resolution at this lifetime and public-control selection are
still part of model/Send integration; do not enable a green live-model badge from
this document or the catalogue's `latest-qualified` descriptor.

## Three separate identities

**Transport:** `provider=farol`, `model=chatgpt` identify the host transport and
requested virtual route.

**Execution:** observed upstream model/effort identify what the owning ChatGPT
conversation actually selected.

**Summary:** checkpoint summarizer provenance identifies the engine that produced
a validated continuity summary.

A `chatgpt` route is not an observed GPT version. A selected host effort is not proof
of the browser's effective effort. A Luna-generated summary does not switch the
execution route to Luna and must not claim to be a current-ChatGPT summary.

Keep effort separate from the model ID. Expose only qualified combinations in the
catalogue. Current `low` is the bounded host transport-check capability; it is not a
claim that all ChatGPT effort modes are wired. Names such as Instant or Pro are not
automatically interchangeable with the host's reasoning-effort enum. Capability
mapping belongs to the adapter and requires actual supported selection evidence.

## Native child routing

The parent starts with the explicit Farol provider-local route and with provider
fallback disabled. For the qualified installed-host path, native child creation
omits `model` and `reasoning_effort` overrides and sets `fork_context=false` with
the exact bounded child prompt. Overrides use a separate built-in model catalogue;
they must not be used to force a custom route by guessing a built-in replacement.

Verify actual parent/child linkage, retained provider/model and each observed
provider request. Child-result delivery, TaskGrant enforcement, cancellation and
same-child recovery remain independent checks. A successful synthetic child is not
full Product Agent or live ChatGPT acceptance. Advertised `skills.list/read` are
not granted solely because the catalogue contains them.

## Compatibility and isolation

The former public pair was `farol_next` / `farol-next/chatgpt`. New tasks use only
`farol` / `chatgpt`. Stored checkpoints and historical receipts keep their original
binding and provenance. Reading old data must not rewrite it or make it count as
proof for the new route. Tests cover both explicit checkpoint replay and markerless
recovery after restart, including the old neutral route with the same `chatgpt`
mode suffix.

A new build cannot silently resume a saved old-route task under the new identity.
The host continuation adapter reads only retained route metadata before
`turn/start`, requires the exact provider/model/thread, and still checks retained
results after completion. This is a configured-route check, not upstream telemetry.
Keep the old task inspectable; finish it with compatible owned bytes, or perform a
separately verified explicit context transition. Never repeat an unknown operation
or replace a child to get past an identity mismatch.

Generated managed config uses separate canonical fields. Existing managed blocks
can be previewed and explicitly applied through the existing consented config
workflow; this migration does not edit a personal Codex config or restart the
owner's host. Foreign `model_providers.farol` entries remain conflicts, not targets
for overwrite. Preserve unrelated bytes, backups, independent selection consent
and rollback. Existing shared marker/version formats are not reinterpreted.

Development coexistence is a different concern. `vnext/`, Preview/Dev application
IDs, browser partitions, state directories, temporary process names and private
`FAROL_NEXT_*` environment variables remain isolated from Legacy. Existing MCP
tool names and opaque call/receipt prefixes are not model IDs; their compatibility
is unchanged by this provider migration. A tested product cutover owns their later
migration. The final product brand and all new protocol names are Farol.

## Verification boundary

The naming change must preserve same-turn incremental status/commentary/answer
output, tool-result continuation, checkpoint ownership, exact provider/model
refusals and inherited child routing. Run canonical-name real-host synthetic
fixtures as well as deterministic tests. Preserve evidence class and exact source
identity: neither a syntax test nor a synthetic provider qualifies live browser
selection or proves a newer upstream default is available.

The host contract is described in the primary documentation:

- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex App Server](https://developers.openai.com/codex/app-server)

These references describe the host fields, not Farol's floating-alias policy or a
promise that every host version supports the same native child overrides.
