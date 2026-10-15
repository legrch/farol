// Package installcopy copies a held source tree into a new, private, empty
// directory. Success means copying completed, not authentication, publication,
// adoption, or execution. The release owner must verify the complete expected
// tree with apptree and appidentity before publication.
// Copying is not an atomic source snapshot or a same-UID filesystem exclusion
// boundary: mkdirat/symlinkat do not return an atomic created-object handle.
// Exclusive creation, nofollow opens, held/named fingerprints and final bounded
// inventories detect changes without granting authentication authority here.
//
// The caller lends the exact top-directory Files until synchronous return. The
// package neither closes nor reconfigures them. Kernel calls may block beyond a
// deadline; cancellation is checked around I/O, never simulated by abandoning a
// goroutine or releasing borrowed descriptor custody early.
package installcopy

import (
	"context"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

type Identity struct{ Device, Inode string }
type Directory struct {
	File     *os.File
	Identity Identity
}

// Fence belongs to the existing release owner. It verifies physical named
// routes, the accepted source build, lease, slot, journal, and admission. It is
// called before effects and again after copying. It does not replace the owner's
// final expected-digest and application-identity verification.
type Fence func(context.Context) error

// Failure.Error contains no paths or underlying OS error text. Its private cause
// preserves native/fence classification and concurrent cancellation. Internal
// distinguishes native errors from inspected refusals. Uncertain means some
// private destination effect may have occurred; the operation must not be retried.
type Failure struct {
	Code                string
	Uncertain, Internal bool
	cause               error
}

func (f *Failure) Error() string {
	if f == nil {
		return "launch_copy_input"
	}
	return f.Code
}

// Unwrap preserves the release owner's post-effect fence classification for its
// adapter. Error remains closed and path-free; the adapter combines that owner's
// refusal with copy uncertainty rather than assigning a helper exit here.
func (f *Failure) Unwrap() error {
	if f == nil {
		return nil
	}
	return f.cause
}

type captured struct {
	source, destination Directory
	until               time.Time
	fence               Fence
	used                atomic.Bool
	roots               rootPins
}

// Operation is immutable to callers. Copies share the same private one-shot
// token, including after a refused, canceled, or concurrent Run.
type Operation struct{ capture *captured }

func canonical(s string) bool {
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && strconv.FormatUint(n, 10) == s
}

func refusal(code string) error { return &Failure{Code: "launch_copy_" + code} }

// Prepare captures the exact borrowed handles, identities, modes and owners.
// The caller creates the private destination; this package creates no top-level
// namespace and never removes, rolls back, adopts, or overwrites entries.
func Prepare(source, destination Directory, until time.Time, fence Fence) (*Operation, error) {
	if source.File == nil || destination.File == nil || fence == nil || until.IsZero() ||
		!canonical(source.Identity.Device) || !canonical(source.Identity.Inode) ||
		!canonical(destination.Identity.Device) || !canonical(destination.Identity.Inode) ||
		source.Identity == destination.Identity {
		return nil, refusal("input")
	}
	c := &captured{source: source, destination: destination, until: until, fence: fence}
	if err := prepareSystem(c); err != nil {
		return nil, err
	}
	return &Operation{capture: c}, nil
}

func (o *Operation) Run(ctx context.Context) error {
	return runSystem(o, ctx)
}
