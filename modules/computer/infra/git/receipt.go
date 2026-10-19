package git

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

func packDigest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// IntentDigest seals the canonical plan at the infrastructure boundary.
// It returns empty for an invalid plan and never grants authority. Trusted
// composition and the existing custody owner bind this same digest; neither
// must invent a second encoding or treat a matching hash as authorization.
func IntentDigest(plan *egress.Plan) string {
	if plan == nil || plan.Canonical() == "" {
		return ""
	}
	return packDigest([]byte(plan.Canonical()))
}

type ReadbackState string

const (
	Unobserved     ReadbackState = "unobserved"
	TargetObserved ReadbackState = "target_observed"
	OtherObserved  ReadbackState = "other_observed"
)

// Readback records a NEW, separately authorized, exact remote observation. It
// NEVER overwrites the original unknown/rejected outcome, implies attribution
// to this push, issues a retry, or declares process/descendant cleanup complete.
type Readback struct {
	State      ReadbackState
	Original   RefOutcome
	CurrentOID string
}

func Reconcile(plan *egress.Plan, original Result, observedOID string) (Readback, error) {
	digest := IntentDigest(plan)
	if digest == "" || original.IntentDigest != digest || original.OperationID != plan.Intent().Binding.OperationID {
		return Readback{}, ErrScope
	}
	if observedOID == "" {
		return Readback{State: Unobserved, Original: original.RefOutcome}, nil
	}
	in := plan.Intent()
	if !egress.ValidOID(in.Format, observedOID, true) {
		return Readback{}, ErrProtocol
	}
	state := OtherObserved
	if observedOID == in.Head {
		state = TargetObserved
	}
	return Readback{State: state, Original: original.RefOutcome, CurrentOID: observedOID}, nil
}
