// Package handoff owns clean retirement of empty, never-dispatched or exactly
// retained completed registries. It creates no restored conversation handles.
// Trusted boot owns root/host qualification and exact successor construction.
package handoff

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid   Code = "CHAT_HANDOFF_INVALID"
	Refused   Code = "CHAT_HANDOFF_REFUSED"
	Nonempty  Code = "CHAT_HANDOFF_NONEMPTY"
	Unknown   Code = "CHAT_HANDOFF_UNKNOWN"
	Cancelled Code = "CHAT_HANDOFF_CANCELLED"
)

func validID(s string) bool {
	return len(s) > 0 && len(s) <= 120 && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool { return r <= 32 || r == 127 }) < 0
}
func validRoot(r port.JournalRoot) bool { return r.Device != 0 && r.Inode != 0 }
func validBinding(b port.HandoffBinding) bool {
	return validID(b.ProfileID) && validID(b.BackendGeneration) && validID(b.BuildID) && validID(b.HostLifetimeID) && validID(b.ChildLaunchID) && validRoot(b.ParentRoot) && validRoot(b.ChatRoot) && b.ParentRoot.OwnerUID == b.ChatRoot.OwnerUID && b.ParentRoot.Device == b.ChatRoot.Device && b.ParentRoot != b.ChatRoot
}

// Copy owns every mutable value before IO or callbacks.
func Copy(r port.HandoffRecord) port.HandoffRecord {
	r.Receipt.Write = port.CopyRetirement(r.Receipt.Write)
	if r.ACK != nil {
		a := *r.ACK
		r.ACK = &a
	}
	if r.Terminal != nil {
		t := *r.Terminal
		if t.ExitCode != nil {
			n := *t.ExitCode
			t.ExitCode = &n
		}
		r.Terminal = &t
	}
	if r.Consumption != nil {
		c := *r.Consumption
		r.Consumption = &c
	}
	return r
}
func validReceipt(p port.HandoffPublication, r port.RetirementReceipt) error {
	w := r.Write
	if !validBinding(p.Binding) || !validID(p.HandoffID) || p.ReceiptDigest == ([32]byte{}) || p.ReceiptDigest != r.PublicationDigest || w.Scope != (port.JournalScope{ProfileID: p.Binding.ProfileID, BackendGeneration: p.Binding.BackendGeneration}) || w.Root != p.Binding.ChatRoot || w.Turns == nil || w.PreviousRevision >= math.MaxUint64-1 || w.Revision != w.PreviousRevision+1 {
		return Invalid
	}
	if len(w.Turns) == 0 {
		// Empty cannot explain any previous journal activity.
		if w.PreviousRevision != 0 {
			return Refused
		}
		return nil
	}
	if len(w.Turns) > turn.MaxRequests || w.PreviousRevision < 3*uint64(len(w.Turns)) {
		return Nonempty
	}
	previousID := ""
	identities := make(map[turn.Identity]bool, len(w.Turns))
	acknowledgements := make(map[uint64]bool, len(w.Turns))
	cleanupRevisions := make(map[uint64]bool, len(w.Turns)*2)
	publications := make(map[[32]byte]bool)
	var storageRoot port.JournalRoot
	for _, actual := range w.Turns {
		completed := completedRetained(actual, w.Scope, w.Root, w.PreviousRevision)
		if (!neverDispatched(actual, w.Scope) && !completed) || actual.Binding.OperationID <= previousID || actual.AcknowledgedRevision < 3 || actual.AcknowledgedRevision > w.PreviousRevision || acknowledgements[actual.AcknowledgedRevision] || cleanupRevisions[actual.AcknowledgedRevision] {
			return Nonempty
		}
		if completed {
			p := actual.ResultPublication
			if publications[p.Digest] || (storageRoot != (port.JournalRoot{}) && storageRoot != p.StorageRoot) {
				return Nonempty
			}
			publications[p.Digest], storageRoot = true, p.StorageRoot
			for _, revision := range []uint64{actual.SettledRevision, actual.ReleasedRevision} {
				if acknowledgements[revision] || cleanupRevisions[revision] || revision == actual.AcknowledgedRevision {
					return Nonempty
				}
				cleanupRevisions[revision] = true
			}
		}
		// Match the live queue's logical-turn uniqueness as well as operation order.
		logical := actual.Snapshot.Identity
		logical.OperationID = ""
		if identities[logical] {
			return Nonempty
		}
		identities[logical] = true
		acknowledgements[actual.AcknowledgedRevision] = true
		previousID = actual.Binding.OperationID
	}
	return nil
}

// Exact projection excludes even stale reservation/provider/call evidence hidden
// behind false flags. Closure and original ACK revisions come from the actual
// owner's callback; native successor qualification checks the original journal.
// This admits no restored handles, conversation history or result bytes.
func neverDispatched(actual port.RetirementTurn, scope port.JournalScope) bool {
	b := actual.Binding
	if b.ProfileID != scope.ProfileID || b.BackendGeneration != scope.BackendGeneration || b.TurnGeneration == 0 {
		return false
	}
	for _, id := range []string{b.OwnerID, b.SessionID, b.TaskID, b.ParticipantID, b.TurnID, b.OperationID, actual.Snapshot.Result.ID} {
		if !validID(id) {
			return false
		}
	}
	want := turn.Snapshot{
		Identity: turn.Identity{ProfileID: b.ProfileID, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, OperationID: b.OperationID, Generation: b.TurnGeneration},
		Phase:    turn.Cancelled, HasResult: true,
		Result:               turn.Result{ID: actual.Snapshot.Result.ID, Outcome: turn.CancelledOutcome, Code: "NOT_DISPATCHED"},
		DeliveryAcknowledged: true, LifecycleSettled: true,
	}
	return actual.Snapshot == want && actual.SettledRevision == 0 && actual.ReleasedRevision == 0 && actual.Quiescence == (turn.QuiescenceEvidence{}) && actual.Disposal == (turn.DisposalEvidence{}) && actual.ResultPublication == (port.ResultPublication{})
}

// ValidateRecord validates closed persisted data, never manufactures a proof.
func ValidateRecord(r port.HandoffRecord) error {
	if r.Version != 1 || r.Origin != port.HandoffLiveOwner {
		return Invalid
	}
	if err := validReceipt(r.Publication, r.Receipt); err != nil {
		return err
	}
	switch r.Stage {
	case port.HandoffCaptured:
		if r.ACK != nil || r.Terminal != nil || r.Consumption != nil {
			return Invalid
		}
		return nil
	case port.HandoffAcknowledged, port.HandoffTerminated, port.HandoffConsumed:
	default:
		return Invalid
	}
	if r.ACK == nil || r.ACK.Publication != r.Publication {
		return Invalid
	}
	if r.Stage == port.HandoffAcknowledged {
		if r.Terminal != nil || r.Consumption != nil {
			return Invalid
		}
		return nil
	}
	if r.Terminal == nil {
		return Invalid
	}
	t := r.Terminal
	if t.Publication != r.Publication || t.Kind != port.HandoffNormalExit || t.StopMode != port.HandoffGracefulStop || t.ExitCode == nil || *t.ExitCode != 0 || t.Signal != "" {
		return Refused
	}
	if t.KnownACKDigest == ([32]byte{}) {
		return Refused
	}
	if r.Stage == port.HandoffTerminated {
		if r.Consumption != nil {
			return Invalid
		}
		return nil
	}
	if r.Consumption == nil || !r.Consumption.PreviousHostDrainConfirmed || r.Consumption.Next.ProfileID != r.Publication.Binding.ProfileID || !validID(r.Consumption.Next.BackendGeneration) || r.Consumption.Next.BackendGeneration == r.Publication.Binding.BackendGeneration || !validID(r.Consumption.AttemptID) {
		return Refused
	}
	c, b := r.Consumption, r.Publication.Binding
	n := c.NextBinding
	if !validBinding(n) || n.ProfileID != c.Next.ProfileID || n.BackendGeneration != c.Next.BackendGeneration || n.ParentRoot != b.ParentRoot || n.ChatRoot != b.ChatRoot || n.HostLifetimeID == b.HostLifetimeID || n.ChildLaunchID == b.ChildLaunchID {
		return Refused
	}
	// v1's explicit empty receipt is build-independent. Consume and the store
	// also require the complete retained prefix to be empty; this record alone
	// cannot establish that. Nonempty compatibility remains same-build only.
	if n.BuildID != b.BuildID && len(r.Receipt.Write.Turns) != 0 {
		return Refused
	}
	return nil
}

// sameRecord compares complete values without depending on native hashing.
func sameRecord(a, b port.HandoffRecord) bool {
	left, e := json.Marshal(a)
	right, f := json.Marshal(b)
	return e == nil && f == nil && bytes.Equal(left, right)
}

// ValidateTransition enforces adjacent durable steps. Only a new actual owner
// matching a consumed successor may begin the next cycle. Native storage also
// rejects reuse against its complete bounded immutable chain.
func ValidateTransition(previous *port.HandoffRecord, previousDigest [32]byte, next port.HandoffRecord) error {
	if err := ValidateRecord(next); err != nil {
		return err
	}
	if previous == nil {
		if next.Stage != port.HandoffCaptured {
			return Refused
		}
		return nil
	}
	if err := ValidateRecord(*previous); err != nil {
		return err
	}
	p := previous
	if p.Stage == port.HandoffConsumed {
		b, n := p.Publication.Binding, next.Publication.Binding
		if next.Stage != port.HandoffCaptured || n.ProfileID != b.ProfileID || n.ParentRoot != b.ParentRoot || n.ChatRoot != b.ChatRoot || n != p.Consumption.NextBinding || n.HostLifetimeID == b.HostLifetimeID || n.ChildLaunchID == b.ChildLaunchID || next.Publication.HandoffID == p.Publication.HandoffID {
			return Refused
		}
		return nil
	}
	if p.Publication != next.Publication || p.Origin != next.Origin || !port.SameRetirement(p.Receipt.Write, next.Receipt.Write) || p.Receipt.PublicationDigest != next.Receipt.PublicationDigest {
		return Refused
	}
	switch p.Stage {
	case port.HandoffCaptured:
		if next.Stage != port.HandoffAcknowledged {
			return Refused
		}
	case port.HandoffAcknowledged:
		if next.Stage != port.HandoffTerminated || *p.ACK != *next.ACK || next.Terminal.KnownACKDigest != previousDigest {
			return Refused
		}
	case port.HandoffTerminated:
		if next.Stage != port.HandoffConsumed || *p.ACK != *next.ACK || !sameTerminal(*p.Terminal, *next.Terminal) {
			return Refused
		}
	default:
		return Refused
	}
	return nil
}
func sameTerminal(a, b port.HandoffTerminal) bool {
	return a.Publication == b.Publication && a.KnownACKDigest == b.KnownACKDigest && a.Kind == b.Kind && a.StopMode == b.StopMode && a.Signal == b.Signal && a.ExitCode != nil && b.ExitCode != nil && *a.ExitCode == *b.ExitCode
}

type Service struct {
	guard     port.Gate
	store     port.HandoffStore
	uncertain bool
	knownHead [32]byte
}

func New(store port.HandoffStore) (*Service, error) {
	if store == nil {
		return nil, Invalid
	}
	guard := store.Guard()
	if guard == nil {
		return nil, Invalid
	}
	return &Service{store: store, guard: guard}, nil
}
func (s *Service) check(ctx context.Context) error {
	if s == nil || s.store == nil || ctx == nil {
		return Invalid
	}
	if s.uncertain {
		return Unknown
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}
func (s *Service) load(ctx context.Context) (*port.HandoffHead, error) {
	h, err := s.store.Load(ctx)
	if err != nil || ctx.Err() != nil || h == nil {
		s.markUnknown(ctx)
		return nil, Unknown
	}
	if h.Record == nil {
		if h.Digest != ([32]byte{}) || h.EmptyRetirementChain {
			s.markUnknown(ctx)
			return nil, Unknown
		}
		return &port.HandoffHead{}, nil
	}
	d, e := s.store.Digest(Copy(*h.Record))
	if ValidateRecord(*h.Record) != nil || e != nil || h.Digest == ([32]byte{}) || d != h.Digest || (h.EmptyRetirementChain && len(h.Record.Receipt.Write.Turns) != 0) {
		s.markUnknown(ctx)
		return nil, Unknown
	}
	r := Copy(*h.Record)
	return &port.HandoffHead{Record: &r, Digest: h.Digest, EmptyRetirementChain: h.EmptyRetirementChain}, nil
}
func (s *Service) publish(ctx context.Context, h *port.HandoffHead, r port.HandoffRecord) (*port.HandoffHead, error) {
	if err := ValidateTransition(h.Record, h.Digest, r); err != nil {
		return nil, err
	}
	want, e := s.store.Digest(Copy(r))
	if e != nil || want == ([32]byte{}) {
		return nil, Invalid
	}
	got, err := s.store.Publish(ctx, h.Digest, Copy(r))
	if err != nil || ctx.Err() != nil || got == nil || got.Record == nil || got.Digest != want {
		s.markUnknown(ctx)
		return nil, Unknown
	}
	emptyChain := (h.Record == nil || h.EmptyRetirementChain) && len(r.Receipt.Write.Turns) == 0
	if ValidateRecord(*got.Record) != nil || !sameRecord(*got.Record, r) || got.EmptyRetirementChain != emptyChain {
		s.markUnknown(ctx)
		return nil, Unknown
	}
	copy := Copy(r)
	s.knownHead = got.Digest
	return &port.HandoffHead{Record: &copy, Digest: got.Digest, EmptyRetirementChain: emptyChain}, nil
}

// Capture copies only inside the actual owner's callback. Store IO happens after
// WithRetirement has returned, outside that owner's gate. No public receipt-only
// entrypoint exists. The store is a trusted injected authority boundary.
func (s *Service) Capture(ctx context.Context, b port.HandoffBinding, id string, origin port.CleanRetirement) (*port.HandoffPublication, error) {
	if s == nil || s.guard == nil {
		return nil, Invalid
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	if origin == nil || !validBinding(b) || !validID(id) {
		return nil, Invalid
	}
	var receipt port.RetirementReceipt
	calls := 0
	err := origin.WithRetirement(ctx, func(r *port.RetirementReceipt) error {
		calls++
		if calls != 1 || r == nil {
			return Invalid
		}
		receipt = *r
		receipt.Write = port.CopyRetirement(r.Write)
		return nil
	})
	if err != nil || calls != 1 || ctx.Err() != nil {
		return nil, Refused
	}
	p := port.HandoffPublication{Binding: b, HandoffID: id, ReceiptDigest: receipt.PublicationDigest}
	r := port.HandoffRecord{Version: 1, Stage: port.HandoffCaptured, Origin: port.HandoffLiveOwner, Publication: p, Receipt: receipt}
	if err := ValidateRecord(r); err != nil {
		return nil, err
	}
	h, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = s.publish(ctx, h, r); err != nil {
		return nil, err
	}
	return &p, nil
}

// Acknowledge returns a durable ACK head digest for the initiating host to retain
// before terminal observation. It is never inferred from receipt publication.
func (s *Service) Acknowledge(ctx context.Context, a port.HandoffACK) ([32]byte, error) {
	if s == nil || s.guard == nil {
		return [32]byte{}, Invalid
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	if err := s.check(ctx); err != nil {
		return [32]byte{}, err
	}
	h, err := s.load(ctx)
	if err != nil {
		return [32]byte{}, err
	}
	if h.Record == nil || h.Record.Stage != port.HandoffCaptured || h.Record.Publication != a.Publication {
		return [32]byte{}, Refused
	}
	r := Copy(*h.Record)
	r.Stage = port.HandoffAcknowledged
	r.ACK = &a
	out, err := s.publish(ctx, h, r)
	if err != nil {
		return [32]byte{}, err
	}
	return out.Digest, nil
}

// ObserveTerminal is intended for boot's root-qualified recorder mode of the
// same attested executable. It creates no runtime, Chat owner or provider.
func (s *Service) ObserveTerminal(ctx context.Context, t port.HandoffTerminal) error {
	if s == nil || s.guard == nil {
		return Invalid
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	if err := s.check(ctx); err != nil {
		return err
	}
	h, err := s.load(ctx)
	if err != nil {
		return err
	}
	if h.Record == nil || h.Record.Stage != port.HandoffAcknowledged || h.Record.Publication != t.Publication || t.KnownACKDigest != h.Digest {
		return Refused
	}
	r := Copy(*h.Record)
	r.Stage = port.HandoffTerminated
	r.Terminal = &t
	r = Copy(r)
	_, err = s.publish(ctx, h, r)
	return err
}

// Successor pairs proof with the ONLY next scope consumed in durable storage.
// Existing CleanRetirement cannot inspect NewAfterRetirement's next argument:
// trusted boot MUST pass this exact Scope to that constructor. Never expose proof
// through wire DTOs. Lost launch/open/handshake cannot replay Consume.
type Successor struct {
	Scope   port.JournalScope
	Proof   port.CleanRetirement
	History *HistoryOrigin
}

func (s *Service) Consume(ctx context.Context, p port.HandoffPublication, c port.HandoffConsumption) (*Successor, error) {
	if s == nil || s.guard == nil {
		return nil, Invalid
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	h, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	if h.Record == nil || h.Record.Stage != port.HandoffTerminated || h.Record.Publication != p {
		return nil, Refused
	}
	// A known incompatible ancestor must refuse before Publish: an attempted
	// publication's failed reply is uncertainty, not a compatibility decision.
	if c.NextBinding.BuildID != p.Binding.BuildID && !h.EmptyRetirementChain {
		return nil, Refused
	}
	r := Copy(*h.Record)
	r.Stage = port.HandoffConsumed
	r.Consumption = &c
	published, err := s.publish(ctx, h, r)
	if err != nil {
		return nil, err
	}
	return &Successor{Scope: c.Next, Proof: &retainedOrigin{receipt: Copy(r).Receipt, guard: s.guard}, History: &HistoryOrigin{owner: s, anchor: port.HistoryAnchor{HeadDigest: published.Digest, Consumption: c}}}, nil
}

type retainedOrigin struct {
	guard   port.Gate
	receipt port.RetirementReceipt
	used    bool
}

func (p *retainedOrigin) WithRetirement(ctx context.Context, inspect func(*port.RetirementReceipt) error) error {
	if p == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	p.guard.Lock()
	defer p.guard.Unlock()
	if p.used {
		return Refused
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	// Even a failed constructor/callback consumes this in-memory one-shot proof.
	p.used = true
	r := p.receipt
	r.Write = port.CopyRetirement(r.Write)
	if err := inspect(&r); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}

var _ port.CleanRetirement = (*retainedOrigin)(nil)

func (s *Service) markUnknown(ctx context.Context) {
	if !s.uncertain {
		s.uncertain = true
		// Cancellation after possible publication cannot suppress its uncertainty
		// fence. This is a distinct one-shot fence, never a publication retry.
		_ = s.store.Fence(context.WithoutCancel(ctx))
	}
}
