# Provider and model identity

**State:** accepted naming/extension contract. The desktop's Farol model-provider
route and Farol-backed Product Agent remain disabled in
[feature gates](../src/apps/desktop/foundation-feature-gates.ts). This reference is
not an instruction to enable them. Ordinary Computer is independent of these gates.

## Permanent wire identity

The intended Codex configuration has separate provider/model fields:

```toml
model_provider = "farol"
model = "chatgpt"
```

App Server equivalents are `modelProvider: "farol"` and `model: "chatgpt"`.
The provider table is `model_providers.farol`. The selected endpoint/connection owns
the transport; a Responses request carries the provider-local model name.

`farol/chatgpt` is display notation only. A slash-qualified `model`, obsolete
`farol-next/chatgpt`, unknown entry, or altered spelling is refused, without implicit
provider selection or normalization.

[Canonical constants and catalogue](../src/pkg/model-route/contract.ts) register only
`chatgpt`. Naming support does not qualify an upstream model, account entitlement,
effort, or enabled product endpoint.

## Default alias and future pins

`chatgpt` is an accepted floating-default alias: the latest qualified ChatGPT default
available to that account for the required capabilities. It is not a GPT version.
Effective public browser selection and persistent resolution remain pending
integration requirements, not guarantees supplied by the catalogue.

A future explicit pin such as `chatgpt-<explicit-target>` must be independently
registered with stable semantics. An unavailable pin refuses rather than substituting
the default. Other upstream names are extension examples until their complete
transport/tool/context/stream/cancellation capabilities are qualified.

Names use bounded lowercase ASCII letters/digits with dot/hyphen separators and
start with a letter. Syntax alone cannot select an adapter. Never dispatch by prefix
or by splitting an ID: that could turn a misspelled pin into another route.

## Resolution lifetime

The accepted target resolves a floating alias once for a new logical task, then
retains requested alias, resolution policy, observed upstream model/effort, profile,
and task/conversation/build binding. Unknown observations remain unknown.

Supported public controls must prove the effective selection in the same document
immediately at the submission boundary. Navigation, reload, selection change, or a
newer pending readiness observation invalidates earlier proof. A pure observation
validator is not browser selection evidence.

A continuing task keeps its binding across tool rounds, restart, and compaction.
Default upgrades affect new tasks. A child inherits both virtual route and resolved
selection; alias inheritance alone cannot prove two browser conversations selected
the same upstream model. Model selection never enlarges authority.

## Keep identities separate

| Identity  | Describes                                                                   |
| --------- | --------------------------------------------------------------------------- |
| Transport | `farol` / `chatgpt`, the requested virtual route                            |
| Execution | Independently observed upstream model and effort in the owning conversation |
| Summary   | Provenance of a validated continuity checkpoint's summarizer                |

A transport name is not GPT-version telemetry. A host effort is not effective
ChatGPT UI effort. A summarizer does not change the task's execution model.
Current low-effort host checks are bounded transport checks; they do not qualify all
Instant/Pro/effort combinations.

## Native children and compatibility

The qualified synthetic host path starts the parent with explicit route and provider
fallback disabled. A default native child omits built-in model/effort overrides and
uses its bounded prompt with `fork_context=false`. Exact parent/child linkage,
retained provider/model, request observations, TaskGrant enforcement, cancellation,
and delivery each need their own proof. A synthetic child does not enable Product Agent.

Old `farol_next` / `farol-next/chatgpt` checkpoints and receipts keep their original
binding/provenance. Reading them does not rewrite or promote them into current-route
acceptance. A new build refuses silent continuation under a different route; preserve
inspectable old work and use a separately verified explicit context transition.

Managed config changes require their existing explicit selection/apply workflow.
Foreign provider entries remain conflicts, and unrelated personal config is preserved.
The naming contract does not restart a host or authorize a config edit by itself.
App/profile/partition/process/receipt compatibility names remain a separate concern.

## Adapter and task-model references

[Browser adapter](browser-adapter.md) covers public DOM parsing, readiness ordering,
and fixture transport evidence. [Task configuration](config-model-discovery.md)
covers model discovery from a separately selected native Codex host; that is a
different route from Farol's ChatGPT virtual provider.

The local source/tests own Farol's policy. Host schema compatibility must be checked
against the selected installed executable; a newer external API reference cannot
qualify an older serving runtime. See [Desktop/Core](desktop-core.md) for the separate
Go transport and [status](status.md) for enabled capability boundaries.

---

[Documentation index](README.md) · [Project overview](../README.md)
