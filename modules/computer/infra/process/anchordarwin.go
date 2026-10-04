//go:build darwin

package process

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"golang.org/x/sys/unix"
)

type selfAnchorGroup struct {
	mutex     sync.Mutex
	attempted bool
	pid       int
}

func ownAnchorGroup() (anchorStop, error) {
	pid := os.Getpid()
	if pid <= 1 || syscall.Getpgrp() != pid {
		return nil, &processsvc.NativeFailure{}
	}
	return &selfAnchorGroup{pid: pid}, nil
}
func (a *selfAnchorGroup) Stop() error {
	a.mutex.Lock()
	if a.attempted {
		a.mutex.Unlock()
		return &processsvc.NativeFailure{Unknown: true}
	}
	a.attempted = true
	a.mutex.Unlock()
	// Signal only this CURRENT live group leader's own group, including self.
	// Its identity cannot be reused while this method is executing. This is NOT
	// a post-reap numeric lookup, reconstructed PGID or fallback. One SIGKILL;
	// an escaped descendant remains unverified and never becomes terminal proof.
	if os.Getpid() != a.pid || syscall.Getpgrp() != a.pid {
		return &processsvc.NativeFailure{Unknown: true}
	}
	if syscall.Kill(-a.pid, syscall.SIGKILL) != nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	return nil // request acceptance only, not cohort settlement
}

type darwinTrackedGuest struct {
	command  *exec.Cmd
	queue    int
	pid      uint64
	ctx      context.Context
	waited   bool
	mutex    sync.Mutex
	closed   bool
	closeErr error
}

func observeHeld(ctx context.Context, cmd *exec.Cmd, gate HeldGate) (trackedGuest, error) {
	if ctx == nil || ctx.Err() != nil || cmd == nil || cmd.Process == nil || cmd.ProcessState != nil || cmd.WaitDelay <= 0 || cmd.WaitDelay > time.Second || cmd.Cancel != nil || gate == nil {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	if err := gate.Ready(ctx); err != nil {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	unix.CloseOnExec(queue)
	pid := uint64(cmd.Process.Pid) // exactly retained, still-held child; no lookup
	change := unix.Kevent_t{Ident: pid, Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_CLEAR | unix.EV_RECEIPT, Fflags: unix.NOTE_EXIT | unix.NOTE_EXEC | unix.NOTE_FORK}
	var receipt [1]unix.Kevent_t
	n, err := unix.Kevent(queue, []unix.Kevent_t{change}, receipt[:], nil)
	if err != nil || n != 1 || receipt[0].Ident != pid || receipt[0].Filter != unix.EVFILT_PROC || receipt[0].Flags&unix.EV_ERROR == 0 || receipt[0].Data != 0 {
		unix.Close(queue)
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	// Excludes a stale/reused identifier registered after unexpected child death.
	// Root's common transport must verify this response comes from that SAME held
	// executable, operation and image, still before its selected-command release.
	if err := gate.Ready(ctx); err != nil {
		unix.Close(queue)
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	return &darwinTrackedGuest{command: cmd, queue: queue, pid: pid, ctx: ctx}, nil
}

func (g *darwinTrackedGuest) Wait() (AnchorReport, error) {
	g.mutex.Lock()
	if g.waited || g.closed {
		g.mutex.Unlock()
		return AnchorReport{}, &processsvc.NativeFailure{Unknown: true}
	}
	g.waited = true
	g.mutex.Unlock()
	defer g.Close()
	var report AnchorReport
	for !report.KernelExit {
		if g.ctx.Err() != nil {
			return report, &processsvc.NativeFailure{Unknown: true}
		}
		var events [1]unix.Kevent_t
		duration := 100 * time.Millisecond
		if deadline, ok := g.ctx.Deadline(); ok && time.Until(deadline) < duration {
			duration = time.Until(deadline)
		}
		if duration <= 0 {
			return report, &processsvc.NativeFailure{Unknown: true}
		}
		timeout := unix.NsecToTimespec(duration.Nanoseconds())
		g.mutex.Lock()
		if g.closed {
			g.mutex.Unlock()
			return report, &processsvc.NativeFailure{Unknown: true}
		}
		n, err := unix.Kevent(g.queue, nil, events[:], &timeout)
		g.mutex.Unlock()
		if err != nil {
			return report, &processsvc.NativeFailure{Unknown: true}
		}
		if n == 0 {
			continue
		} // retained-listener wait only, not a PID probe or new attempt
		if n != 1 || events[0].Ident != g.pid || events[0].Filter != unix.EVFILT_PROC || events[0].Flags&unix.EV_ERROR != 0 {
			return report, &processsvc.NativeFailure{Unknown: true}
		}
		if events[0].Fflags&unix.NOTE_FORK != 0 {
			report.ForkObserved = true
		}
		if events[0].Fflags&unix.NOTE_EXEC != 0 {
			report.ExecObserved = true
		}
		if events[0].Fflags&unix.NOTE_EXIT != 0 {
			report.KernelExit = true
		}
		if report.ForkObserved {
			return report, &processsvc.NativeFailure{Unknown: true}
		}
	}
	// Wait once AFTER exact kernel exit observation; never look up identity again.
	err := g.command.Wait()
	if g.command.ProcessState == nil {
		return report, &processsvc.NativeFailure{Unknown: true}
	}
	details := exitDetails(g.command.ProcessState)
	report.RootWaited, report.ExitCode, report.ExitSignal = details.Waited, details.Code, details.Signal
	// os/exec may prefer ExitError over an IO/WaitDelay error. Never infer
	// successful drain from that class. Nonzero/signal exit needs independent
	// EOF evidence from root before it could qualify, and stays unknown here.
	report.OutputDrained = err == nil
	return report, nil
}

func (g *darwinTrackedGuest) Close() error {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	if !g.closed {
		g.closed = true
		g.closeErr = unix.Close(g.queue)
	}
	return g.closeErr
}
