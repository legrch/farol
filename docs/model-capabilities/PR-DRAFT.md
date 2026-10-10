# Prepared source review draft

Head: `feature/model-capability-routing`.
Suggested title: `Bind model routing and budgets to account-scoped provenance`.

This is a prepared PR title/body. It creates no PR, merge, release or activation.
The source checkpoint and exact published/local mapping are in `ACCEPTANCE.md`.

## Proposed body

Add bounded account-scoped catalogue adapters, truthful availability, immutable
model/effort/provider/billing pins and deterministic preferences. Account-specific
SIWC rows stay distinct from cached App Server rows; catalogue discovery never
grants capability or entitlement, and explicit refusal never selects a fallback.

Close an observed budget applicability gap: the old numeric comparator accepted
an expired estimate or one derived from another input. Immutable estimate captures
now retain estimator source/version, original input digest, exact selection and
qualified observation/expiry. The current budget guard refuses stale, mismatched
or unqualified captures while preserving known zero, unknown quantities and
separate reported provider usage.

Existing Browser model selection and Task Resolve facade consume the mappings in
controlled composition tests. A new Browser composition consumes qualified
estimate provenance. A no-effect inference builder verifies exact pins and detached
request bytes. Read-only comparison against pinned INFERENCE source provides exact
conversion rules and incompatibilities; actual cross-feature execution belongs to
that owner and is not represented as shipping integration here.

Changes are confined to modelselection, catalogue and their co-located tests plus
model-capabilities documentation. No boot/schema/contracts/journal/authority,
renderer shipping, installed/native state or provider effects are changed.

Validation: targeted race tests, targeted vet, direct Go architecture, owned
format/whitespace checks, source security checks and bounded independent review
passed. Original catalogue property/fuzz coverage remains applicable to unchanged
bytes. The stale/foreign-input counterexample and earlier partial catalogue,
invalid label and cross-consumer ticket failures were retained before fixes.

Original broad Computer/native failures, Node EPERM and generator/aggregate
timeouts remain open and were not rerun unchanged. This source candidate needs
shared-owner shipping composition, actual INFERENCE/WORKFLOW witnesses, estimator
observation/input/account qualification, formal required review, aggregate
acceptance, LIVE provider and MAC/native qualification before promotion.

Rollback is removal of these additive source commits. No persistent product state
or shared schema was migrated. Source-only publication excludes private packets,
provider/account evidence, credentials and raw local receipts.
