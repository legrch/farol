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
