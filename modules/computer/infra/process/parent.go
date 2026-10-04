package process

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// These are trusted composition ports over Lead's EXISTING common role transport.
// Root validates unknown frames and exact build/profile/backend/incarnation before
// returning a known correlated receipt/ACK. No codec or authority is defined here.
type AnchorLaunch struct {
	OperationID, SealDigest string
	Original, Wrapped       Command
	Deadline                time.Time
}
type AnchorReceipt struct {
	OperationID, SealDigest string
	Report                  AnchorReport
}

// Receive returns one known root-validated receipt. It must honor context expiry;
// Close is concurrency-safe with Receive/RequestStop and releases retained IO.
// Root retains exclusive owning Cmd use; no other waiter or automatic canceller.
type AnchorLink interface {
	Receive(context.Context) (*AnchorReceipt, error)
	RequestStop(context.Context) error
	Close() error
}

// StartAnchor starts the same pinned Go image's fresh private anchor role once.
// Check is SAME admitted current-owner guard, used before start and held release
// outside owner/app gates. Return the exact retained Cmd/link on possible start,
// even when ACK is uncertain. No CommandContext, new deadline or fallback.
type AnchorBootstrap interface {
	StartAnchor(context.Context, AnchorLaunch, func(context.Context) error, io.Writer, io.Writer) (*exec.Cmd, AnchorLink, error)
}
type leaseBoundary interface {
	StartLease(context.Context, Command, processsvc.SpawnRequest, io.Writer, io.Writer) (owned, error)
}
type anchorWait func(*exec.Cmd) (exit, error)
type parentBoundary struct {
	operationID string
	policy      *Seatbelt
	bootstrap   AnchorBootstrap
	execution   context.Context
	clock       port.Clock
	wait        anchorWait
}

// NewAnchoredPreparer executes nothing. Root supplies the already selected
// execution-owner/backend lifetime, never one outer turn or MCP response context.
// The original deadline is supplied ONLY by the SAME service at Spawn.
func NewAnchoredPreparer(operationID, runtimeID string, template Command, policy *Seatbelt, bootstrap AnchorBootstrap, execution context.Context, clock port.Clock) (*Preparer, error) {
	if !bindingID(operationID) || policy == nil || bootstrap == nil || execution == nil || execution.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	p, err := NewPreparer(runtimeID, template, policy, clock)
	if err != nil {
		return nil, err
	}
	p.anchor = &parentBoundary{operationID: operationID, policy: policy, bootstrap: bootstrap, execution: execution, clock: clock, wait: waitAnchor}
	return p, nil
}

// Start is intentionally unavailable: the original SpawnRequest deadline cannot
// be fabricated from now or an outer grant. Prepared selects StartLease explicitly.
func (p *parentBoundary) Start(context.Context, Command, func(context.Context) error, io.Writer, io.Writer) (owned, error) {
	return nil, &processsvc.NativeFailure{}
}
func (p *parentBoundary) StartLease(ctx context.Context, command Command, request processsvc.SpawnRequest, out, diagnostic io.Writer) (owned, error) {
	if ctx == nil || ctx.Err() != nil || request.Check == nil || p.execution.Err() != nil || !p.clock.Now().Before(request.Deadline) || request.Deadline.After(p.clock.Now().Add(authority.OrdinaryExecutionLifetime)) {
		return nil, &processsvc.NativeFailure{}
	}
	launch, err := selectedLaunch(p.policy, command)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	digest, err := nativeCommandDigest(command)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	originalDeadline := request.Deadline
	// Root uses this closure for the actual adjacent current check before release.
	// It cannot reset expiry after preparation or reissue on a reconnect.
	check := func(c context.Context) error {
		if c == nil || c.Err() != nil || p.execution.Err() != nil || !p.clock.Now().Before(originalDeadline) {
			return &processsvc.NativeFailure{}
		}
		if request.Check(c) != nil || c.Err() != nil || p.execution.Err() != nil || !p.clock.Now().Before(originalDeadline) {
			return &processsvc.NativeFailure{}
		}
		return nil
	}
	if check(p.execution) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	bounded, cancel := context.WithDeadline(p.execution, originalDeadline)
	cmd, link, startErr := p.bootstrap.StartAnchor(bounded, AnchorLaunch{p.operationID, digest, copyCommand(command), copyCommand(launch.command), originalDeadline}, check, out, diagnostic)
	if cmd == nil {
		cancel()
		if link != nil {
			link.Close()
		}
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	child := &parentChild{cmd: cmd, link: link, operationID: p.operationID, digest: digest, ctx: bounded, cancel: cancel, control: p.execution, wait: p.wait, check: check, uncertain: startErr != nil || link == nil}
	if child.uncertain {
		return child, &processsvc.NativeFailure{Unknown: true}
	}
	return child, nil
}

type parentChild struct {
	mutex                         sync.Mutex
	cmd                           *exec.Cmd
	link                          AnchorLink
	operationID, digest           string
	ctx, control                  context.Context
	cancel                        context.CancelFunc
	wait                          anchorWait
	check                         func(context.Context) error
	attempted, stopped, uncertain bool
}

func (p *parentChild) Kill() error {
	p.mutex.Lock()
	if p.stopped {
		p.mutex.Unlock()
		return &processsvc.NativeFailure{Unknown: true}
	}
	p.stopped = true
	p.uncertain = true // stop intent/ACK never proves closure
	link := p.link
	p.mutex.Unlock()
	if link == nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	// Cleanup is allowed on this retained resource after lease expiry. This context
	// does not renew command/output permission; it bounds one control request only.
	bounded, cancel := context.WithTimeout(context.WithoutCancel(p.control), time.Second)
	defer cancel()
	if link.RequestStop(bounded) != nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	return nil
}
func (p *parentChild) Wait() (exit, error) {
	p.mutex.Lock()
	if p.attempted {
		p.mutex.Unlock()
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	p.attempted = true
	p.mutex.Unlock()
	defer p.cancel()
	if p.link != nil {
		defer p.link.Close()
	}
	type received struct {
		receipt *AnchorReceipt
		err     error
	}
	result := make(chan received, 1)
	go func() {
		if p.link == nil {
			result <- received{nil, &processsvc.NativeFailure{Unknown: true}}
			return
		}
		r, e := p.link.Receive(p.ctx)
		result <- received{r, e}
	}()
	// Actual owning Cmd Wait occurs once, independently of a root receipt/boolean.
	anchor, waitErr := p.wait(p.cmd)
	var got received
	select {
	case got = <-result:
	case <-p.ctx.Done():
		got.err = &processsvc.NativeFailure{Unknown: true}
	}
	p.mutex.Lock()
	uncertain := p.uncertain || p.stopped
	p.mutex.Unlock()
	if uncertain || waitErr != nil || !anchor.Waited || !anchor.Drained || anchor.Code == nil || *anchor.Code != 0 || anchor.Signal != 0 || got.err != nil || got.receipt == nil || got.receipt.OperationID != p.operationID || got.receipt.SealDigest != p.digest {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	report := got.receipt.Report
	if !report.GuestCohortClosed || !closedGuest(report) || p.check(p.ctx) != nil {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	// This conjunction is only the existing restricted qualified no-fork route.
	// It does not promote a direct-child Wait or broad/arbitrary-tree fixture.
	return exit{Code: copyCode(report.ExitCode), Signal: report.ExitSignal, Waited: true, Drained: true, cohort: true}, nil
}
func copyCode(code *int) *int {
	if code == nil {
		return nil
	}
	copy := *code
	return &copy
}
