package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// AdmissionOwner captures the same successful lifecycle handle. The projection
// rechecks its current state on every Computer phase; this is not a new grant.
func (c *Conversation) AdmissionOwner() port.BoundTurn {
	if c == nil || c.handle == nil {
		return nil
	}
	return c.handle
}

// ComputerCall is minted only after RequestComputer's known durable commit.
// Root binds the existing relay operation to this opaque object, dispatches its
// selected Computer capability once, and supplies its exact host return ACK.
// There is no execution, result submission, retry or browser method here.
type ComputerCall struct {
	conversation *Conversation
	correlation  port.ComputerContext
	callID       string
}

func (c *Conversation) ComputerContext(ctx context.Context) (*port.ComputerContext, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return nil, Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.available(ctx); err != nil {
		return nil, err
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return nil, err
	}
	current, err := c.computerContext(view)
	if err != nil {
		return nil, err
	}
	if view.OutstandingCallID != "" || h.unresolvedCallID != "" {
		return nil, Unsettled
	}
	return &current, nil
}

// computerContext is called only under the actual owner's gate. Accepted IDs
// come from observations, never from a relay body or the configured prompt.
func (c *Conversation) computerContext(view turn.Snapshot) (port.ComputerContext, error) {
	s, h := c.owner, c.handle
	if s.handles[h.fixed.OperationID] != h || h.conversation != c || h.fixed.TaskEpoch == 0 {
		return port.ComputerContext{}, Mismatch
	}
	if h.closed || h.observing || h.releasedRevision != 0 || !view.Bound || !view.SendIntent || !view.Accepted || view.Phase != turn.Running || view.HasResult || !h.output.Accepted || h.output.Complete {
		return port.ComputerContext{}, Unsettled
	}
	if !h.target.Selection.ToolsEnabled || h.verification.EvidenceID == "" || h.verification.Pinned != h.target.Selection {
		return port.ComputerContext{}, Unavailable
	}
	binding := browserBinding(view.Binding)
	if binding.ProviderState != port.ProviderBound || binding.ConversationID == "" || c.providerID != binding.ConversationID || s.providerOwners[binding.ConversationID] != h.fixed || !validID(h.output.UserID) || !validID(h.output.ReplyID) || h.sourceSequence == 0 {
		return port.ComputerContext{}, Unsettled
	}
	return port.ComputerContext{Binding: h.fixed, Browser: binding, UserTurnID: h.output.UserID, ReplyID: h.output.ReplyID, SourceSequence: h.sourceSequence}, nil
}

func (c *Conversation) BeginComputer(ctx context.Context, correlation port.ComputerContext, callID string) (*ComputerCall, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil || !validID(callID) {
		return nil, Invalid
	}
	s, h := c.owner, c.handle
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		current, err := c.computerContext(before)
		if err != nil {
			return port.JournalEntry{}, err
		}
		if current != correlation {
			return port.JournalEntry{}, Mismatch
		}
		if h.unresolvedCallID != "" {
			return port.JournalEntry{}, Unsettled
		}
		after, err := q.RequestComputer(before.Binding, callID)
		return port.JournalEntry{Binding: h.fixed, Kind: "request-computer", Before: before, After: after, CallID: callID, Closed: h.closed}, err
	})
	if err != nil {
		return nil, err
	}
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	return &ComputerCall{conversation: c, correlation: correlation, callID: callID}, nil
}

// AcknowledgeReturn resolves only this exact outstanding call. Missing/lost ACK
// performs no write: the call and lease remain outstanding, preventing reexecution
// and Send. A later explicit exact ACK can settle it; reading history cannot.
// This ACK is host result-return evidence, NOT provider consumption evidence.
func (call *ComputerCall) AcknowledgeReturn(ctx context.Context, ack *port.ComputerReturn) error {
	if call == nil || call.conversation == nil || ctx == nil {
		return Invalid
	}
	if ack == nil || !ack.Returned {
		return Unsettled
	}
	if ack.Context != call.correlation || ack.CallID != call.callID {
		return Mismatch
	}
	c := call.conversation
	s, h := c.owner, c.handle
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		current, err := c.computerContext(before)
		if err != nil {
			return port.JournalEntry{}, err
		}
		// Content-free status observations may advance the source watermark while
		// paused. The captured ACK scope stays immutable; physical/logical IDs do not.
		if current.SourceSequence < call.correlation.SourceSequence {
			return port.JournalEntry{}, Mismatch
		}
		current.SourceSequence = call.correlation.SourceSequence
		if current != call.correlation || before.OutstandingCallID != call.callID || h.unresolvedCallID != call.callID {
			return port.JournalEntry{}, Mismatch
		}
		after, err := q.ResolveComputer(before.Binding, call.callID)
		return port.JournalEntry{Binding: h.fixed, Kind: "resolve-computer", Before: before, After: after, CallID: call.callID, Closed: h.closed}, err
	})
	if err != nil {
		return err
	}
	return s.commit(ctx, m, true)
}
