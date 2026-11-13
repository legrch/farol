package lifecycle

import (
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Reject irrelevant fields as well as crossed route evidence before any IO.
func apply(q *turn.Queue, fixed port.TurnBinding, c Change) (turn.Snapshot, error) {
	i := identity(fixed)
	canonical := Change{Action: c.Action}
	switch c.Action {
	case Enqueue:
	case Accept, AwaitOwner, Resume:
		canonical.Binding = c.Binding
	case Delta:
		canonical.Binding, canonical.Sequence = c.Binding, c.Sequence
	case RequestComputer, ResolveComputer:
		canonical.Binding, canonical.CallID = c.Binding, c.CallID
	case Acknowledge:
		canonical.ResultID = c.ResultID
	case Settle:
		canonical.Quiescence = c.Quiescence
	case SettlePrepared:
		canonical.Disposal = c.Disposal
	case Release:
		canonical.Reservation = c.Reservation
	default:
		return turn.Snapshot{}, Invalid
	}
	if canonical != c {
		return turn.Snapshot{}, Invalid
	}
	if c.Binding != (turn.Binding{}) && c.Binding.Reservation.Identity != i {
		return turn.Snapshot{}, Mismatch
	}
	if c.Quiescence != (turn.QuiescenceEvidence{}) && c.Quiescence.Binding.Reservation.Identity != i {
		return turn.Snapshot{}, Mismatch
	}
	if c.Disposal != (turn.DisposalEvidence{}) && c.Disposal.Reservation.Identity != i {
		return turn.Snapshot{}, Mismatch
	}
	if c.Reservation != (turn.Reservation{}) && c.Reservation.Identity != i {
		return turn.Snapshot{}, Mismatch
	}
	switch c.Action {
	case Enqueue:
		return q.Enqueue(i)
	case Accept:
		return q.Accept(c.Binding)
	case AwaitOwner:
		return q.AwaitOwner(c.Binding)
	case Resume:
		return q.Resume(c.Binding)
	case Delta:
		return q.Delta(c.Binding, c.Sequence)
	case RequestComputer:
		return q.RequestComputer(c.Binding, c.CallID)
	case ResolveComputer:
		return q.ResolveComputer(c.Binding, c.CallID)
	case Acknowledge:
		return q.Acknowledge(i, c.ResultID)
	case Settle:
		return q.Settle(c.Quiescence)
	case SettlePrepared:
		return q.SettlePrepared(c.Disposal)
	case Release:
		if err := q.Release(c.Reservation); err != nil {
			return turn.Snapshot{}, err
		}
		return q.Snapshot(i)
	}
	return turn.Snapshot{}, Invalid
}
