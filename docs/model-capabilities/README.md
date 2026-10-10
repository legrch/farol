# Account-scoped model capabilities

Implementation base: `99aca15ffe16b435e59b19c20ff48e06bd56960d`.
Published code checkpoint: `7212f92adf5fe851438458ed629fbb19fe06b7d8`.
Equivalent local checkpoint: `245270f6857ea34471521a08fc9968da574f49d5`.
Exact source tree: `6fd9d3ba637b86815510579a9683459bc2de71b3`.
Publication preserves B0 ancestry and equal source trees; the supported connector
generates new commit identities. See [acceptance evidence](ACCEPTANCE.md).

This additive source feature has no shipping registration, token access, account
discovery, live provider calls, global configuration migration or native changes.
It uses the existing browser model-selection application and existing Task
resolution facade in controlled composition tests. Its inference builder is a
controlled consumer port; integration with an actual inference service is pending.

## Packages and boundaries

| Package | Implemented behavior                                                                                                                                                         | Evidence limit                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| M1      | Bounded SIWC and App Server parsing; account-correlated injected transport; complete-list publication                                                                        | Declared protocol fixtures; no live provider shape qualification               |
| M2      | Account/route/epoch/expiry projection; discovered, selected, compatible, unsupported, unavailable and revoked states                                                         | Entitlement always remains untested                                            |
| M3      | Detached immutable route/account/model/effort/catalogue/capability pin                                                                                                       | Correlation, never a workspace or account grant                                |
| M4      | Explicit choice before ordered preferences; advertised effort validation; exact billing route                                                                                | Preferences apply before dispatch only                                         |
| M5      | Reported usage and source/version-labelled optional estimates; unknown versus zero; supplied budget limits                                                                   | No invented prices, reset-credit conversion or billing assertion               |
| M6      | Account switches, A-B-A races, latest refresh, reused ticket, malformed/partial lists, missing network, cancellation, stale/disappearing models and unsupported requirements | CPU/race evidence only                                                         |
| M7      | Browser application mapping, Task-facing exact model mapping, controlled inference request preparation                                                                       | Actual inference/workflow service integration and shipping boot remain pending |

The production domain is `modules/chat/domain/modelselection`. It has no host IO,
ambient clock, timer, network, private registry or mutable shared singleton. Time
and product capability evidence are supplied explicitly. `Resolved.Pin()` returns
scalar values; modifying a returned value cannot retarget the original operation.

`modules/chat/infra/catalogue` consumes an injected transport. SIWC uses the
declared `models` envelope with `slug`, `display_name`, and `visibility` (`list` or
`hide`). Optional reasoning levels/defaults use the existing product provider
representation. Omitted metadata stays omitted. App Server uses bounded
`model/list` pages and keeps its runtime `model` separate from the UI `id`.
An empty App Server display label renders its exact runtime name. App Server rows
cannot substitute for an account-specific SIWC catalogue.

The parser rejects duplicate JSON keys, duplicate model names/IDs, invalid effort
defaults, trailing values and excessive nesting/strings/response sizes. Unknown
fields are tolerated only inside the same bounds. The reader publishes no partial
list and never includes raw transport errors in classified failures.

## Consumer use

Each consumer gets its own `Cache`. `Activate(scope)` invalidates pending work,
including switching A to B and back to A. `Begin()` produces one opaque refresh
ticket. The reader's `Stamp.Epoch` must equal that ticket's epoch. `Complete`
accepts only its own latest ticket, once. A partial refresh is rejected. Failure
makes current availability unknown;
late older responses do not restore it. Snapshot input/output slices are detached.

Raw catalogue capabilities are unknown. `WithEvidence` accepts separately supplied
product capability evidence for the exact account/route/epoch. It does not qualify
entitlement, consent, tools, permissions or a live call. A new selection requires a
complete, unexpired snapshot and positive evidence for each requested capability.

`PrepareBrowser` keeps the existing policy's friendly alias, runtime model and
canonical browser-control mapping. It adds a catalogue pin and rechecks after the
application's digest callback. Existing account approval, admission and observed
public-control checks remain required before Send.

`MapTask` preserves friendly alias separately from the exact provider model pin.
The current Task contract does not carry account scope or catalogue epoch. The
Task Authority owner must keep that pin alongside its actual measured binding and
recheck it before first admission. A running Task keeps its original binding.

`PrepareInference` gives a no-effect builder one exact pin and rechecks after
request assembly. Builder errors are classified without retry or fallback. Its
controlled builder test verifies serialized model/effort and account-switch
suppression; it is not evidence of an integrated inference runtime.

`RecheckBeforeStart` is a first-dispatch guard. It deliberately rejects changed
catalogue/capability revisions. It cannot settle, replay or retarget an admitted,
refused or outcome-unknown operation. The owning application must perform its
last account/authority check at its own intent/effect boundary.

`CaptureEstimate` retains the full immutable model pin, estimator source/version,
original SHA-256 input digest and an explicitly qualified observation/expiry.
`AssessEstimate` distinguishes known, unknown, stale, mismatched and unqualified.
`CheckCurrentBudget` rejects stale, mismatched or unqualified captures before
comparing configured bounds. Unknown quantities cannot satisfy their own limit;
known zero can satisfy zero. No quantities are added or prices converted.

`CheckBudget` remains an arithmetic comparator and cannot establish applicability.
Admission uses `CheckCurrentBudget`, together with the owner's current catalogue,
account and authority fences. The qualified capture is correlation, not authority.
Reported provider usage remains a separate type and provenance. See
[estimate semantics](ESTIMATES.md) and the
[pinned INFERENCE mapping](INFERENCE-MAPPING.md).

## Public reproduction and review

Use the repository's declared Go toolchain, then run:

```sh
go test -race -count=1 ./modules/chat/domain/modelselection ./modules/chat/infra/catalogue
go vet ./modules/chat/domain/modelselection ./modules/chat/infra/catalogue
node tooling/check-go-architecture.mjs
git diff --check
```

The targeted race tests, vet, architecture check and source secret checks passed.
Independent bounded source review found and verified fixes for a browser callback
account/epoch race, empty App Server display labels, and cancellation after
transport/builder callbacks. The generated-wire check stalled in its `gofmt`
subprocess; a bounded run exited 124. It is not a passed gate. Aggregate results
belong in the task export, tied to the exact final source tree.

Risk classification: R4 for account/route and entitlement-related selection
semantics, with concurrency risk. Bounded specialist inspection is source review,
not the formal Critic ladder. Formal review, aggregate acceptance, live provider
qualification and Mac qualification remain gates before promotion. Reverting the
additive feature commits removes this dormant implementation; no persistent
product state or shared contract was migrated.
