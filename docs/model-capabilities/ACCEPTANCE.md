# MODELS source acceptance and integration handoff

The feature branch is `feature/model-capability-routing`. B0 is
`99aca15ffe16b435e59b19c20ff48e06bd56960d`, tree
`92047a064fede82658c37cf0f0a76004f6ce291c`. This handoff describes public source
and controlled tests. It includes no provider/account evidence or private inputs.

## Exact checkpoint mapping

The connector preserves source trees and ancestry, but creates new commit IDs.
The exported local commits remain available without rewriting them.

| Checkpoint                    | Local commit                               | Published equivalent                       | Equal tree                                 |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Domain                        | `a05e5af852a88d96f70f5a9b0573ad03b43ddf2a` | `a371a37e2f81279a60b8782a1964ed7134b8c5d3` | `7c33f5f86bc081d6ea2478bb50fbfe0ff4965615` |
| Adapters and consumers        | `8fd1aa8f16e1ff5abc9492470d11d71dd0152807` | `aa96c6118295ae946a9c998fdb2880f38fa5963b` | `1aa84dc0ac336a37f75a98e55e38ea06bd2e01af` |
| Initial handoff               | `1adeb667f01699ddf518503cf2e0587b296fd06d` | `7fe702f2b9f035eb0878c61a9701237315473c06` | `ffa0e8a20cce1dcb8a61413777af542619cb5dd5` |
| Boundary fixes and coverage   | `a73b7de5c7f17b010a3df77dc07f0f58798a5a64` | `2b137f497ca541212b5c4a9672e0b0b021327c31` | `e7ffa7ed2d11b1a94717d136e4b47cacde787c90` |
| Prior final handoff           | `49a1cf7895a63ddf62a8546b576a022ee8e18b3e` | `3b8aaff57ae3599e01e8edad1a7a71cd6daf5cd9` | `2a4923dafc4b4dacf21d079651843ee28d861a09` |
| Qualified estimate provenance | `245270f6857ea34471521a08fc9968da574f49d5` | `7212f92adf5fe851438458ed629fbb19fe06b7d8` | `6fd9d3ba637b86815510579a9683459bc2de71b3` |

The latest documentation checkpoint is identified by the branch and export
manifest. The manifest records final local/published identities and readback.

## M1 through M7 evidence

Tests are co-located in `modules/chat/domain/modelselection` and
`modules/chat/infra/catalogue`.

| Package                   | Actual evidence                                                                                                                                                                                                                       | Remaining qualification                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Catalogue adapters     | Declared SIWC/App Server mapping; malformed unknown fields, duplicate keys/rows/UI IDs, byte/row/page/depth limits, effort/default inconsistency, invalid UTF8; bounded `FuzzDeclaredCatalogue` checks parser/domain/reader agreement | Live protocol and transport qualification; account-specific SIWC cannot be substituted with cached App Server rows                                |
| M2 Truthful availability  | Compatibility truth table; expired/partial/foreign account projections; selected model disappearance is revoked only for a complete current list                                                                                      | Entitlement remains untested; no account grant                                                                                                    |
| M3 Immutable binding      | Captured request/catalogue mutation; revocation/reconnect retains original pin; final account/epoch fences; private cache ticket ownership and detached snapshots                                                                     | Actual account/authority check at the effect boundary                                                                                             |
| M4 Preferences            | 256 deterministic preference/catalogue permutations; absent/hidden/archived/effort/capability explicit refusals never use eligible preferences                                                                                        | These choices occur before dispatch; no post-refusal fallback                                                                                     |
| M5 Usage/estimates        | Known zero versus unknown; immutable selection/input/source/version/qualified time capture; stale/mismatched/unqualified refusal; uint64 extremes; real Browser selection consumes qualified estimate; distinct reported usage        | Estimator observation/input hash and live account/authority qualification remain with their owners; price/billing is unqualified                  |
| M6 Races/errors           | Concurrent account/epoch changes and blocked old read across A-B-A reconnect; stale refresh and one-use ticket; partial refresh invalidation; callback cancellation and scope changes; sanitized errors                               | No actual dispatch occurs; refused/unknown effect semantics belong to the effect owner                                                            |
| M7 Two existing consumers | Existing Browser application receives canonical control/account/model/effort capture; existing Task service/facade Resolve consumes exact model/effort mapping through controlled Authority/provider ports                            | Task account pin resides in controlled Authority, not its public Binding; actual INFERENCE/WORKFLOW and shipping boot composition remain deferred |

`PrepareInference` additionally verifies serialized model/effort through a
controlled no-effect builder. Its tests reject builder retargeting of model,
account, effort, billing and epoch; callback preference mutation cannot retarget
the captured pin, and returned body bytes are detached. This is portable adapter
composition, not proof of a live or shipping inference service.

## Demonstrated regressions and verification

The expanded tests first demonstrated three defects on the previous code:

- A partial injected refresh returned success and became the cache's current list.
  `TestCacheRejectsPartialRefreshWithoutRestoringOlderRows` now rejects it and
  prevents an older response from restoring rows.
- Padded/control-character labels parsed successfully but failed domain validation.
  `TestParsedLabelsRemainValidDomainValues` now rejects them at the boundary.
- A ticket from another consumer's cache was accepted when scope/counters matched.
  `TestRefreshTicketBelongsToOneConsumerCache` now rejects it before settlement,
  leaving both caches' own tickets usable.

After these fixes, targeted race tests, targeted vet, direct Go architecture,
whitespace checks and owned-source/working-tree secret scans passed. Bounded
native fuzzing ran for 10 seconds with two workers, completed 56,264 cases and
passed. Deterministic property tables run in every ordinary targeted test.
Independent read-only inspection verified the cache ownership fix and found no
additional demonstrated lifetime/aliasing/race/error defect. This is bounded
inspection, not formal Critic acceptance.

The later M5 counterexample demonstrated that the bare `CheckBudget` comparator
accepted expired and foreign-input values. `CaptureEstimate`, `AssessEstimate`
and `CheckCurrentBudget` now supply the missing applicability boundary. Focused
race tests, independent bounded review, targeted vet, import and security checks
passed. Existing property/fuzz evidence above remains tied to unchanged parser
and preference bytes; no unchanged broad suite was rerun for this extension.
The Browser composition test consumes the new capture with a real app selection.
Full semantics and exact INFERENCE conversion are in `ESTIMATES.md` and
`INFERENCE-MAPPING.md`.

## Preserved external gates

The original broad run failed Computer native filesystem/access tests. The
architecture test harness failed spawning Node with EPERM; the direct architecture
checker passed. Generated-wire checking timed out in its gofmt child, and the
bounded `ci:fast` run timed out during coverage. The original outcomes remain in
the task export. Unchanged large suites were not rerun for these MODELS fixes;
none is represented as passing or proven to fail on B0.

SOURCE and PORTABLE checks above are available. COMPOSED applies to the two
existing consumer paths with controlled ports. Publication is verified separately
by source-tree and branch readback. Actual shared-owner composition, estimate
observation/input qualification, INFERENCE/WORKFLOW effect semantics, formal required review, aggregate
acceptance, LIVE provider and MAC/native qualification remain open.

Exact shared-owner requests and B0 target blob identities are in `INTEGRATION.md`.
No shared boot/schema/contracts/journal/authority changes are included.
