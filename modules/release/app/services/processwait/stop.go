package processwait

import (
	"context"
	"errors"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// Terminate finishes a predecessor that already recorded a drained Quit but
// did not exit by the wait deadline. It is admitted once, only after WaitExit
// returned process_running for this same session. Before each signal it
// re-observes the bound PID and requires the exact confirmed start token; a
// different token is reuse and stops without signalling. It returns nil only
// after a positively observed absence. The terminator re-checks the kernel
// executable path itself.
func (s *Service) Terminate(ctx context.Context, cmd TerminateCommand) (*TerminateResult, error) {
	sent, err := s.terminate(ctx, cmd.Until, cmd.Terminator)
	if err != nil {
		return nil, err
	}
	return &TerminateResult{Signals: sent}, nil
}

// TerminateCommand carries the absolute finish bound and the terminator that
// trusted composition bound to the same PID and installed slot.
type TerminateCommand struct {
	Until      time.Time
	Terminator port.ProcessTerminator
}

// TerminateResult reports how many signals preceded the observed exit.
type TerminateResult struct{ Signals int }

func (s *Service) terminate(ctx context.Context, until time.Time, term port.ProcessTerminator) (int, error) {
	if s == nil || s.session == nil || term == nil {
		return 0, failure("process_dependency", false)
	}
	p := s.session
	p.gate <- struct{}{}
	if !p.running {
		<-p.gate
		return 0, failure("process_identity", false)
	}
	if p.terminate {
		<-p.gate
		return 0, failure("process_consumed", false)
	}
	p.terminate = true
	<-p.gate
	if ctx == nil || until.IsZero() {
		return 0, failure("process_input", false)
	}
	sent := 0
	now := p.clock.Now()
	if !now.Before(until) {
		return 0, failure("process_running", false)
	}
	// Half the bound for SIGTERM, the rest for SIGKILL and the final exit.
	soft := now.Add(until.Sub(now) / 2)
	for _, step := range []struct {
		signal port.ProcessSignal
		until  time.Time
	}{{port.ProcessSignalTerminate, soft}, {port.ProcessSignalKill, until}} {
		gone, err := p.identified(ctx, step.until)
		if err != nil || gone {
			return sent, err
		}
		sent++
		if err := term.Signal(ctx, step.signal); err != nil {
			// The signal may have been delivered; nothing after it is a refusal.
			return sent, failure("process_signal", true)
		}
		err = p.waitAbsent(ctx, step.until)
		var f *Failure
		if err == nil || !errors.As(err, &f) || f.Code != "process_running" || f.Uncertain {
			return sent, err
		}
	}
	return sent, failure("process_running", true)
}

// identified observes the bound PID once: absent reports gone, the exact
// start token permits a signal, anything else refuses it.
func (p *session) identified(ctx context.Context, until time.Time) (bool, error) {
	op, err := operationFor(ctx, until, p.clock)
	if err != nil {
		return false, err
	}
	observation, err := op.observe(p.probe, false)
	if err != nil {
		return false, err
	}
	switch observation.Presence {
	case port.ProcessAbsent:
		return true, op.check(false)
	case port.ProcessPresent:
		if observation.Start != p.expected {
			return false, failure("process_reused", false)
		}
		return false, op.check(false)
	default:
		return false, failure("process_unknown", false)
	}
}

// Stopper adapts this service's one Terminate attempt to the handoff owner,
// which binds the terminator to the same PID and installed slot.
func Stopper(s *Service) func(port.ProcessTerminator) port.ProcessStopper {
	return func(term port.ProcessTerminator) port.ProcessStopper { return stopper{s, term} }
}

type stopper struct {
	s    *Service
	term port.ProcessTerminator
}

func (p stopper) Stop(ctx context.Context, until time.Time) error {
	_, err := p.s.Terminate(ctx, TerminateCommand{Until: until, Terminator: p.term})
	return err
}
