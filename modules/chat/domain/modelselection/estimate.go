package modelselection

// EstimateObservation is qualified by the estimator's owner, never this domain.
// An unqualified observation has no invented timestamp or validity interval.
type EstimateObservation struct {
	Qualified                         bool
	ObservedAtMillis, ExpiresAtMillis uint64
}

type EstimateState string

const (
	EstimateKnown       EstimateState = "known"
	EstimateUnknown     EstimateState = "unknown"
	EstimateStale       EstimateState = "stale"
	EstimateMismatched  EstimateState = "mismatched"
	EstimateUnqualified EstimateState = "unqualified"
)

// EstimateSnapshot is a detached advisory value, not reported or billed usage.
// InputDigest is the owner's lowercase SHA-256 of the exact original input.
type EstimateSnapshot struct {
	Selection   Pin
	InputDigest string
	Observation EstimateObservation
	Estimate    Estimate
}

// CapturedEstimate retains only immutable scalar values. It cannot grant account
// authority or requalify a selection after catalogue/consent withdrawal.
type CapturedEstimate struct {
	snapshot EstimateSnapshot
	valid    bool
}

func (e CapturedEstimate) Snapshot() EstimateSnapshot { return e.snapshot }

// EstimateContext is supplied by the actual consumer for the current request.
// Source/version identify the estimator qualified for that request. Time is an
// explicit value; account/catalogue authority still requires its owning fence.
type EstimateContext struct {
	Selection                    Resolved
	InputDigest, Source, Version string
	NowMillis                    uint64
}

func validInputDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func CaptureEstimate(selection Resolved, inputDigest string, observation EstimateObservation, estimate Estimate) (CapturedEstimate, error) {
	if !selection.valid || !validInputDigest(inputDigest) {
		return CapturedEstimate{}, deny(Invalid, "estimate requires an original resolved selection and input digest")
	}
	if err := ValidateEstimate(estimate); err != nil {
		return CapturedEstimate{}, err
	}
	if observation.Qualified {
		if observation.ObservedAtMillis == 0 || observation.ExpiresAtMillis <= observation.ObservedAtMillis {
			return CapturedEstimate{}, deny(Invalid, "qualified estimate requires a nonempty validity interval")
		}
	} else if observation.ObservedAtMillis != 0 || observation.ExpiresAtMillis != 0 {
		return CapturedEstimate{}, deny(Invalid, "unqualified estimate cannot claim a validity interval")
	}
	return CapturedEstimate{snapshot: EstimateSnapshot{Selection: selection.Pin(), InputDigest: inputDigest, Observation: observation, Estimate: estimate}, valid: true}, nil
}

// AssessEstimate projects applicability. Unknown describes missing quantities in
// an otherwise current qualified capture; each quantity retains its Known bit.
// Mismatch precedes expiry so foreign values are never displayed as current.
func AssessEstimate(captured CapturedEstimate, current EstimateContext) EstimateState {
	if !captured.valid || !captured.snapshot.Observation.Qualified || !current.Selection.valid || !validInputDigest(current.InputDigest) || !validString(current.Source, 256) || !validString(current.Version, 128) {
		return EstimateUnqualified
	}
	s := captured.snapshot
	if s.Selection != current.Selection.Pin() || s.InputDigest != current.InputDigest || s.Estimate.Source != current.Source || s.Estimate.Version != current.Version {
		return EstimateMismatched
	}
	if current.NowMillis < s.Observation.ObservedAtMillis || current.NowMillis >= s.Observation.ExpiresAtMillis {
		return EstimateStale
	}
	if !s.Estimate.InputTokens.Known || !s.Estimate.OutputTokens.Known || !s.Estimate.CostMicrounits.Known {
		return EstimateUnknown
	}
	return EstimateKnown
}

// CheckCurrentBudget is the applicability-aware budget boundary. It never uses
// stale, mismatched or unqualified estimates, even with no configured limit.
// Unknown dimensions cannot satisfy their configured limit; known zero can.
func CheckCurrentBudget(captured CapturedEstimate, current EstimateContext, budget Budget) error {
	switch AssessEstimate(captured, current) {
	case EstimateStale:
		return deny(BudgetUnknown, "estimate is outside its qualified validity interval")
	case EstimateMismatched:
		return deny(BudgetUnknown, "estimate selection, input or estimator provenance changed")
	case EstimateUnqualified:
		return deny(BudgetUnknown, "estimate applicability is unqualified")
	case EstimateKnown, EstimateUnknown:
		return CheckBudget(captured.snapshot.Estimate, budget)
	default:
		return deny(BudgetUnknown, "estimate applicability is unknown")
	}
}
