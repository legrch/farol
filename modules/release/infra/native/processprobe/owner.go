package processprobe

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// These private primitives are fixture seams, never caller-supplied authority.
// A Start error means no process was created, matching exec.Cmd.Start. Wait must
// report actual termination independently of its output/error classification.
type child interface {
	start() error
	wait() (status, error)
	kill() error
}

type status struct {
	exited bool
	code   int
}

type boundary interface {
	prepare(int, io.Writer, io.Writer) child
	absent(int) bool // true ONLY for target signal0 ESRCH
}

// observation is the sole retained lifecycle owner, including after caller
// cleanup expires. It never replaces a child with a numeric PID/PGID lookup.
type observation struct {
	ctx                                        context.Context
	deadline                                   time.Time
	pid                                        int
	boundary                                   boundary
	child                                      child
	out, err                                   *drainWitness
	overflow                                   chan struct{}
	done                                       chan struct{}
	mu                                         sync.Mutex
	started, waited, stopped, finished, closed bool
	killStarted, killFinished, killFailed      bool
	clean                                      bool
	value                                      port.ProcessObservation
	failure                                    error
}

func newObservation(ctx context.Context, deadline time.Time, pid int, b boundary) *observation {
	o := &observation{ctx: ctx, deadline: deadline, pid: pid, boundary: b,
		overflow: make(chan struct{}, 1), done: make(chan struct{}), value: unknown()}
	o.out = newDrain(func() { o.exceeded() })
	o.err = newDrain(func() { o.exceeded() })
	return o
}

func (o *observation) exceeded() {
	select {
	case o.overflow <- struct{}{}:
	default:
	}
	o.stop()
}

func (o *observation) run() {
	// Preparation allocates the fixed command but performs no native calls.
	o.child = o.boundary.prepare(o.pid, o.out, o.err)
	if o.child == nil {
		o.finish(unknown(), failure(port.ProcessProbeUnknown), true)
		return
	}
	if err := budgetFailure(o.ctx, o.deadline); err != nil {
		o.finish(unknown(), err, true)
		return
	}
	// No lock spans any native primitive: even a lost Start retains this owner
	// while the caller's cleanup cap remains bounded.
	if err := o.child.start(); err != nil {
		// The child was not created, but legacy startup exceptions are an
		// uncertain terminal failure, distinct from completed ps refusals.
		o.finish(unknown(), failure(port.ProcessProbeStartFailure), true)
		return
	}
	o.mu.Lock()
	o.started = true
	kill := o.requestKillLocked()
	o.mu.Unlock()
	if kill {
		go o.kill()
	}
	s, waitErr := o.child.wait()
	o.mu.Lock()
	// A returned native error without terminal state is not reap evidence.
	o.waited = s.exited
	stopped := o.stopped
	o.mu.Unlock()
	if !s.exited {
		o.stop()
	}
	clean := s.exited && o.out.drained() && o.err.drained()
	if !clean || waitErr != nil {
		o.finish(unknown(), failure(port.ProcessProbeCleanupUnknown), false)
		return
	}
	if stopped || (s.code != 0 && s.code != 1) || o.out.exceeded() || o.err.exceeded() || len(o.err.bytes()) != 0 {
		o.finish(unknown(), failure(port.ProcessProbeUnknown), true)
		return
	}
	if err := budgetFailure(o.ctx, o.deadline); err != nil {
		o.finish(unknown(), err, true)
		return
	}
	token, valid := startToken(o.out.bytes())
	if !valid {
		o.finish(unknown(), failure(port.ProcessProbeUnknown), true)
		return
	}
	if token != "" {
		o.finish(port.ProcessObservation{Presence: port.ProcessPresent, Start: token}, nil, true)
		return
	}
	// Only this clean empty snapshot permits signal0, never a nonzero signal.
	// A blocked existence primitive stays retained and cannot extend the budget.
	if !o.boundary.absent(o.pid) {
		o.finish(unknown(), failure(port.ProcessProbeUnknown), true)
		return
	}
	o.finish(port.ProcessObservation{Presence: port.ProcessAbsent}, nil, true)
}

func (o *observation) stop() {
	o.mu.Lock()
	if o.finished {
		o.mu.Unlock()
		return
	}
	o.stopped = true
	kill := o.requestKillLocked()
	o.mu.Unlock()
	if kill {
		go o.kill()
	}
}

func (o *observation) requestKillLocked() bool {
	if !o.stopped || !o.started || o.waited || o.killStarted {
		return false
	}
	o.killStarted = true
	return true
}

func (o *observation) kill() {
	o.mu.Lock()
	// A scheduled stop that loses to terminal Wait does not call Kill.
	alreadyWaited := o.waited
	o.mu.Unlock()
	var err error
	if !alreadyWaited {
		// The retained os.Process also arbitrates concurrent Wait/Kill natively;
		// no detached numeric identity is available to this owner.
		err = o.child.kill()
	}
	o.mu.Lock()
	o.killFinished = true
	o.killFailed = err != nil
	o.settleLocked()
	o.mu.Unlock()
}

func (o *observation) finish(value port.ProcessObservation, err error, clean bool) {
	o.mu.Lock()
	o.value, o.failure, o.clean = value, err, clean
	o.finished = true
	o.settleLocked()
	o.mu.Unlock()
}

func (o *observation) settleLocked() {
	if o.closed || !o.finished || (o.killStarted && !o.killFinished) {
		return
	}
	o.closed = true
	close(o.done)
}

func (o *observation) cleanupKnown() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.closed && o.clean && !o.killFailed
}

func (o *observation) result() (port.ProcessObservation, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.closed || !o.clean || o.killFailed {
		return unknown(), failure(port.ProcessProbeCleanupUnknown)
	}
	if o.stopped {
		return unknown(), failure(port.ProcessProbeUnknown)
	}
	return o.value, o.failure
}
