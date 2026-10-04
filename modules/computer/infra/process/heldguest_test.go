package process

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Every preflight/exec/close is a labelled private double; never call the public
// native role, real image measurement, filesystem, syscall or process constructor.
type heldBoundaryDouble struct {
	events                  *[]string
	prepares, execs, closes int
	prepareErr              error
	command                 Command
	before                  func()
}

func (b *heldBoundaryDouble) Prepare(c Command) (func() error, error) {
	b.prepares++
	*b.events = append(*b.events, "preflight")
	if b.before != nil {
		b.before()
	}
	return func() error { b.closes++; return nil }, b.prepareErr
}
func (b *heldBoundaryDouble) Exec(c Command) error {
	b.execs++
	b.command = copyCommand(c)
	*b.events = append(*b.events, "exec")
	return errors.New("fake syscall returned")
}
func TestHeldRoleDoublePreflightReadinessControlCloseThenOneExactExec(t *testing.T) {
	a, o, w, f, _, _, deadline := qualificationFixture(t)
	q, err := a.Run(context.Background(), o, w, f, deadline)
	if err != nil {
		t.Fatal(err)
	}
	release, parent := make(chan struct{}), make(chan struct{})
	close(release)
	events := []string{}
	boundary := &heldBoundaryDouble{events: &events}
	ready := func(context.Context) error { events = append(events, "ready"); return nil }
	closeControl := func() error { events = append(events, "close-control"); return nil }
	err = runHeldGuest(context.Background(), o, w, q, deadline, release, parent, ready, closeControl, boundary)
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || !failure.Unknown || !slices.Equal(events, []string{"preflight", "ready", "close-control", "exec"}) || boundary.prepares != 1 || boundary.execs != 1 || boundary.closes != 1 {
		t.Fatal("held boundary order/one attempt", events, err)
	}
	// Compare all immutable fields rather than trusting the fake syscall error.
	measured, _ := nativeCommandDigest(boundary.command)
	sealed, _ := nativeCommandDigest(o)
	if measured != sealed {
		t.Fatal("exec arguments/environment/input/scope rebound")
	}
	if err = runHeldGuest(context.Background(), o, w, q, deadline, release, parent, ready, closeControl, boundary); err == nil || boundary.prepares != 1 || boundary.execs != 1 || boundary.closes != 1 {
		t.Fatal("possible exec repeated")
	}
}
func TestHeldRoleDoubleRefusedStagesNeverExecOrReissue(t *testing.T) {
	for _, stage := range []string{"deadline", "process", "parent-before", "preflight", "expiry-before-ready", "ready", "expiry-before-release", "parent-at-release", "control-close", "expiry-after-close", "parent-after-close"} {
		t.Run(stage, func(t *testing.T) {
			a, o, w, f, probe, clock, deadline := qualificationFixture(t)
			q, err := a.Run(context.Background(), o, w, f, deadline)
			if err != nil {
				t.Fatal(err)
			}
			release, parent := make(chan struct{}), make(chan struct{})
			close(release)
			events := []string{}
			boundary := &heldBoundaryDouble{events: &events}
			readyCalls, closeCalls := 0, 0
			ready := func(context.Context) error {
				readyCalls++
				switch stage {
				case "ready":
					return errors.New("readiness ACK unknown")
				case "expiry-before-release":
					clock.value = deadline
				case "parent-at-release":
					close(parent)
				}
				return nil
			}
			closeControl := func() error {
				closeCalls++
				switch stage {
				case "control-close":
					return errors.New("control close refused")
				case "expiry-after-close":
					clock.value = deadline
				case "parent-after-close":
					close(parent)
				}
				return nil
			}
			requested := deadline
			switch stage {
			case "deadline":
				requested = deadline.Add(time.Second)
			case "process":
				probe.pid++
			case "parent-before":
				close(parent)
			case "preflight":
				boundary.prepareErr = errors.New("unqualified image")
			case "expiry-before-ready":
				boundary.before = func() { clock.value = deadline }
			}
			err = runHeldGuest(context.Background(), o, w, q, requested, release, parent, ready, closeControl, boundary)
			if err == nil || boundary.execs != 0 {
				t.Fatal("refused stage executed", stage, err)
			}
			if (stage == "deadline" || stage == "process" || stage == "parent-before") && boundary.prepares != 0 {
				t.Fatal("preflight after early refusal")
			}
			if (stage == "preflight" || stage == "expiry-before-ready") && readyCalls != 0 {
				t.Fatal("early readiness before qualified preflight")
			}
			prepares, closes := boundary.prepares, boundary.closes
			if err = runHeldGuest(context.Background(), o, w, q, deadline, release, parent, ready, closeControl, boundary); err == nil || boundary.prepares != prepares || boundary.closes != closes || boundary.execs != 0 {
				t.Fatal("refused held role reset")
			}
			_ = closeCalls
		})
	}
}
