// Package observation declares the read-only identity observation dependency.
package observation

import (
	"context"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// Probe is private to an owner-admitted diagnostic/future migration composition.
// A tool request is not authority to call it. An observation is not a live lease:
// callers may not turn it into an ApprovedRoot or reuse its closed descriptors.
type Probe interface {
	Observe(context.Context, string) (identity.Observation, error)
}

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

// Retry is fixed, not chosen by a caller or native error.
func (f *Failure) Retry() string { return "never" }

// HeldObservation retains its original directory-descriptor chain until Close.
// Snapshot returns a value copy, not a fresh authority or an open filesystem
// capability. The owner must Requalify at every future publication boundary.
// Failure or closing this instance never grants permission to retry an effect.
type HeldObservation interface {
	Snapshot() (identity.Observation, error)
	Requalify(context.Context) error
	Close() error
}

// Holder is a private, unwired prerequisite for a future owner-admitted
// continuity transition. It does not replace Probe or any live authority gate.
type Holder interface {
	Hold(context.Context, string) (HeldObservation, error)
}
