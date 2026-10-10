# Qualified advisory estimates

Source checkpoint: local `245270f6857ea34471521a08fc9968da574f49d5`, published
`7212f92adf5fe851438458ed629fbb19fe06b7d8`, equal tree
`6fd9d3ba637b86815510579a9683459bc2de71b3`.

The previous arithmetic-only API accepted `InputTokens={Known:true,Value:1}`
against a limit of one even when its original input digest differed, or when its
validity interval was `[100,200)` and current time was 200. The counterexample
failed against that source before the applicability guard was implemented.
`CheckBudget` still compares numeric values only; it is not current admission.

## Captured provenance

`CaptureEstimate(resolved, originalInputDigest, observation, estimate)` returns
an immutable `CapturedEstimate`. Its detached `Snapshot()` includes:

- The complete model pin: provider/backend/billing route, account ID, exact model
  and effort, catalogue epoch/revision and capability revision.
- Estimator source/version and independent known bits for input/output tokens and
  estimated cost. A known zero remains distinguishable from an absent quantity.
- The lowercase 64-character SHA-256 digest of the exact original estimator input.
  The actual consumer supplies and qualifies the digest; this domain does not
  hash host input or decide which input representation is authoritative.
- Explicitly qualified observation/expiry values. Qualified intervals require
  nonzero observation and expiry greater than observation. An unqualified
  observation has no invented time interval.

Every captured field is scalar. Mutating request values or a returned snapshot
cannot retarget the original capture. No ambient clock, account lookup, price
table, credit conversion or provider effect exists in this domain.

## Assessment and budget admission

`EstimateContext` supplies the current resolved selection, current input digest,
current qualified estimator source/version and explicit current time. These are
current request values, not copies pulled from an old estimate to make it match.

| State         | Meaning                                                             | Current budget use                                                                                |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `known`       | Exact provenance matches, interval is current, all quantities known | Compare configured bounds                                                                         |
| `unknown`     | Provenance/interval are current, at least one quantity unknown      | Only known dimensions may satisfy their configured bounds; a configured unknown dimension refuses |
| `stale`       | Before observation or at/after expiry                               | Refuse, including with no configured limit                                                        |
| `mismatched`  | Selection pin, input digest or estimator source/version differs     | Refuse without choosing another selection or estimate                                             |
| `unqualified` | Missing/invalid current correlation or unqualified observation      | Refuse                                                                                            |

`CheckCurrentBudget` is the admission boundary. It returns `budget-unknown` for
stale, mismatched or unqualified applicability and for an unknown configured
dimension. A current known over-bound value returns `budget-exceeded`. It does not
sum token dimensions or perform multiply/add/narrowing conversions; comparison
at `MaxUint64` remains exact and cannot wrap a value into a smaller accepted one.
If an estimator performs arithmetic upstream, it must independently refuse its
own overflow before marking a value known.

The consumer must also recheck its catalogue and actual account/authority before
first effect. `EstimateContext.Selection` correlates supplied values; it does not
prove a live account or make an expired/revoked catalogue current. Use the existing
`RecheckBeforeStart` against the current snapshot and the effect owner's actual
serialized account/authority fence. Refused or outcome-unknown operations retain
their original binding and cannot be replayed by obtaining a fresh estimate.

`Usage` remains a separate reported-provider type with its own report source and
version. No estimate API converts an estimate into reported, billed or charged
usage. Current budget acceptance proves the supplied bounds, not actual token
usage, price, quota, entitlement or account authority.

## Acceptance witness

New co-located tests reproduce and close stale/foreign-input acceptance; cover
qualified interval endpoints, unqualified observations, input digest shape,
account/provider/backend/billing/model/effort/catalogue/capability changes,
estimator version/source changes, detached values, known zero/unknown and unsigned
boundaries. `TestQualifiedEstimateConsumesExistingBrowserApplicationSelection`
uses the existing Browser application resolver and proves the estimate retains
its exact account/model/effort pin while rejecting a new app account or input.

Focused race tests, targeted vet, import/whitespace/security checks and bounded
independent inspection passed. Earlier unchanged numeric property coverage is
retained. This is portable source and controlled app composition; actual
INFERENCE/WORKFLOW shipping and observation/authority qualification remain open.
