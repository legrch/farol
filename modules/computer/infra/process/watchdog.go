package process

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

const watchdogMode = "go-prepared-v1"

// WatchdogSelection is trusted root input, never a request or native certificate.
// Source is the SAME SHELL_WATCHDOG_SOURCE resource, independently pinned by root.
// The helper supervises one already confined command; it owns no admission,
// policy, journal or public handle registry. Its image/source join the intent seal.
type WatchdogSelection struct {
	Executable   ExecutablePin
	Source       []byte
	SourceSHA256 string
}

type SupervisedPreparer struct {
	mutex    sync.Mutex
	base     *Preparer
	boundary *watchdogBoundary
	selected *watchdogSelected
}

type watchdogSelected struct {
	*Prepared
	policy *Seatbelt
	seal   processsvc.Seal
}

func (s *watchdogSelected) Seal() processsvc.Seal { return s.seal }
func (s *watchdogSelected) MatchesPolicy(snapshot port.AccessSnapshot) bool {
	return s.policy.matchesPolicy(s.command, snapshot)
}

// NewSupervisedPreparer executes nothing. The actual Seatbelt producer, native
// measurement and independent Qualification remain mandatory at Spawn. Root
// supplies a retained backend/execution lifetime, not one MCP response context.
// No automatic route can select this adapter after another operation is unknown.
func NewSupervisedPreparer(runtimeID string, template Command, policy *Seatbelt, selection WatchdogSelection, execution context.Context, clock port.Clock) (*SupervisedPreparer, error) {
	if policy == nil || policy.qualification == nil || execution == nil || execution.Err() != nil ||
		!absolutePolicyPath(selection.Executable.Path) || !digestValue(selection.Executable.SHA256) ||
		len(selection.Source) == 0 || len(selection.Source) > 64*1024 || !utf8.Valid(selection.Source) || !digestValue(selection.SourceSHA256) {
		return nil, &processsvc.NativeFailure{}
	}
	hash := sha256.Sum256(selection.Source)
	if hex.EncodeToString(hash[:]) != selection.SourceSHA256 {
		return nil, &processsvc.NativeFailure{}
	}
	base, err := NewPreparer(runtimeID, template, policy, clock)
	if err != nil {
		return nil, err
	}
	selection.Source = append([]byte(nil), selection.Source...)
	return &SupervisedPreparer{base: base, boundary: &watchdogBoundary{policy: policy, selection: selection, execution: execution, clock: clock, measure: measureLaunch, host: nativeWatchdogHost{}}}, nil
}

func (p *SupervisedPreparer) Scope() processsvc.Scope { return p.base.Scope() }
func (p *SupervisedPreparer) MatchesPolicy(snapshot port.AccessSnapshot) bool {
	return p.base.MatchesPolicy(snapshot)
}
func (p *SupervisedPreparer) Prepare(ctx context.Context, invocation processsvc.Invocation) (processsvc.Selected, error) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	prepared, err := p.base.Prepare(ctx, invocation)
	if err != nil {
		return nil, err
	}
	native := prepared.(*Prepared)
	for _, value := range append(append([]string(nil), native.command.Args...), native.command.Environment...) {
		if !utf8.ValidString(value) {
			return nil, &processsvc.NativeFailure{}
		}
	}
	encoded, err := json.Marshal(struct {
		CommandSHA256, Mode, SourceSHA256 string
		Executable                        ExecutablePin
	}{native.Seal().Digest, watchdogMode, p.boundary.selection.SourceSHA256, p.boundary.selection.Executable})
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	digest := sha256.Sum256(encoded)
	seal := native.Seal()
	seal.Digest = hex.EncodeToString(digest[:])
	if p.selected != nil {
		if p.selected.seal != seal {
			return nil, &processsvc.NativeFailure{Unknown: true}
		}
		return p.selected, nil
	}
	native.boundary, native.execution = p.boundary, p.boundary.execution
	p.selected = &watchdogSelected{Prepared: native, policy: p.boundary.policy, seal: seal}
	return p.selected, nil
}

// RetainedHandle is cleanup correlation only, including possible-start unknown.
// It never grants output access, reconstructs a PID or resets the selected Spawn.
func (p *SupervisedPreparer) RetainedHandle() string {
	p.mutex.Lock()
	selected := p.selected
	p.mutex.Unlock()
	if selected == nil {
		return ""
	}
	selected.mutex.Lock()
	defer selected.mutex.Unlock()
	if selected.retained == nil {
		return ""
	}
	return selected.retained.Handle()
}

type watchdogProcess interface {
	// Wait is called exactly once on the retained helper. It is NOT command Wait
	// or group/descendant settlement; command exit comes only from its private IPC.
	Wait() error
}
type watchdogChannel interface {
	io.ReadWriteCloser
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}
type watchdogHost interface {
	Start(context.Context, WatchdogSelection, string) (watchdogProcess, watchdogChannel, error)
}
type watchdogBoundary struct {
	policy    *Seatbelt
	selection WatchdogSelection
	execution context.Context
	clock     port.Clock
	measure   func(context.Context, Command, *confinedLaunch) (func(), error)
	host      watchdogHost
}

func (*watchdogBoundary) Start(context.Context, Command, func(context.Context) error, io.Writer, io.Writer) (owned, error) {
	return nil, &processsvc.NativeFailure{} // Only the original lease can select time.
}
func (b *watchdogBoundary) StartLease(ctx context.Context, command Command, request processsvc.SpawnRequest, stdout, stderr io.Writer) (owned, error) {
	if ctx == nil || ctx.Err() != nil || request.Check == nil || stdout == nil || stderr == nil || b.execution.Err() != nil ||
		!b.clock.Now().Before(request.Deadline) || request.Deadline.After(b.clock.Now().Add(15*time.Second)) {
		return nil, &processsvc.NativeFailure{}
	}
	launch, err := selectedLaunch(b.policy, command)
	if err != nil {
		return nil, err
	}
	id, err := nativeCommandDigest(command) // Immutable invocation on its exact private channel.
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	bounded, cancel := context.WithDeadline(b.execution, request.Deadline)
	check := func() error {
		if ctx.Err() != nil || bounded.Err() != nil || !b.clock.Now().Before(request.Deadline) || request.Check(bounded) != nil {
			return &processsvc.NativeFailure{}
		}
		return nil
	}
	closeMeasurement, err := b.measure(bounded, copyCommand(command), launch)
	if closeMeasurement != nil {
		defer closeMeasurement()
	}
	if err != nil || closeMeasurement == nil || launch.qualification.Qualify(bounded, copyCommand(launch.command)) != nil || check() != nil {
		cancel()
		return nil, &processsvc.NativeFailure{}
	}
	process, channel, startErr := b.host.Start(bounded, b.selection, command.Cwd)
	if process == nil {
		cancel()
		if channel != nil {
			channel.Close()
		}
		var failure *processsvc.NativeFailure
		if errors.As(startErr, &failure) && !failure.Unknown {
			return nil, failure // Known preflight refusal, before helper Start.
		}
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	child := newWatchdogChild(process, channel, request.Deadline, b.clock, stdout, stderr)
	child.cancel = cancel
	if startErr != nil || channel == nil {
		child.fence()
		close(child.done) // No receiver was started on this possible-start failure.
		return child, &processsvc.NativeFailure{Unknown: true}
	}
	child.id = id
	go child.receive()
	go func() {
		select {
		case <-bounded.Done():
			child.fence() // Closing this exact IPC requests the helper's one stop.
		case <-child.done:
		}
	}()
	prepare := watchdogPrepare{Type: "prepare", ID: id, Executable: launch.command.Executable, Args: launch.command.Args, Cwd: command.Cwd,
		Environment: map[string]string{}, Stdin: base64.StdEncoding.EncodeToString(command.Input), Deadline: request.Deadline.UnixMilli()}
	for _, entry := range command.Environment {
		name, value, _ := strings.Cut(entry, "=")
		prepare.Environment[name] = value
	}
	if child.send(bounded, prepare) != nil || child.await(bounded, child.prepared) != nil ||
		launch.qualification.Qualify(bounded, copyCommand(launch.command)) != nil || check() != nil ||
		child.send(bounded, watchdogControl{Type: "start", ID: id}) != nil || child.await(bounded, child.ready) != nil {
		child.fence()
		return child, &processsvc.NativeFailure{Unknown: true}
	}
	return child, nil
}

var _ processsvc.InvocationPreparer = (*SupervisedPreparer)(nil)
var _ processsvc.PolicyBound = (*SupervisedPreparer)(nil)
var _ processsvc.Selected = (*watchdogSelected)(nil)
var _ processsvc.PolicyBound = (*watchdogSelected)(nil)
var _ leaseBoundary = (*watchdogBoundary)(nil)
