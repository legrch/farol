package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

var errSettingsStoreExchange = errors.New("settings_store_exchange_unavailable")

type settingsStoreAnswer struct {
	body json.RawMessage
	err  error
}
type settingsStoreCall struct {
	command              wire.SettingsStoreCommand
	ctx                  context.Context
	delivered, completed bool
	answer               chan settingsStoreAnswer
}

// SettingsStoreExchange is one inherited-pipe reciprocal storage port. The
// existing host owns config.json mechanics; the Go service owns transitions.
// One outstanding call and 4096 issued calls bound this lifetime. No reconnect,
// replacement store, disk reload or redelivery can settle an unknown call.
type SettingsStoreExchange struct {
	ctx              context.Context
	peer             wire.Context
	mu               sync.Mutex
	pending          *settingsStoreCall
	ready            chan struct{}
	stopped          chan struct{}
	issued           uint32
	fenced, quiesced bool
}

var _ delivery.Store = (*SettingsStoreExchange)(nil)

func NewSettingsStoreExchange(ctx context.Context, peer wire.Context) (*SettingsStoreExchange, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(peer.ProfileId) || !validIngressID(peer.BackendGeneration) {
		return nil, errSettingsStoreExchange
	}
	return &SettingsStoreExchange{ctx: ctx, peer: peer, ready: make(chan struct{}, 1), stopped: make(chan struct{})}, nil
}

func (s *SettingsStoreExchange) Load(ctx context.Context) (delivery.Snapshot, error) {
	raw, err := s.exchange(ctx, "read", nil)
	if err != nil {
		return delivery.Snapshot{}, err
	}
	var result wire.SettingsStoreReadResult
	if json.Unmarshal(raw, &result) != nil || result.Status != "ok" || result.Snapshot == nil {
		return delivery.Snapshot{}, errSettingsStoreExchange
	}
	return settingsSnapshotFromWire(*result.Snapshot)
}

func (s *SettingsStoreExchange) CompareAndSet(ctx context.Context, change delivery.Change) (delivery.SaveResult, error) {
	raw, err := s.exchange(ctx, "replace", &change)
	if err != nil {
		return delivery.SaveResult{Publication: delivery.PublicationUnknown}, err
	}
	var result wire.SettingsStoreReplaceResult
	if json.Unmarshal(raw, &result) != nil {
		s.fence()
		return delivery.SaveResult{Publication: delivery.PublicationUnknown}, errSettingsStoreExchange
	}
	switch result.Status {
	case "not_written":
		return delivery.SaveResult{Publication: delivery.NotWritten}, nil
	case "committed":
		if result.Snapshot != nil {
			snapshot, err := settingsSnapshotFromWire(*result.Snapshot)
			if err == nil {
				return delivery.SaveResult{Publication: delivery.Committed, Readback: &snapshot}, nil
			}
		}
	}
	s.fence()
	return delivery.SaveResult{Publication: delivery.PublicationUnknown}, nil
}

func (s *SettingsStoreExchange) fence() { s.mu.Lock(); s.fenced = true; s.mu.Unlock() }

func (s *SettingsStoreExchange) exchange(ctx context.Context, kind string, change *delivery.Change) (answer json.RawMessage, err error) {
	if ctx == nil || ctx.Err() != nil || s.ctx.Err() != nil {
		return nil, errSettingsStoreExchange
	}
	until := time.Now().Add(14 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(until) {
		until = d
	}
	callCtx, cancel := context.WithDeadline(ctx, until)
	defer cancel()
	deadline := strconv.FormatInt(until.UnixMilli(), 10)
	var body any
	shape := ""
	switch kind {
	case "read":
		body, shape = wire.SettingsStoreRead{DeadlineMillis: deadline}, "SettingsStoreRead"
	case "replace":
		if change == nil || change.Expected.Current.ProfileID != s.peer.ProfileId {
			return nil, errSettingsStoreExchange
		}
		body, shape = wire.SettingsStoreReplace{DeadlineMillis: deadline, Change: settingsChangeToWire(*change)}, "SettingsStoreReplace"
	default:
		return nil, errSettingsStoreExchange
	}
	raw, err := json.Marshal(body)
	if err != nil || wire.Validate(shape, raw) != nil {
		return nil, errSettingsStoreExchange
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	call := &settingsStoreCall{command: wire.SettingsStoreCommand{CommandId: id, Kind: kind, Body: raw}, ctx: callCtx, answer: make(chan settingsStoreAnswer, 1)}
	s.mu.Lock()
	if s.fenced || s.quiesced || s.pending != nil || s.issued >= 4096 {
		s.mu.Unlock()
		return nil, errSettingsStoreExchange
	}
	s.issued++
	s.pending = call
	// This is a wake-up, not custody of the command. Only next's locked
	// deadline check may deliver the original pending call. A stale wake-up
	// cannot strand or replace it when an earlier poll expires.
	select {
	case s.ready <- struct{}{}:
	default:
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.pending = nil
		if err != nil {
			s.fenced = true
		}
		s.mu.Unlock()
	}()
	select {
	case reply := <-call.answer:
		if callCtx.Err() != nil || s.ctx.Err() != nil {
			return nil, errSettingsStoreExchange
		}
		return reply.body, reply.err
	case <-callCtx.Done():
		return nil, callCtx.Err()
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

func (s *SettingsStoreExchange) next(ctx context.Context, deadline uint64) (*wire.SettingsStoreCommand, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errSettingsStoreExchange
	}
	if deadline > 9007199254740991 {
		return nil, errSettingsStoreExchange
	}
	until := time.UnixMilli(int64(deadline))
	if remaining := time.Until(until); remaining <= 0 || remaining > 15*time.Second {
		return nil, errSettingsStoreExchange
	}
	wait, cancel := context.WithDeadline(ctx, until)
	defer cancel()
	for {
		s.mu.Lock()
		if ctx.Err() != nil || s.ctx.Err() != nil || s.fenced {
			s.mu.Unlock()
			return nil, errSettingsStoreExchange
		}
		// select does not prioritize cancellation over a ready command. Check
		// both original deadlines under the same lock as delivery, including
		// wall time when the deadline timer has not run yet. An expired empty
		// poll leaves the pending command's ID, bytes and deadline untouched.
		now := time.Now()
		if s.quiesced || wait.Err() != nil || !now.Before(until) {
			s.mu.Unlock()
			return nil, nil
		}
		call := s.pending
		if call != nil && !call.delivered && !call.completed && call.ctx.Err() == nil {
			deadline, bounded := call.ctx.Deadline()
			if bounded && now.Before(deadline) {
				call.delivered = true
				select {
				case <-s.ready:
				default:
				}
				copy := call.command
				copy.Body = append(json.RawMessage(nil), copy.Body...)
				s.mu.Unlock()
				return &copy, nil
			}
		}
		s.mu.Unlock()
		select {
		case <-s.stopped:
			return nil, nil
		case <-s.ctx.Done():
			return nil, s.ctx.Err()
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, nil
		case <-s.ready:
		}
	}
}

func (s *SettingsStoreExchange) complete(reply wire.SettingsStoreReply) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	call := s.pending
	if call == nil || call.command.CommandId != reply.CommandId || !call.delivered || call.completed || call.ctx.Err() != nil || s.ctx.Err() != nil || s.fenced {
		return errSettingsStoreExchange
	}
	call.completed = true // Consume before any reply/body validation.
	if call.command.Kind != reply.Kind || !validSettingsStoreReply(reply.Kind, reply.Body, s.peer.ProfileId) {
		s.fenced = true
		call.answer <- settingsStoreAnswer{err: errSettingsStoreExchange}
		return errSettingsStoreExchange
	}
	call.answer <- settingsStoreAnswer{body: append(json.RawMessage(nil), reply.Body...)}
	return nil
}

// Called only after delivery and effect owners freeze successfully. This proves
// transport quiescence only and never settles an unknown storage publication.
func (s *SettingsStoreExchange) QuiescePolling() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil || s.pending != nil || s.fenced {
		return errSettingsStoreExchange
	}
	if !s.quiesced {
		s.quiesced = true
		close(s.stopped)
	}
	return nil
}

func (s *SettingsStoreExchange) Methods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.settings.store.next": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("SettingsStoreNext", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.SettingsStoreNext
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			command, err := s.next(ctx, wireUint(body.DeadlineMillis))
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "settings_store_exchange_unavailable"}, nil
			}
			raw, _ := json.Marshal(wire.SettingsStoreNextResult{Command: command})
			return &desktop.Outcome{Status: "ok", Data: raw}, nil
		}},
		"computer.settings.store.reply": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if ctx.Err() != nil || r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("SettingsStoreReply", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.SettingsStoreReply
			if json.Unmarshal(r.Body, &body) != nil || r.OperationID != body.CommandId {
				return invalidIngress()
			}
			if s.complete(body) != nil {
				return &desktop.Outcome{Status: "refused", Code: "settings_store_reply_refused"}, nil
			}
			return &desktop.Outcome{Status: "ok", Data: json.RawMessage(`{}`)}, nil
		}},
	}
}

func validSettingsStoreReply(kind string, raw json.RawMessage, profile string) bool {
	if ipc.ValidateJSON(raw) != nil {
		return false
	}
	var snapshot *wire.SettingsStoreSnapshot
	switch kind {
	case "read":
		var result wire.SettingsStoreReadResult
		if wire.Validate("SettingsStoreReadResult", raw) != nil || json.Unmarshal(raw, &result) != nil || (result.Status == "ok") != (result.Snapshot != nil) {
			return false
		}
		snapshot = result.Snapshot
	case "replace":
		var result wire.SettingsStoreReplaceResult
		if wire.Validate("SettingsStoreReplaceResult", raw) != nil || json.Unmarshal(raw, &result) != nil || (result.Status == "committed") != (result.Snapshot != nil) {
			return false
		}
		snapshot = result.Snapshot
	default:
		return false
	}
	if snapshot != nil {
		if snapshot.Current.ProfileId != profile || snapshot.Pending != nil && snapshot.Pending.ProfileId != profile {
			return false
		}
		if _, err := settingsSnapshotFromWire(*snapshot); err != nil {
			return false
		}
	}
	return true
}

func settingsPendingToWire(p *delivery.Pending) *wire.SettingsStorePending {
	if p == nil {
		return nil
	}
	return &wire.SettingsStorePending{Backend: p.Backend, OperationId: p.OperationID, ProfileId: p.ProfileID, WorkspaceId: p.WorkspaceID, RelativePath: p.RelativePath, ComputerGeneration: strconv.FormatUint(p.ComputerGeneration, 10), BeforeSHA256: p.BeforeSHA256, SubmittedAt: p.SubmittedAt}
}
func settingsSnapshotToWire(v delivery.Snapshot) wire.SettingsStoreSnapshot {
	return wire.SettingsStoreSnapshot{Revision: strconv.FormatUint(v.Revision, 10), Current: wire.SettingsStoreIdentity{ProfileId: v.Current.ProfileID, OwnerId: v.Current.OwnerID, ComputerId: v.Current.ComputerID, Generation: strconv.FormatUint(v.Current.Generation, 10)}, Pending: settingsPendingToWire(v.Pending), VerificationInvalidated: v.VerificationInvalidated}
}
func settingsChangeToWire(v delivery.Change) wire.SettingsStoreChange {
	return wire.SettingsStoreChange{Expected: settingsSnapshotToWire(v.Expected), Next: settingsPendingToWire(v.Next), InvalidateVerification: v.InvalidateVerification}
}
func settingsSnapshotFromWire(v wire.SettingsStoreSnapshot) (delivery.Snapshot, error) {
	positive := func(value string) (uint64, error) {
		n, err := strconv.ParseUint(value, 10, 64)
		if err != nil || n == 0 || n > 9007199254740991 {
			return 0, errSettingsStoreExchange
		}
		return n, nil
	}
	revision, err := positive(v.Revision)
	if err != nil {
		return delivery.Snapshot{}, err
	}
	generation, err := positive(v.Current.Generation)
	if err != nil {
		return delivery.Snapshot{}, err
	}
	snapshot := delivery.Snapshot{Revision: revision, Current: delivery.Identity{ProfileID: v.Current.ProfileId, OwnerID: v.Current.OwnerId, ComputerID: v.Current.ComputerId, Generation: generation}, VerificationInvalidated: v.VerificationInvalidated}
	if p := v.Pending; p != nil {
		generation, err := positive(p.ComputerGeneration)
		if err != nil {
			return delivery.Snapshot{}, err
		}
		snapshot.Pending = &delivery.Pending{Backend: p.Backend, OperationID: p.OperationId, ProfileID: p.ProfileId, WorkspaceID: p.WorkspaceId, RelativePath: p.RelativePath, ComputerGeneration: generation, BeforeSHA256: p.BeforeSHA256, SubmittedAt: p.SubmittedAt}
	}
	return snapshot, nil
}
