# Pinned INFERENCE selection and estimate conversion

Read-only dependency: `e2824968b72fb891774a4cdda7f0beaa2c893842`, tree
`ea403e2c9439024cfa1d34706874d44e0a7b9694`. Compared public files were verified
against their Git blob identities:

| File                                             | Git blob                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `modules/chat/app/services/inference/types.go`   | `47d8c7b1adbeb3f37017a1e6952e1be73d998350` |
| `modules/chat/app/services/inference/input.go`   | `e2508e7641f63a5291ac811ddf21de7a24134745` |
| `modules/chat/app/services/inference/service.go` | `a65ff21924c7c0dd5049e8f85992e3de10c416c3` |

No dependency source was imported into the MODELS branch. INFERENCE owns its
disposable actual cross-feature witness. The conversions below specify that
owner's adapter; they are not a claim of production or shipping composition.

## Selection mapping

Only the exact MODELS route `{Provider:"openai", Backend:PlanInference,
Billing:Plan}` maps to `inference.PlanBackend` (`chatgpt-plan-responses`). MODELS
uses `plan-inference` as its policy backend identifier; the mapping is explicit.
Codex/App Server, Browser and API billing routes refuse this conversion.

| Original immutable value           | INFERENCE value                                 | Required check                                                                                                       |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pin.Model`                        | `ModelSelection.Slug`                           | Preserve exact bytes; `ValidSelection` must accept them                                                              |
| `pin.Effort`                       | `ModelSelection.Effort`                         | Preserve exact advertised effort; no alias/default substitution                                                      |
| `pin.CapabilityRevision`           | `ModelSelection.CapabilityEvidence`             | Preserve the independent product evidence revision; require positive text evidence and retain its backing provenance |
| `pin.Epoch`                        | `ModelSelection.CatalogueEpoch`                 | Catalogue epoch only                                                                                                 |
| `pin.AccountID`                    | Retained correlation with trusted owner account | Cannot synthesize `AccountIdentity` from this opaque ID                                                              |
| `pin.Revision`, route and full pin | Retained alongside operation binding            | INFERENCE's DTO has no fields for these; do not discard them from owner rechecks                                     |

After the actual owner supplies and fences its independently verified account,
consent and opaque account correlation, the exact model DTO construction is:

```go
model := inference.ModelSelection{
    Slug:               pin.Model,
    Effort:             pin.Effort,
    CapabilityEvidence: pin.CapabilityRevision,
    CatalogueEpoch:     pin.Epoch,
}
candidate := ownerSelectedSelection // verified account and consent supplied by owner
candidate.Backend = inference.PlanBackend
candidate.Model = model
// Refuse unless the exact route, owner account correlation and positive text
// evidence match, and inference.ValidSelection(candidate) returns true.
```

`Selection.Account` contains issuer, subject, issued client ID, host ID and account
epoch. None can be inferred from `Pin.AccountID` or catalogue epoch. The owning
selected-account/consent fence must establish the exact correlation. Catalogue
epochs and account epochs are independent. Consent ID/revision remain owner values.
The original `Resolved` is retained and rechecked; constructing a DTO grants no
account authority and does not qualify entitlement.

## Estimate and context mapping

INFERENCE's `InputHash` hashes `json.Marshal([]InputItem)` in original order, not
the provider's transformed Responses body or a bare text string. Configure the
owning digester for SHA-256 and capture that exact hash as the estimator input
digest. Its validator checks lowercase 64-character hex, not the hash algorithm.
If an estimator uses additional input, the owner must bind that representation
explicitly; a different digest cannot be silently substituted.

After current catalogue/account checks, construct `EstimateContext` from current
request values and run `CheckCurrentBudget` before admission. For INFERENCE's
input-token DTO conversion, also require a known, positive explicit input limit
and a known input-token estimate. Then the exact assignments are:

```go
snapshot := capturedEstimate.Snapshot()
// First: CheckCurrentBudget(capturedEstimate, currentEstimateContext, budget).
// Refuse unless current input digest equals the actual inference.InputHash,
// budget.MaxInputTokens.Known && budget.MaxInputTokens.Value > 0,
// and snapshot.Estimate.InputTokens.Known.
contextValue := inference.ContextSelection{
    CheckpointID:    ownerCheckpointID, // supplied by CONTEXT owner, never fabricated
    InputHash:       currentEstimateContext.InputDigest,
    EstimatedTokens: snapshot.Estimate.InputTokens.Value,
    TokenLimit:      budget.MaxInputTokens.Value,
}
```

INFERENCE's `ContextSelection` has no known bit, estimator source/version or
observation/expiry. Retain the complete `CapturedEstimate` beside the original
binding and recheck it with current request/time values before first admission.
Configured output/cost limits still require `CheckCurrentBudget`; that DTO does
not carry those fields. Never assign unknown input tokens as zero. No conversion
narrows integer width or adds quantities. A known zero input estimate may map with
a positive explicit limit; a zero limit cannot map because `validBinding` refuses
it. A checkpoint ID must be supplied independently; it is not the input digest.

The INFERENCE service reserves the original operation, then owns credential,
account/authority and publication checks. MODELS' qualified budget check cannot
authorize replay of refused or outcome-unknown effects or replace a reserved pin.

## Minimal incompatibility examples

| Value                                                     | Refusal required                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Advertised MODELS effort `deliberate`                     | INFERENCE accepts only empty/none/minimal/low/medium/high/xhigh; never translate it into high          |
| Capability revision `evidence with spaces`, or 121 bytes  | MODELS can retain this revision, but INFERENCE's identifier rejects it; never trim/truncate            |
| Pin account ID only                                       | Issuer/subject/client/host/account epoch and consent are missing; cannot fabricate trusted identity    |
| Codex catalogue pin or API billing                        | Not the exact public-plan inference route; cannot use cached App Server rows as SIWC entitlement       |
| Unknown input estimate                                    | Plain `EstimatedTokens uint64` has no unknown representation; assigning zero would fabricate knowledge |
| Known-zero input limit                                    | MODELS can compare zero against zero; INFERENCE requires `TokenLimit > 0`                              |
| Estimate for hash A, current ordered input hash B         | Qualified guard returns mismatched; no substitute estimate/model or truncation                         |
| Time equal to captured expiry, or unqualified observation | Budget guard refuses even if numeric values fit                                                        |
| New catalogue epoch/model/effort/account after capture    | Preserve the old immutable capture and refuse current admission with it                                |

These are exact source-shape comparisons, not actual cross-feature execution.
The existing MODELS Browser/Task Resolve compositions remain qualified only with
controlled ports. Actual INFERENCE/WORKFLOW and shipping composition stay open.
