// Package processwait observes one predecessor identity and waits for its exit.
// It grants no readiness, process control, admission or application effect authority.
package processwait

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

// Failure exposes a closed code and preserves observation uncertainty. Neither
// value authorizes retry or settles an application effect.
type Failure struct {
	Code      string
	Uncertain bool
}

func (f *Failure) Error() string { return f.Code }

// Service retains a private confirmation witness for its immutable probe/token.
// Copies share consumption state and cannot mint another confirmation or wait.
type Service struct{ session *session }

type session struct {
	expected string
	probe    port.ProcessProbe
	clock    port.ProcessWaitClock
	gate     chan struct{}
	confirm  bool
	witness  bool
	wait     bool
}

// New requires trusted, non-panicking ports without typed-nil implementations.
// Trusted native composition owns concrete dependency validation. Construction
// performs no calls into either port.
func New(expected string, probe port.ProcessProbe, clock port.ProcessWaitClock) (*Service, error) {
	if !token(expected) {
		return nil, failure("process_input", false)
	}
	if probe == nil || clock == nil {
		return nil, failure("process_dependency", false)
	}
	return &Service{session: &session{expected: expected, probe: probe, clock: clock, gate: make(chan struct{}, 1)}}, nil
}

// Capture accepts only a valid positively observed identity, preserving its exact
// already-trimmed bytes. All time comes from clock; until is never renewed.
// Its ports have the same trusted non-panicking, non-typed-nil precondition as New.
func Capture(ctx context.Context, until time.Time, probe port.ProcessProbe, clock port.ProcessWaitClock) (string, error) {
	if probe == nil || clock == nil {
		return "", failure("process_dependency", false)
	}
	op, err := operationFor(ctx, until, clock)
	if err != nil {
		return "", err
	}
	observation, err := op.observe(probe, false)
	if err != nil {
		return "", err
	}
	if observation.Presence != port.ProcessPresent {
		return "", failure("process_unknown", false)
	}
	if err := op.check(false); err != nil {
		return "", err
	}
	return observation.Start, nil
}

// ConfirmIdentity consumes the sole confirmation attempt, including failures.
// The caller must obtain this witness before acknowledging readiness.
func (s *Service) ConfirmIdentity(ctx context.Context, until time.Time) error {
	if s == nil || s.session == nil {
		return failure("process_dependency", false)
	}
	p := s.session
	p.gate <- struct{}{}
	if p.confirm {
		<-p.gate
		return failure("process_consumed", false)
	}
	p.confirm = true
	<-p.gate
	op, err := operationFor(ctx, until, p.clock)
	if err != nil {
		return err
	}
	observation, err := op.observe(p.probe, false)
	if err != nil {
		return err
	}
	if observation.Presence == port.ProcessUnknown {
		return failure("process_unknown", false)
	}
	if observation.Presence != port.ProcessPresent || observation.Start != p.expected {
		return failure("process_identity", false)
	}
	if err := op.check(false); err != nil {
		return err
	}
	p.gate <- struct{}{}
	p.witness = true
	<-p.gate
	return nil
}

// WaitExit consumes one wait after successful confirmation on this service.
// The trusted caller supplies the original absolute budget; helper input policy
// (including its duration bounds) belongs to the caller, not this observation port.
func (s *Service) WaitExit(ctx context.Context, until time.Time) error {
	if s == nil || s.session == nil {
		return failure("process_dependency", false)
	}
	p := s.session
	p.gate <- struct{}{}
	if !p.witness {
		<-p.gate
		return failure("process_identity", false)
	}
	if p.wait {
		<-p.gate
		return failure("process_consumed", false)
	}
	p.wait = true
	<-p.gate
	op, err := operationFor(ctx, until, p.clock)
	if err != nil {
		return err
	}
	running := false
	for {
		observation, err := op.observe(p.probe, running)
		if err != nil {
			return err
		}
		switch observation.Presence {
		case port.ProcessAbsent:
			return op.check(false)
		case port.ProcessPresent:
			if observation.Start != p.expected {
				return failure("process_reused", false)
			}
		default:
			return failure("process_unknown", false)
		}
		running = true
		remaining, err := op.remaining(true)
		if err != nil {
			return err
		}
		if remaining > 100*time.Millisecond {
			remaining = 100 * time.Millisecond
		}
		err = p.clock.Sleep(ctx, remaining)
		if checkErr := op.check(err == nil); checkErr != nil {
			return checkErr
		}
		if err != nil {
			return observationError(err)
		}
	}
}

type operation struct {
	ctx     context.Context
	until   time.Time
	end     time.Time
	clock   port.ProcessWaitClock
	started bool
}

func operationFor(ctx context.Context, until time.Time, clock port.ProcessWaitClock) (*operation, error) {
	if ctx == nil || until.IsZero() {
		return nil, failure("process_input", false)
	}
	op := &operation{ctx: ctx, until: until, end: until, clock: clock}
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(op.end) {
		op.end = deadline
	}
	if err := op.check(false); err != nil {
		return nil, err
	}
	return op, nil
}

// running is allowed only between completed matching observations. In-flight
// expiry always remains unknown, even if the late result says absent or present.
func (op *operation) check(running bool) error {
	_, err := op.remaining(running)
	return err
}

func (op *operation) remaining(running bool) (time.Duration, error) {
	if err := op.ctx.Err(); err != nil {
		return 0, contextFailure(err, op.started)
	}
	now := op.clock.Now()
	if err := op.ctx.Err(); err != nil {
		return 0, contextFailure(err, op.started)
	}
	if !now.Before(op.end) {
		if running {
			return 0, failure("process_running", false)
		}
		return 0, failure("process_unknown", op.started)
	}
	return op.end.Sub(now), nil
}

func (op *operation) observe(probe port.ProcessProbe, running bool) (port.ProcessObservation, error) {
	if err := op.check(running); err != nil {
		return port.ProcessObservation{}, err
	}
	op.started = true
	observation, err := probe.Observe(op.ctx, op.until)
	if checkErr := op.check(false); checkErr != nil {
		return port.ProcessObservation{}, checkErr
	}
	if err != nil {
		return port.ProcessObservation{}, observationError(err)
	}
	if !validObservation(observation) {
		return port.ProcessObservation{}, failure("process_unknown", false)
	}
	return observation, nil
}

func observationError(err error) error {
	if errors.Is(err, context.Canceled) {
		return failure("context_cancelled", true)
	}
	var probeFailure *port.ProcessProbeFailure
	if errors.As(err, &probeFailure) && probeFailure != nil {
		switch probeFailure.Kind {
		case port.ProcessProbeUnknown, port.ProcessProbeInput:
			return failure("process_unknown", false)
		case port.ProcessProbeCanceled:
			return failure("context_cancelled", true)
		}
	}
	return failure("process_unknown", true)
}

func contextFailure(err error, started bool) error {
	if errors.Is(err, context.Canceled) {
		return failure("context_cancelled", started)
	}
	return failure("process_unknown", started)
}

func validObservation(o port.ProcessObservation) bool {
	switch o.Presence {
	case port.ProcessAbsent, port.ProcessUnknown:
		return o.Start == ""
	case port.ProcessPresent:
		return token(o.Start)
	default:
		return false
	}
}

func token(value string) bool {
	if len(value) < 1 || len(value) > 128 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

func failure(code string, uncertain bool) error {
	return &Failure{Code: code, Uncertain: uncertain}
}
