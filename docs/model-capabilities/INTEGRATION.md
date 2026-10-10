# Deferred consumer composition requests

The MODELS branch changes only its domain, catalogue adapter and documentation
roots. It does not modify boot, shared contracts, generated wire, admission,
journals, authority or renderer shipping composition.

Published source dependency: `7212f92adf5fe851438458ed629fbb19fe06b7d8`, based on
`99aca15ffe16b435e59b19c20ff48e06bd56960d`. The equivalent local checkpoint is
`245270f6857ea34471521a08fc9968da574f49d5`; both have source tree
`6fd9d3ba637b86815510579a9683459bc2de71b3`. The branch is
`feature/model-capability-routing`. See `ACCEPTANCE.md` for the earlier checkpoint
mapping. Do not copy a private development registry into runtime.

## Narrow requests to the shared source owner

| Target at base                                 | Base Git blob                              | Requested integration                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot/chatstart.go`                            | `3abcb71e4945e6b6e07324d3c159cf3198d53707` | Inject a per-consumer catalogue lifetime and call `PrepareBrowser` where the current browser policy is selected; preserve existing Send/account/admission checks                            |
| `boot/readintentselection.go`                  | `0c7ccb66b1aec0e192db81e0e3a168a3a420aa1b` | Apply the same current/stale/account guard before a new read intent; retain the original immutable selection for already-created intent                                                     |
| `boot/taskprofile.go`                          | `ae68358fcd5df1a2dc8278f3eddc1730a601c60d` | Keep the captured model/account/epoch pin alongside the trusted `CodexTaskTurn` selection and its existing Authority delegate; compare exact runtime model and effort before initial intent |
| `modules/task/contracts/control/contract.go`   | `17394e5520bf9fba13f30d7c88d9379c17f14fa7` | Evaluate whether an additive account/epoch correlation field is needed after the actual Task consumer exists; no new authority or journal semantics                                         |
| New Chat model-selection contract, if required | Absent at base                             | Publish minimal independent DTOs only when two actual consumers need the seam; consumer peers must import that published contract, never Chat private domain/infra                          |

These are requests, not transferred ownership or accepted source changes. No
schema/renderer change is required for the current dormant implementation.

## INFERENCE and WORKFLOW owner mappings

The INFERENCE owner should implement its no-effect builder against
`catalogue.InferenceInput` semantics through a consumer-owned port. It must carry
the complete immutable pin into its own intent, reject route/billing/account
mismatch, and recheck account/authority immediately before the first request.
`catalogue.InferenceBuilder` is the current controlled seam. Add an actual service
composition test in the INFERENCE-owned root after that service is available.
No existing B0 inference service is claimed here.

The actual effect owner must preserve refused and outcome-unknown dispatch states
without retry or route/model/billing fallback. The MODELS no-effect preparer does
not dispatch and cannot establish that property for an uncomposed service. Budget
consumers must use `CaptureEstimate` and `CheckCurrentBudget` for their captured
input/selection and qualified interval; `CheckBudget` proves only numeric bounds.
The exact read-only comparison with INFERENCE commit
`e2824968b72fb891774a4cdda7f0beaa2c893842`, including field conversions and minimal
incompatibilities, is in `INFERENCE-MAPPING.md`. That owner retains the disposable
actual cross-feature witness; no INFERENCE source is imported into this branch.

The WORKFLOW owner should map its chosen resolved value into `TaskMapping`
semantics, keeping UI alias distinct from exact runtime model and explicit effort.
The existing Task facade composition test shows the actual Task `Resolve` path
consuming this mapping through controlled Authority/provider ports. It invokes no
mutation, journal admission, provider dispatch or native operation. The actual
workflow service and its published Chat peer remain separate integration work.

Controlled consumer tests are co-located in
`modules/chat/infra/catalogue/{cache,consumers}_test.go`. They exercise current,
stale and switched accounts, account change during browser/inference preparation,
exact request serialization, Task pin/alias preservation and provider refusal
without fallback. They do not advertise a shipping provider.

## Remaining gates

- Actual INFERENCE and WORKFLOW consumer composition against their own services.
- Shared-owner boot/account/authority composition and minimal published seam.
- Actual provider catalogue/entitlement and no-tools request qualification.
- Aggregate project gates, formal required review and Mac/native qualification.
- Non-force source branch publication is separate from promotion; no main, tag,
  release or activation is included.

Private packets, account evidence, tokens, request dumps and provider state are
excluded from source commits and exports.
