// Package lifecycle owns ordinary Chat's live queue and admitted route handles.
// Native/browser/journal adapters are injected; there is no delegated task engine.
package lifecycle

import (
	"context"
	"math"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/output"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_LIFECYCLE_INVALID"
	Unavailable Code = "CHAT_LIFECYCLE_UNAVAILABLE"
	Mismatch    Code = "CHAT_LIFECYCLE_MISMATCH"
	Busy        Code = "CHAT_LIFECYCLE_BUSY"
	Unsettled   Code = "CHAT_LIFECYCLE_UNSETTLED"
	Cancelled   Code = "CHAT_LIFECYCLE_CANCELLED"
	Frozen      Code = "CHAT_LIFECYCLE_FROZEN"
)

type Dependencies struct {
	Gate    port.Gate
	Journal port.Journal
	// Browser is optional for admission-only assembly. Any browser assembly also
	// requires Results, so an effective Send never lacks terminal retention.
	// A missing capability refuses BEFORE withdrawal, persistence or any effect.
	Browser port.Browser
	Results port.ResultRetention
	// Trusted composition pins the accepted retention byte budget before admission.
	ResultBytesLimit int
	IntentDigests    port.IntentDigester
}

type Service struct {
	scope             port.JournalScope
	root              port.JournalRoot
	frozen, retiring  bool
	retired           *retirementProof
	deps              Dependencies
	queue             *turn.Queue
	handles           map[string]*Handle
	revision, fence   uint64
	pending           *mutation
	unknown           bool
	usedVerifications map[string]bool
	providerOwners    map[string]port.TurnBinding
}

// Handle is minted only by this owner's actual successful admission. Its fields
// are private; historical DTOs, body IDs and an unrelated owner cannot forge it.
// The same handle is captured by contracts/admission for every subsequent phase.
type Handle struct {
	owner                                          *Service
	fixed                                          port.TurnBinding
	digest                                         string
	quiescence                                     turn.QuiescenceEvidence
	disposal                                       turn.DisposalEvidence
	unresolvedCallID                               string
	ackRevision, settledRevision, releasedRevision uint64
	target                                         port.ConversationTarget
	conversation                                   *Conversation
	verification                                   port.SendVerification
	prompt                                         string
	output                                         output.State
	frames                                         *stream.Buffer
	observing                                      bool
	sourceSequence                                 uint64
	caller                                         *CallerToolCall
	closed                                         bool // protected by owner's gate; monotonic membership withdrawal
	readWithdrawal                                 bool // exact bare-read withdrawal intent, never a promoted turn
	readPromoted                                   bool // known promotion receipt; ordinary Create is not promotion replay
}

var _ port.BoundTurn = (*Handle)(nil)

// New claims one fresh empty journal before exposing a live owner. It does not
// restore admission from durable history. Trusted boot supplies the incarnation
// and real ports. A refused/unknown claim is not retried and returns no owner.
func New(ctx context.Context, scope port.JournalScope, deps Dependencies) (*Service, error) {
	if ctx == nil || deps.Gate == nil || deps.Journal == nil {
		return nil, Invalid
	}
	if ctx.Err() != nil {
		return nil, Cancelled
	}
	if (deps.Browser != nil && deps.Results == nil) || (deps.Results != nil && deps.ResultBytesLimit < 1) {
		return nil, Invalid
	}
	queue, err := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
	if err != nil {
		return nil, err
	}
	head, err := deps.Journal.OpenFresh(ctx, scope)
	if err != nil || head == nil || head.Scope != scope || head.Revision != 0 {
		return nil, Unsettled
	}
	if ctx.Err() != nil {
		return nil, Cancelled
	}
	return &Service{scope: scope, root: head.Root, deps: deps, queue: queue, handles: make(map[string]*Handle), usedVerifications: make(map[string]bool), providerOwners: make(map[string]port.TurnBinding)}, nil
}

func (h *Handle) Binding() port.TurnBinding {
	if h == nil {
		return port.TurnBinding{}
	}
	return h.fixed
}

// WithCurrent only reads live memory under the owner's actual gate. No journal
// read, browser effect or Computer reacquisition occurs at entry or in this path.
func (h *Handle) WithCurrent(ctx context.Context, inspect func(*port.CurrentTurn) error) error {
	if h == nil || h.owner == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	s := h.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if ctx.Err() != nil {
		return Cancelled
	}
	if s.handles[h.fixed.OperationID] != h {
		return Mismatch
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return Unsettled
	}
	persistence := port.Committed
	if s.unknown || s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		persistence = port.UnknownCommit
	} else if s.pending != nil || s.retiring {
		persistence = port.PendingCommit
	}
	var current *port.CurrentTurn
	// Unknown and pending closure cannot be converted into settled absence.
	if !h.closed || persistence != port.Committed || view.Phase == turn.Unknown {
		current = &port.CurrentTurn{Binding: h.fixed, Turn: view, Persistence: persistence}
	}
	if err := inspect(current); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}

func (s *Service) Admit(ctx context.Context, binding port.TurnBinding, digest string) (*Handle, error) {
	return s.admit(ctx, binding, digest, nil)
}

func (s *Service) admit(ctx context.Context, binding port.TurnBinding, digest string, conversation *Conversation) (*Handle, error) {
	if s == nil || ctx == nil {
		return nil, Invalid
	}
	if !validBinding(binding) || binding.ProfileID != s.scope.ProfileID || binding.BackendGeneration != s.scope.BackendGeneration {
		return nil, Mismatch
	}
	s.deps.Gate.Lock()
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	if existing := s.handles[binding.OperationID]; existing != nil {
		if existing.fixed != binding || existing.digest != digest || existing.closed || (conversation != nil && existing.conversation != conversation) {
			s.deps.Gate.Unlock()
			return nil, turn.Conflict
		}
		s.deps.Gate.Unlock()
		return existing, nil
	}
	if conversation != nil && conversation.previous != nil && conversation.root.latest != conversation.previous {
		s.deps.Gate.Unlock()
		return nil, turn.Conflict
	}
	candidate := s.queue.Clone()
	after, err := candidate.Admit(identity(binding), digest)
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	h := &Handle{owner: s, fixed: binding, digest: digest}
	if conversation != nil {
		h.conversation, h.target, h.prompt = conversation, conversation.target, conversation.input.Prompt
		conversation.input.Prompt = ""
		conversation.handle = h
		h.output = output.New(OutputBytesLimit, conversation.target.PreviousUserTurnID, conversation.target.PreviousReplyID)
		h.frames, err = stream.New(streamScope(binding), stream.DefaultLimits())
		if err != nil {
			s.deps.Gate.Unlock()
			return nil, err
		}
	}
	m := s.begin(candidate, h, port.JournalEntry{Binding: binding, Kind: "admit", After: after, IntentDigest: digest})
	s.deps.Gate.Unlock()
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	return h, nil
}

// Action describes closed, content-free transitions. Browser dispatch, result
// retention and cancellation have separate owning methods. Apply persists
// metadata outside the gate; it cannot execute native/browser/tool effects.
type Action string

const (
	Enqueue         Action = "enqueue"
	Accept          Action = "accept"
	AwaitOwner      Action = "await-owner"
	Resume          Action = "resume"
	Delta           Action = "delta"
	RequestComputer Action = "request-computer"
	ResolveComputer Action = "resolve-computer"
	Acknowledge     Action = "acknowledge"
	Settle          Action = "settle"
	SettlePrepared  Action = "settle-prepared"
	Release         Action = "release"
)

type Change struct {
	Action           Action
	Binding          turn.Binding
	Reservation      turn.Reservation
	Sequence         uint64
	CallID, ResultID string
	Quiescence       turn.QuiescenceEvidence
	Disposal         turn.DisposalEvidence
}

func (s *Service) Apply(ctx context.Context, h *Handle, change Change) (*turn.Snapshot, error) {
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		after, err := apply(q, h.fixed, change)
		return port.JournalEntry{Binding: h.fixed, Kind: string(change.Action), Before: before, After: after, CallID: change.CallID, Quiescence: change.Quiescence, Disposal: change.Disposal, Closed: h.closed}, err
	})
	if err != nil {
		return nil, err
	}
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	view := m.entry.After
	return &view, nil
}

// Cancel withdraws membership under Gate before journal IO. If it overtakes a
// pending write/effect, it fences that write and leaves the owner unresolved;
// no second journal writer, compensating effect or optimistic absence is started.
func (s *Service) Cancel(ctx context.Context, h *Handle, resultID string) (*turn.Snapshot, error) {
	m, err := s.stage(ctx, h, true, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		after, err := q.Cancel(identity(h.fixed), resultID)
		return port.JournalEntry{Binding: h.fixed, Kind: "cancel", Before: before, After: after, Closed: true}, err
	})
	if err != nil {
		return nil, err
	}
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	view := m.entry.After
	return &view, nil
}

// Finish retains the actual delivery bytes while current membership is withdrawn,
// then commits terminal metadata. A matching known retention reply is mandatory;
// byte storage is not a journal field and is never persisted by this owner.
func (s *Service) Finish(ctx context.Context, h *Handle, binding turn.Binding, result turn.Result, payload []byte) (*turn.Snapshot, error) {
	if s == nil || s.deps.Results == nil {
		return nil, Unavailable
	}
	if len(payload) > s.deps.ResultBytesLimit {
		return nil, Invalid
	}
	m, err := s.stage(ctx, h, true, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		if before.HasResult {
			return port.JournalEntry{}, turn.Transition
		}
		if binding.Reservation.Identity != identity(h.fixed) {
			return port.JournalEntry{}, Mismatch
		}
		after, err := q.Finish(binding, result)
		return port.JournalEntry{Binding: h.fixed, Kind: "finish", Before: before, After: after, Closed: true}, err
	})
	if err != nil {
		return nil, err
	}
	if err := s.effectCurrent(ctx, m); err != nil {
		return nil, err
	}
	bytes := append([]byte(nil), payload...)
	receipt, err := s.deps.Results.Retain(ctx, port.RetainRequest{Binding: h.fixed, Result: result, Payload: bytes})
	if err != nil || receipt == nil || receipt.Binding != h.fixed || receipt.Result != result || receipt.Bytes != len(payload) {
		return nil, s.fail(m)
	}
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	view := m.entry.After
	return &view, nil
}

type mutation struct {
	conversation *Conversation
	caller       *CallerToolCall
	frames       *stream.Buffer
	candidate    *turn.Queue
	handle       *Handle
	fence        uint64
	entry        port.JournalEntry
}

// stage derives a private candidate under Gate and withdraws ALL positive views
// before unlocked persistence/effects. This initial owner has one journal writer
// in flight, retaining coherent global queue/slot ownership without partial merge.
func (s *Service) stage(ctx context.Context, h *Handle, closing bool, derive func(*turn.Queue, turn.Snapshot) (port.JournalEntry, error)) (*mutation, error) {
	if s == nil || ctx == nil || h == nil || h.owner != s {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if s.handles[h.fixed.OperationID] != h {
		return nil, Mismatch
	}
	if h.observing && ctx.Value(observationKey{}) != h {
		if closing {
			h.closed = true
			s.unknown = true
			return nil, Unsettled
		}
		return nil, Busy
	}
	if closing && s.pending != nil {
		h.closed = true
		s.unknown = true
		// Pointer plus monotonic closure invalidates the exact candidate even at
		// counter saturation. No late success may publish it or re-open the route.
		return nil, Unsettled
	}
	if err := s.settlementAvailable(ctx); err != nil {
		return nil, err
	}
	before, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return nil, err
	}
	candidate := s.queue.Clone()
	entry, err := derive(candidate, before)
	if err != nil {
		return nil, err
	}
	if s.frozen {
		switch entry.Kind {
		case "cancel", "finish", "accept", "delta", "await-owner", "acknowledge", "settle", "settle-prepared", "release", "resolve-computer":
		default:
			return nil, Frozen
		}
	}
	if closing {
		h.closed = true
	}
	return s.begin(candidate, h, entry), nil
}

func (s *Service) begin(q *turn.Queue, h *Handle, entry port.JournalEntry) *mutation {
	s.fence++ // available checks exhaustion before any candidate/IO
	m := &mutation{candidate: q, handle: h, fence: s.fence, entry: entry}
	s.pending = m
	return m
}

func (s *Service) available(ctx context.Context) error {
	if err := s.settlementAvailable(ctx); err != nil {
		return err
	}
	if s.frozen {
		return Frozen
	}
	return nil
}

func (s *Service) settlementAvailable(ctx context.Context) error {
	if ctx.Err() != nil {
		return Cancelled
	}
	if s.unknown || s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		s.unknown = true
		return Unsettled
	}
	if s.pending != nil || s.retiring {
		return Busy
	}
	if s.retired != nil {
		return Frozen
	}
	return nil
}

// commit checks the same pending object, route, fence and revision BOTH before
// and after unlocked journal IO. A cancelled/late/mismatched reply never commits
// live positive state. A successful effect-intent commit stays pending until its
// separate effect settlement has also been durably acknowledged.
func (s *Service) commit(ctx context.Context, m *mutation, publish bool) error {
	s.deps.Gate.Lock()
	if err := s.current(ctx, m); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	write := port.JournalWrite{Scope: s.scope, PreviousRevision: s.revision, Revision: s.revision + 1, Entry: m.entry}
	s.deps.Gate.Unlock()
	receipt, err := s.deps.Journal.Commit(ctx, write)
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if currentErr := s.current(ctx, m); currentErr != nil {
		return currentErr
	}
	if err != nil || receipt == nil || receipt.Write != write || s.revision != write.PreviousRevision {
		s.unknown = true
		return Unsettled
	}
	s.revision, s.queue = write.Revision, m.candidate
	if s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		s.unknown = true
		return Unsettled
	}
	if publish {
		switch m.entry.Kind {
		case "promote-conversation":
			m.publishPromotion()
		case "admit":
			if c := m.handle.conversation; c != nil {
				c.root.latest = c
			}
		case "prepared", "accept":
			if c := m.handle.conversation; c != nil {
				if cid := m.entry.After.Binding.Document.ConversationID; cid != "" {
					c.providerID = cid
					s.providerOwners[cid] = m.handle.fixed
				}
			}
		case "request-computer":
			m.handle.unresolvedCallID = m.entry.CallID
			if m.caller != nil {
				m.handle.caller, m.handle.frames = m.caller, m.frames
			}
		case "resolve-computer":
			m.handle.unresolvedCallID = ""
			if call := m.handle.caller; call != nil && call.phase == callerReturning {
				call.phase, call.output.Output = callerReturned, ""
			}
		case "acknowledge":
			if m.handle.ackRevision == 0 {
				m.handle.ackRevision = write.Revision
			}
		case "settle":
			if m.handle.settledRevision == 0 {
				m.handle.quiescence, m.handle.settledRevision = m.entry.Quiescence, write.Revision
			}
		case "settle-prepared":
			if m.handle.settledRevision == 0 {
				m.handle.disposal, m.handle.settledRevision = m.entry.Disposal, write.Revision
			}
		case "release":
			m.handle.releasedRevision = write.Revision
		}
		if s.handles[m.handle.fixed.OperationID] == nil {
			s.handles[m.handle.fixed.OperationID] = m.handle
		}
		s.pending = nil
	}
	return nil
}

func (s *Service) current(ctx context.Context, m *mutation) error {
	if ctx.Err() != nil {
		s.unknown = true
		return Cancelled
	}
	if s.unknown || s.pending != m || s.fence != m.fence || s.revision == math.MaxUint64 {
		s.unknown = true
		return Unsettled
	}
	return nil
}

func (s *Service) fail(m *mutation) error {
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if s.pending == m {
		s.unknown = true
	}
	return Unsettled
}

func identity(b port.TurnBinding) turn.Identity {
	return turn.Identity{ProfileID: b.ProfileID, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, OperationID: b.OperationID, Generation: b.TurnGeneration}
}

func validBinding(b port.TurnBinding) bool {
	for _, value := range []string{b.ProfileID, b.BackendGeneration, b.OwnerID, b.SessionID, b.TaskID, b.ParticipantID, b.TurnID, b.OperationID} {
		if !validID(value) {
			return false
		}
	}
	return b.TurnGeneration > 0
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	for _, ch := range value {
		if ch <= 32 || ch == 127 {
			return false
		}
	}
	return true
}
