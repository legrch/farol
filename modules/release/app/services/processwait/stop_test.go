package processwait_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/app/services/processwait"
)

type terminator struct {
	sent []port.ProcessSignal
	on   func(port.ProcessSignal) error
}

func (t *terminator) Signal(_ context.Context, s port.ProcessSignal) error {
	t.sent = append(t.sent, s)
	if t.on != nil {
		return t.on(s)
	}
	return nil
}

// stuck returns a confirmed service whose sole wait ended at its deadline with
// the identified process still running, plus a switch that later makes it exit.
func stuck(t *testing.T, gone func() bool) (*processwait.Service, *clock) {
	t.Helper()
	c := &clock{now: epoch}
	probe := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		if gone != nil && gone() {
			return absent(), nil
		}
		return present(birth), nil
	})
	s := confirmed(t, probe, c)
	checkFailure(t, s.WaitExit(context.Background(), epoch.Add(500*time.Millisecond)), "process_running", false)
	return s, c
}

func terminate(s *processwait.Service, until time.Time, term port.ProcessTerminator) error {
	_, err := s.Terminate(context.Background(), processwait.TerminateCommand{Until: until, Terminator: term})
	return err
}

func TestTerminateSendsTermFirstAndStopsOnObservedExit(t *testing.T) {
	var exited bool
	s, c := stuck(t, func() bool { return exited })
	term := &terminator{on: func(s port.ProcessSignal) error {
		if s == port.ProcessSignalTerminate {
			exited = true
		}
		return nil
	}}
	if err := terminate(s, c.Now().Add(10*time.Second), term); err != nil {
		t.Fatal(err)
	}
	if len(term.sent) != 1 || term.sent[0] != port.ProcessSignalTerminate {
		t.Fatal("signals", term.sent)
	}
}

func TestTerminateEscalatesToKillWhenTermIsIgnored(t *testing.T) {
	var exited bool
	s, c := stuck(t, func() bool { return exited })
	term := &terminator{on: func(s port.ProcessSignal) error {
		if s == port.ProcessSignalKill {
			exited = true
		}
		return nil
	}}
	if err := terminate(s, c.Now().Add(10*time.Second), term); err != nil {
		t.Fatal(err)
	}
	if len(term.sent) != 2 || term.sent[0] != port.ProcessSignalTerminate || term.sent[1] != port.ProcessSignalKill {
		t.Fatal("signals", term.sent)
	}
}

func TestTerminateNeverSignalsAReusedPID(t *testing.T) {
	c := &clock{now: epoch}
	var reused bool
	probe := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		if reused {
			return present("Thu Oct 15 12:35:00 2026"), nil
		}
		return present(birth), nil
	})
	s := confirmed(t, probe, c)
	checkFailure(t, s.WaitExit(context.Background(), epoch.Add(500*time.Millisecond)), "process_running", false)
	reused = true
	term := &terminator{}
	checkFailure(t, terminate(s, c.Now().Add(10*time.Second), term), "process_reused", false)
	if len(term.sent) != 0 {
		t.Fatal("signalled a reused PID", term.sent)
	}
}

func TestTerminateRequiresARunningDeadlineAndIsOneShot(t *testing.T) {
	c := &clock{now: epoch}
	// Exited during the wait: nothing to finish.
	s := confirmed(t, probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { return absent(), nil }), c)
	if err := s.WaitExit(context.Background(), epoch.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	term := &terminator{}
	checkFailure(t, terminate(s, epoch.Add(10*time.Second), term), "process_identity", false)
	// Never waited.
	s = confirmed(t, probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { return present(birth), nil }), c)
	checkFailure(t, terminate(s, epoch.Add(10*time.Second), term), "process_identity", false)
	if len(term.sent) != 0 {
		t.Fatal("signalled without a running deadline", term.sent)
	}
	// Second attempt is consumed even after a failure.
	stuckSvc, sc := stuck(t, nil)
	failing := &terminator{on: func(port.ProcessSignal) error { return errors.New("eperm") }}
	checkFailure(t, terminate(stuckSvc, sc.Now().Add(10*time.Second), failing), "process_signal", true)
	checkFailure(t, terminate(stuckSvc, sc.Now().Add(10*time.Second), &terminator{}), "process_consumed", false)
}

func TestTerminateThatNeverObservesExitStaysRunningAndUncertain(t *testing.T) {
	s, c := stuck(t, nil)
	term := &terminator{}
	checkFailure(t, terminate(s, c.Now().Add(2*time.Second), term), "process_running", true)
	if len(term.sent) != 2 {
		t.Fatal("signals", term.sent)
	}
}
