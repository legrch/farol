package boot

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

const heldReadyMethod = "computer.process.held.ready"
const heldReleaseMethod = "computer.process.held.release"

func heldFailure() error { return &processsvc.NativeFailure{Unknown: true} }

func heldDeadline(identity wire.ComputerHeldIdentity, clock computerport.Clock) (time.Time, error) {
	if clock == nil || identity.BuildId != BuildID || identity.ChildLaunchId == identity.AnchorLifetimeId || validateIngress("ComputerHeldIdentity", identity) != nil {
		return time.Time{}, heldFailure()
	}
	deadline, err := time.Parse(time.RFC3339Nano, identity.Deadline)
	now := clock.Now()
	if err != nil || !now.Before(deadline) || deadline.After(now.Add(15*time.Second)) {
		return time.Time{}, heldFailure()
	}
	return deadline, nil
}

// processHeldControl is root's adapter for the actual held-role readiness
// barriers. Its identity is selected through trusted inherited launch input;
// neither a handshake nor an incoming body selects/replaces that identity.
// It creates no native process, qualification, journal or execution authority.
type processHeldControl struct {
	mu            sync.Mutex
	identity      wire.ComputerHeldIdentity
	deadline      time.Time
	clock         computerport.Clock
	prepared      chan struct{}
	release       chan struct{}
	ready         bool
	barrier       uint32
	pending       string
	released      bool
	fenced        bool
	serverCreated bool
}

func newProcessHeldControl(identity wire.ComputerHeldIdentity, clock computerport.Clock) (*processHeldControl, error) {
	deadline, err := heldDeadline(identity, clock)
	if err != nil {
		return nil, err
	}
	return &processHeldControl{identity: identity, deadline: deadline, clock: clock, prepared: make(chan struct{}), release: make(chan struct{})}, nil
}

// Prepared is passed only as RunHeldGuest's readiness callback, after its
// same-process qualification/preflight. Calling it supplies no native evidence.
func (s *processHeldControl) Prepared(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx == nil || ctx.Err() != nil || s.fenced || s.ready || !s.clock.Now().Before(s.deadline) {
		s.fenced = true
		return heldFailure()
	}
	s.ready = true
	close(s.prepared)
	return nil
}

func (s *processHeldControl) Server() (*desktop.Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.serverCreated || s.fenced {
		return nil, heldFailure()
	}
	s.serverCreated = true
	return desktop.New(desktop.Config{BuildID: BuildID, ProfileID: s.identity.ProfileId, Generation: s.identity.BackendGeneration, TerminalRejection: true, Methods: map[string]desktop.Method{
		heldReadyMethod: {Handle: func(ctx context.Context, req desktop.Request) (*desktop.Outcome, error) {
			return s.handle(ctx, req, false)
		}},
		heldReleaseMethod: {
			Handle: func(ctx context.Context, req desktop.Request) (*desktop.Outcome, error) {
				return s.handle(ctx, req, true)
			},
			AfterReply: s.afterRelease,
		},
	}})
}

func (s *processHeldControl) refuse() (*desktop.Outcome, error) {
	s.fenced = true
	return &desktop.Outcome{Status: "refused", Code: "process_held_control_refused"}, nil
}

func (s *processHeldControl) handle(ctx context.Context, req desktop.Request, release bool) (*desktop.Outcome, error) {
	var body wire.ComputerHeldBarrier
	if ipc.ValidateJSON(req.Body) != nil || wire.Validate("ComputerHeldBarrier", req.Body) != nil || json.Unmarshal(req.Body, &body) != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.refuse()
	}
	bounded, cancel := context.WithDeadline(ctx, s.deadline)
	defer cancel()
	select {
	case <-s.prepared:
	case <-bounded.Done():
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.refuse()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if bounded.Err() != nil || s.fenced || !s.ready || s.released || s.pending != "" || body.Identity != s.identity || !s.clock.Now().Before(s.deadline) ||
		(release && (req.OperationID != s.identity.OperationId || body.Barrier != 2 || s.barrier != 2)) ||
		(!release && (req.OperationID != "" || body.Barrier != s.barrier+1 || s.barrier >= 2)) {
		return s.refuse()
	}
	if release {
		s.pending = req.RequestID
	} else {
		s.barrier = body.Barrier
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return s.refuse()
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}

func (s *processHeldControl) afterRelease(req desktop.Request, delivered bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fenced || s.released || s.pending == "" || req.RequestID != s.pending || !delivered || !s.clock.Now().Before(s.deadline) {
		s.fenced = true
		return
	}
	// The complete ACK frame precedes release. The held role may now close its
	// control FDs before exec without racing the ACK write. This is not proof
	// that the parent read it or that any native command executed/terminated.
	s.released = true
	close(s.release)
}

// processHeldGate implements the existing native HeldGate over the same strict
// framed JSON-RPC and generated schema as other local Go channels. Every pipe
// belongs to this exact held child; no discovery, reconnect or replay exists.
type processHeldGate struct {
	identity wire.ComputerHeldIdentity
	deadline time.Time
	clock    computerport.Clock
	in       io.ReadCloser
	out      io.WriteCloser
	gate     chan struct{}
	closed   atomic.Bool
	once     sync.Once
	closeErr error
	hello    bool
	barrier  uint32
	attempt  uint32
	released bool
}

var _ nativeprocess.HeldGate = (*processHeldGate)(nil)

func newProcessHeldGate(identity wire.ComputerHeldIdentity, clock computerport.Clock, in io.ReadCloser, out io.WriteCloser) (*processHeldGate, error) {
	deadline, err := heldDeadline(identity, clock)
	if err != nil || in == nil || out == nil {
		return nil, heldFailure()
	}
	return &processHeldGate{identity: identity, deadline: deadline, clock: clock, in: in, out: out, gate: make(chan struct{}, 1)}, nil
}

func (g *processHeldGate) Close() error {
	g.once.Do(func() {
		g.closed.Store(true)
		g.closeErr = errors.Join(g.in.Close(), g.out.Close())
	})
	return g.closeErr
}

func (g *processHeldGate) Ready(ctx context.Context) error   { return g.control(ctx, false) }
func (g *processHeldGate) Release(ctx context.Context) error { return g.control(ctx, true) }

func (g *processHeldGate) control(ctx context.Context, release bool) (result error) {
	if ctx == nil {
		_ = g.Close()
		return heldFailure()
	}
	bounded, cancel := context.WithDeadline(ctx, g.deadline)
	defer cancel()
	select {
	case g.gate <- struct{}{}:
	case <-bounded.Done():
		_ = g.Close()
		return heldFailure()
	}
	defer func() { <-g.gate }()
	if g.closed.Load() || bounded.Err() != nil || !g.clock.Now().Before(g.deadline) || g.released || (release && g.barrier != 2) || (!release && g.barrier >= 2) {
		_ = g.Close()
		return heldFailure()
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-bounded.Done():
			_ = g.Close()
		case <-stop:
		}
	}()
	defer func() {
		close(stop)
		<-done
		if result != nil || bounded.Err() != nil || g.closed.Load() {
			_ = g.Close()
			result = heldFailure()
		}
	}()
	if !g.hello {
		hello := wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: g.identity.BuildId, ProfileId: g.identity.ProfileId}
		raw, err := g.call("core.handshake", hello, false)
		var identity wire.Identity
		if err != nil || wire.Validate("Identity", raw) != nil || json.Unmarshal(raw, &identity) != nil || identity.BuildId != g.identity.BuildId || identity.ProfileId != g.identity.ProfileId || identity.BackendGeneration != g.identity.BackendGeneration || identity.ProtocolMajor != wire.ProtocolMajor || identity.ProtocolMinor != wire.ProtocolMinor || identity.MaxFrameBytes != ipc.MaxFrameBytes || !slices.Equal(identity.Capabilities, []string{"core.status", heldReadyMethod, heldReleaseMethod}) {
			return heldFailure()
		}
		g.hello = true
	}
	barrier, method := g.barrier+1, heldReadyMethod
	if release {
		barrier, method, g.released = 2, heldReleaseMethod, true
	}
	body := wire.ComputerHeldBarrier{Identity: g.identity, Barrier: barrier}
	raw, err := g.call(method, body, release)
	var receipt wire.ComputerHeldBarrier
	if err != nil || wire.Validate("ComputerHeldBarrier", raw) != nil || json.Unmarshal(raw, &receipt) != nil || receipt != body || !g.clock.Now().Before(g.deadline) {
		return heldFailure()
	}
	if !release {
		g.barrier = barrier
	}
	return nil
}

func (g *processHeldGate) call(method string, body any, effect bool) (json.RawMessage, error) {
	g.attempt++ // At most handshake, two barriers and one release; never reused.
	id := "held-" + strconv.FormatUint(uint64(g.attempt), 10)
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, heldFailure()
	}
	context := wire.Context{ProfileId: g.identity.ProfileId, BackendGeneration: g.identity.BackendGeneration}
	call := wire.Call{Body: encoded}
	if method != "core.handshake" {
		call.Context = &context
	}
	if effect {
		operation := g.identity.OperationId
		call.OperationId = &operation
	}
	raw, err := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: call})
	if err != nil || ipc.ValidateJSON(raw) != nil || wire.Validate("Request", raw) != nil || ipc.WriteFrame(g.out, raw) != nil {
		return nil, heldFailure()
	}
	raw, err = ipc.ReadFrame(g.in)
	if err != nil || ipc.ValidateJSON(raw) != nil || wire.Validate("Response", raw) != nil {
		return nil, heldFailure()
	}
	var response wire.Response
	if json.Unmarshal(raw, &response) != nil || response.Id == nil || *response.Id != id || response.Error != nil || response.Result == nil {
		return nil, heldFailure()
	}
	result := response.Result
	if result.RequestId != id || result.Context != context || result.Status != "ok" || result.Code != nil ||
		(effect && (result.OperationId == nil || *result.OperationId != g.identity.OperationId)) || (!effect && result.OperationId != nil) {
		return nil, heldFailure()
	}
	return append(json.RawMessage(nil), result.Data...), nil
}
