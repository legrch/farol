package lifecycle

import (
	"context"
	"math"
	"sort"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// FreezeAdmissions is monotonic. In-flight effects may finish their original
// settlement; existing turns may finish/cancel, ACK, settle and release. New
// admission, reservation and Send are refused before any IO. There is no thaw.
func (s *Service) FreezeAdmissions(ctx context.Context) error {
	if s == nil || ctx == nil {
		return Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if ctx.Err() != nil {
		return Cancelled
	}
	s.frozen = true
	if s.unknown {
		return Unsettled
	}
	return nil
}

// Retire freezes admission before checking the actual live registry. Busy or
// incomplete cleanup performs no retirement IO; the frozen owner can finish only
// its existing settlement. Once publication starts, every failed/late reply is
// sticky uncertainty and cannot be retried or replaced by a new incarnation.
func (s *Service) Retire(ctx context.Context) (port.CleanRetirement, error) {
	if s == nil || ctx == nil {
		return nil, Invalid
	}
	journal, ok := s.deps.Journal.(port.RetirementJournal)
	if !ok {
		return nil, Unavailable
	}
	s.deps.Gate.Lock()
	s.frozen = true
	if err := s.settlementAvailable(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	if s.revision >= math.MaxUint64-1 || s.fence >= math.MaxUint64-1 {
		s.unknown = true
		s.deps.Gate.Unlock()
		return nil, Unsettled
	}
	if s.root.Device == 0 || s.root.Inode == 0 {
		s.deps.Gate.Unlock()
		return nil, Unavailable
	}
	turns, err := s.retirementTurns()
	if err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	write := port.RetirementWrite{Scope: s.scope, Root: s.root, PreviousRevision: s.revision, Revision: s.revision + 1, Turns: turns}
	retained := make([]retirementResult, 0, len(turns))
	for _, item := range turns {
		if item.ResultPublication != (port.ResultPublication{}) {
			h := s.handles[item.Binding.OperationID]
			retained = append(retained, retirementResult{receipt: *h.retained, text: h.output.Text()})
		}
	}
	s.fence++
	fence := s.fence
	s.retiring = true
	s.deps.Gate.Unlock()

	// Durable bytes must still be readable at their exact physical publication
	// before a clean retirement can describe them. IO never holds the live gate;
	// the monotonic retiring state prevents new observation or result mutation.
	if err := s.verifyRetirementResults(ctx, retained); err != nil {
		s.deps.Gate.Lock()
		s.unknown = true
		s.deps.Gate.Unlock()
		return nil, Unsettled
	}
	s.deps.Gate.Lock()
	current := ctx.Err() == nil && !s.unknown && s.retiring && s.pending == nil && s.fence == fence && s.revision == write.PreviousRevision
	if !current {
		s.unknown = true
	}
	s.deps.Gate.Unlock()
	if !current {
		return nil, Unsettled
	}

	// The journal receives its own copy; a port cannot mutate the owner's proof.
	receipt, err := journal.Retire(ctx, port.CopyRetirement(write))
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if ctx.Err() != nil || s.unknown || !s.retiring || s.pending != nil || s.fence != fence || s.revision != write.PreviousRevision || err != nil || receipt == nil || !port.SameRetirement(receipt.Write, write) || receipt.PublicationDigest == ([32]byte{}) {
		s.unknown = true
		return nil, Unsettled
	}
	if write.Revision == math.MaxUint64 || fence == math.MaxUint64 {
		s.unknown = true
		return nil, Unsettled
	}
	known := *receipt
	known.Write = port.CopyRetirement(write)
	s.revision, s.retiring = write.Revision, false
	s.retired = &retirementProof{owner: s, receipt: known}
	return s.retired, nil
}

type retirementResult struct {
	receipt port.RetainReceipt
	text    string
}

func (s *Service) verifyRetirementResults(ctx context.Context, retained []retirementResult) error {
	if len(retained) == 0 {
		return nil
	}
	store, ok := s.deps.Results.(port.DurableResults)
	if !ok {
		return Unavailable
	}
	for _, item := range retained {
		expected := item.receipt
		if !expected.Publication.Valid() || expected.Publication.Root != s.root {
			return Mismatch
		}
		read, err := store.Read(ctx, port.ResultRead{Binding: expected.Binding, Result: expected.Result, Publication: expected.Publication})
		if err != nil || ctx.Err() != nil || read == nil || read.Binding != expected.Binding || read.Result != expected.Result || read.Conversation != expected.Conversation || len(read.Payload) != expected.Bytes || !read.Conversation.Valid(read.Result, read.Payload) {
			return Unsettled
		}
		if expected.Conversation != (port.RetainedConversation{}) && string(read.Payload) != item.text {
			return Mismatch
		}
	}
	return nil
}

func (s *Service) retirementTurns() ([]port.RetirementTurn, error) {
	ids := make([]string, 0, len(s.handles))
	for id := range s.handles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]port.RetirementTurn, 0, len(ids))
	for _, id := range ids {
		h := s.handles[id]
		if h.observing {
			return nil, Busy
		}
		view, err := s.queue.Snapshot(identity(h.fixed))
		if err != nil || !h.closed || !view.HasResult || view.Phase == turn.Unknown || view.Result.Outcome == turn.UnknownOutcome || !view.DeliveryAcknowledged || !view.LifecycleSettled || view.OutstandingCallID != "" || h.unresolvedCallID != "" || h.ackRevision == 0 {
			return nil, Unsettled
		}
		if view.Reserved {
			if h.releasedRevision == 0 || h.settledRevision == 0 {
				return nil, Unsettled
			}
			if view.Bound {
				if !h.quiescence.Confirmed || h.quiescence.Binding != view.Binding || h.quiescence.ResultID != view.Result.ID || h.quiescence.Sequence <= view.LastSequence || h.disposal != (turn.DisposalEvidence{}) {
					return nil, Unsettled
				}
			} else if !h.disposal.Confirmed || h.disposal.Reservation != view.Reservation || h.disposal.ResultID != view.Result.ID || h.quiescence != (turn.QuiescenceEvidence{}) {
				return nil, Unsettled
			}
		} else if view.SendIntent || view.Result.Outcome != turn.CancelledOutcome || view.Result.Code != "NOT_DISPATCHED" || h.settledRevision != 0 || h.releasedRevision != 0 || h.quiescence != (turn.QuiescenceEvidence{}) || h.disposal != (turn.DisposalEvidence{}) {
			return nil, Unsettled
		}
		var publication port.ResultPublication
		if h.retained != nil {
			publication = h.retained.Publication
			if publication != (port.ResultPublication{}) && view.Result.Outcome == turn.Completed {
				metadata := h.retained.Conversation
				if h.conversation == nil || !metadata.Complete || metadata.ProviderConversationID != view.Binding.Document.ConversationID {
					return nil, Unsettled
				}
			}
		}
		out = append(out, port.RetirementTurn{Binding: h.fixed, Snapshot: view, AcknowledgedRevision: h.ackRevision, SettledRevision: h.settledRevision, ReleasedRevision: h.releasedRevision, Quiescence: h.quiescence, Disposal: h.disposal, ResultPublication: publication})
	}
	return out, nil
}

type retirementProof struct {
	owner   *Service
	receipt port.RetirementReceipt
}

var _ port.CleanRetirement = (*retirementProof)(nil)

func (p *retirementProof) WithRetirement(ctx context.Context, inspect func(*port.RetirementReceipt) error) error {
	if p == nil || p.owner == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	s := p.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if ctx.Err() != nil {
		return Cancelled
	}
	if s.retired != p || s.unknown || s.retiring || s.pending != nil {
		return Unsettled
	}
	copy := p.receipt
	copy.Write = port.CopyRetirement(copy.Write)
	if err := inspect(&copy); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}
