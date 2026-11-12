// Package lease declares a Go-owned read-only current-startup-Data
// dependency. Its success never establishes approval to read or execute.
package lease

import (
	"context"
	domain "github.com/legrch/farol/modules/computer/domain/lease"
)

type Anchor interface {
	// Requalify requires the original held descriptors and the current boot/
	// runtime epoch to remain unchanged. It does not renew permissions.
	Requalify(context.Context) error
	// Check opens candidate directories without following symlinks; no native fd
	// escapes. The returned classification is not authorization.
	Check(context.Context, string) (domain.Candidate, error)
	// Close consumes the lease exactly once, including on close failure.
	Close() error
}

type Acquirer interface {
	Acquire(context.Context) (Anchor, error)
}

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }
func (*Failure) Retry() string   { return "never" }
