// Package processprobe observes one bound process through the legacy ps token.
// It grants no execution or termination authority over that process.
package processprobe

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

const (
	observationCap = 3 * time.Second
	cleanupCap     = time.Second
	streamLimit    = 4096
)

// Probe binds an immutable PID. A failed observation is sticky: its unknown
// result cannot authorize another native attempt on the same Probe.
type Probe struct{ *probeState }

// Copying the public wrapper cannot split the taint or lifecycle owner.
type probeState struct {
	pid       int
	boundary  boundary
	gate      chan struct{}
	tainted   bool
	taintKind port.ProcessProbeFailureKind
	retained  *observation // accessed only while holding gate; late owner retains itself
}

var _ port.ProcessProbe = (*Probe)(nil)

// New has no target-process effects. Production observation is Darwin-only;
// portable fixtures do not qualify native token or updater behavior.
func New(pid int) (*Probe, error) {
	if !validPID(pid) {
		return nil, failure(port.ProcessProbeInput)
	}
	if !supported() {
		return nil, failure(port.ProcessProbeUnknown)
	}
	return newProbe(pid, nativeBoundary{}), nil
}

func validPID(pid int) bool { return pid >= 2 && int64(pid) <= math.MaxInt32 }

func newProbe(pid int, b boundary) *Probe {
	p := &Probe{&probeState{pid: pid, boundary: b, gate: make(chan struct{}, 1)}}
	p.gate <- struct{}{}
	return p
}

// PID is correlation only; it performs no native lookup.
func (p *Probe) PID() int {
	if p == nil || p.probeState == nil {
		return 0
	}
	return p.pid
}

// Observe preserves until's original absolute deadline, including its monotonic
// component. Serialization, native observation and result publication share one
// budget. Cleanup has a separate fixed cap and cannot authorize a late result.
func (p *Probe) Observe(ctx context.Context, until time.Time) (port.ProcessObservation, error) {
	if p == nil || p.probeState == nil || !validPID(p.pid) || p.gate == nil || p.boundary == nil || ctx == nil || until.IsZero() {
		return unknown(), failure(port.ProcessProbeInput)
	}
	deadline := time.Now().Add(observationCap)
	if until.Before(deadline) {
		deadline = until
	}
	if contextUntil, ok := ctx.Deadline(); ok && contextUntil.Before(deadline) {
		deadline = contextUntil
	}
	if err := budgetFailure(ctx, deadline); err != nil {
		return unknown(), err
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return unknown(), budgetFailure(ctx, deadline)
	case <-timer.C:
		return unknown(), failure(port.ProcessProbeDeadline)
	case <-p.gate:
	}
	defer func() { p.gate <- struct{}{} }()
	if err := budgetFailure(ctx, deadline); err != nil {
		return unknown(), err
	}
	if p.tainted {
		return unknown(), failure(p.taintKind)
	}
	o := newObservation(ctx, deadline, p.pid, p.boundary)
	p.retained = o
	go o.run()
	var frozen port.ProcessProbeFailureKind
	select {
	case <-o.done:
		if err := budgetFailure(ctx, deadline); err != nil {
			frozen = failureKind(err)
			break
		}
		result, err := o.result()
		if late := budgetFailure(ctx, deadline); late != nil {
			frozen = failureKind(late)
			break
		}
		if err != nil {
			p.tainted, p.taintKind = true, failureKind(err)
		}
		if o.cleanupKnown() {
			p.retained = nil
		}
		return result, err
	case <-ctx.Done():
		frozen = port.ProcessProbeCanceled
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			frozen = port.ProcessProbeDeadline
		}
	case <-timer.C:
		frozen = port.ProcessProbeDeadline
	case <-o.overflow:
		frozen = port.ProcessProbeUnknown
	}
	// Nothing after this point can publish a successful or absent observation.
	p.tainted = true
	o.stop()
	cleanup := time.NewTimer(cleanupCap)
	defer cleanup.Stop()
	select {
	case <-o.done:
		if !o.cleanupKnown() {
			frozen = port.ProcessProbeCleanupUnknown
		} else {
			p.retained = nil
		}
	case <-cleanup.C:
		// The same owner keeps its original child and pending native operations.
		// No second attempt or replacement cleanup owner is created.
		frozen = port.ProcessProbeCleanupUnknown
	}
	p.taintKind = frozen
	return unknown(), failure(frozen)
}

func unknown() port.ProcessObservation { return port.ProcessObservation{Presence: port.ProcessUnknown} }
func failure(kind port.ProcessProbeFailureKind) error {
	return &port.ProcessProbeFailure{Kind: kind}
}

func failureKind(err error) port.ProcessProbeFailureKind {
	var f *port.ProcessProbeFailure
	if errors.As(err, &f) {
		return f.Kind
	}
	return port.ProcessProbeCleanupUnknown
}

func budgetFailure(ctx context.Context, deadline time.Time) error {
	if ctx.Err() != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return failure(port.ProcessProbeDeadline)
		}
		return failure(port.ProcessProbeCanceled)
	}
	if !time.Now().Before(deadline) {
		return failure(port.ProcessProbeDeadline)
	}
	return nil
}
