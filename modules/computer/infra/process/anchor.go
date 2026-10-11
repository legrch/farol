package process

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// HeldGate is implemented by root over the EXISTING common transport. It owns
// exact child/build/profile/operation correlation and one release. Ready is an
// actual same-child round trip, not an input echo/startup-cache acknowledgement.
// No private wire encoding, task engine, authority or journal is defined here.
type HeldGate interface {
	Ready(context.Context) error
	Release(context.Context) error
	Close() error
}

// HeldBootstrap starts a held role of the SAME pinned Go executable, under the
// exact selected Seatbelt plan, once. Guest stdin/output remain distinct from
// control. The child joins this anchor's private group and can neither run the
// selected command nor fork before Release. Root owns the role/schema adapter.
// Set Cmd.WaitDelay before Start to a positive value at most one second. Do not
// use CommandContext (even with Cancel=nil), automatic cancellation or another
// child group. Writers must be bounded nonblocking retained output collectors,
// not a provider/transport callback whose Write can hang after pipe close.
// A possible start returns the exact retained Cmd even on an uncertain ACK.
type HeldBootstrap interface {
	StartHeld(context.Context, Command, io.Writer, io.Writer) (*exec.Cmd, HeldGate, error)
}

// Cancel is the EXISTING execution authority loss/owner stop signal. Outer
// TaskGrant expiry/reissue alone neither extends nor cancels an admitted lease.
// ctx/ParentGone belong to retained backend/anchor control, not one outer turn
// or MCP request/response. Connector reconnect alone cannot cancel that lease.
// ParentGone is the existing exact parent-control lifetime, not a PID poll.
type AnchorControl struct{ ParentGone, Cancel <-chan struct{} }

// GuestCohortClosed excludes the still-live anchor. It is only candidate native
// evidence for the qualified no-fork trace; root owns whole-operation terminal.
type AnchorReport struct {
	RootWaited, OutputDrained, KernelExit, ExecObserved, ForkObserved bool
	ExitCode                                                          *int
	ExitSignal                                                        int
	GuestCohortClosed                                                 bool
	StopRequested, StopUnverified                                     bool
}

// Publish is root's typed common-transport result publication, not durable result
// ACK. Parent must independently Wait the exact anchor and validate correlation.
type AnchorReporter interface {
	Publish(context.Context, AnchorReport) error
}

type trackedGuest interface {
	Wait() (AnchorReport, error)
	Close() error
}
type anchorStop interface{ Stop() error }
type anchorWatch func(context.Context, *exec.Cmd, HeldGate) (trackedGuest, error)

type Anchor struct {
	mutex     sync.Mutex
	attempted bool
	bootstrap HeldBootstrap
	reporter  AnchorReporter
	stop      anchorStop
	watch     anchorWatch
	clock     port.Clock
}

// NewAnchor belongs ONLY to root's fresh private group-leader role. It performs
// self identity inspection, never a lookup of an old resource. Native execution
// is a separate authorized lane. CPU tests inject all private native boundaries.
func NewAnchor(bootstrap HeldBootstrap, reporter AnchorReporter, clock port.Clock) (*Anchor, error) {
	if bootstrap == nil || reporter == nil || clock == nil {
		return nil, &processsvc.NativeFailure{}
	}
	stop, err := ownAnchorGroup()
	if err != nil {
		return nil, err
	}
	return &Anchor{bootstrap: bootstrap, reporter: reporter, stop: stop, watch: observeHeld, clock: clock}, nil
}

// Run owns one guest, its fixed original deadline and one cleanup request. It
// is a native execution primitive, not Task lifecycle/scheduling. Parent EOF,
// cancellation and deadline share the SAME live-anchor group stop. No escalation,
// PID lookup, successor, alternative executor or second signal follows refusal.
func (a *Anchor) Run(ctx context.Context, command Command, deadline time.Time, control AnchorControl, check func(context.Context) error, stdout, stderr io.Writer) (*AnchorReport, error) {
	a.mutex.Lock()
	if a.attempted {
		a.mutex.Unlock()
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	a.attempted = true
	a.mutex.Unlock()
	if ctx == nil || ctx.Err() != nil || check == nil || a.clock == nil || a.bootstrap == nil || a.reporter == nil || a.stop == nil || a.watch == nil ||
		control.ParentGone == nil || control.Cancel == nil || stdout == nil || stderr == nil || !validCommand(command) || command.Confinement == nil || command.Binding == nil ||
		!a.clock.Now().Before(deadline) || deadline.After(a.clock.Now().Add(15*time.Second)) {
		return nil, &processsvc.NativeFailure{}
	}
	bounded, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	select {
	case <-control.ParentGone:
		return nil, &processsvc.NativeFailure{}
	case <-control.Cancel:
		return nil, &processsvc.NativeFailure{}
	default:
	}
	if check(bounded) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	cmd, gate, err := a.bootstrap.StartHeld(bounded, copyCommand(command), &drainWitness{writer: stdout}, &drainWitness{writer: stderr})
	if gate != nil {
		defer gate.Close()
	}
	published := false
	stop := func(report AnchorReport) (*AnchorReport, error) {
		report.GuestCohortClosed = false
		report.StopRequested, report.StopUnverified = true, true
		// Publish intent BEFORE self-group SIGKILL. Neither publication nor accepted
		// signal proves cleanup. Exact anchor terminal remains parent-owned evidence.
		if !published {
			published = true
			a.reporter.Publish(bounded, report)
		}
		a.stop.Stop()
		return &report, &processsvc.NativeFailure{Unknown: true}
	}
	if err != nil || cmd == nil || gate == nil {
		return stop(AnchorReport{})
	}
	guest, err := a.watch(bounded, cmd, gate)
	if err != nil || guest == nil {
		return stop(AnchorReport{})
	}
	defer guest.Close()
	select {
	case <-control.ParentGone:
		return stop(AnchorReport{})
	case <-control.Cancel:
		return stop(AnchorReport{})
	default:
	}
	if bounded.Err() != nil || !a.clock.Now().Before(deadline) || check(bounded) != nil {
		return stop(AnchorReport{})
	}
	// The listener and second same-child readiness barrier precede this one
	// release. No callback can dispatch/re-admit while holding an authority gate.
	if err := gate.Release(bounded); err != nil {
		return stop(AnchorReport{})
	}
	type observation struct {
		report AnchorReport
		err    error
	}
	settled := make(chan observation, 1)
	go func() { report, err := guest.Wait(); settled <- observation{report, err} }()
	select {
	case <-control.ParentGone:
		return stop(AnchorReport{})
	case <-control.Cancel:
		return stop(AnchorReport{})
	case <-bounded.Done():
		return stop(AnchorReport{})
	case observed := <-settled:
		if observed.err != nil || !closedGuest(observed.report) {
			return stop(observed.report)
		}
		select {
		case <-control.ParentGone:
			return stop(observed.report)
		case <-control.Cancel:
			return stop(observed.report)
		default:
		}
		if bounded.Err() != nil || !a.clock.Now().Before(deadline) || check(bounded) != nil {
			return stop(observed.report)
		}
		// This closes only the observed guest cohort. The anchor is still alive.
		// Root cannot map whole-operation cleanup until its exact anchor Wait/drain.
		observed.report.GuestCohortClosed = true
		published = true
		if err := a.reporter.Publish(bounded, observed.report); err != nil {
			return stop(observed.report)
		}
		return &observed.report, nil
	}
}

func closedGuest(report AnchorReport) bool {
	return report.RootWaited && report.OutputDrained && report.KernelExit && report.ExecObserved && !report.ForkObserved &&
		!report.StopRequested && !report.StopUnverified && ((report.ExitCode != nil && *report.ExitCode >= 0 && *report.ExitCode <= 255 && report.ExitSignal == 0) ||
		(report.ExitCode == nil && report.ExitSignal > 0 && report.ExitSignal <= 128))
}
