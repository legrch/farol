// Package parent checks a trusted original parent against its retained Chat owner.
// It owns no admission, lifecycle, journal, provider or delivery operation.
package parent

import (
	"context"
	"errors"

	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/task/domain"
)

// Binding is Task's independent projection of the selected Chat admission. It is
// the parent's Chat binding, not the delegated coding task's admission binding.
type Binding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

func (b Binding) valid() bool {
	return task.ID(b.OwnerID) && task.ID(b.SessionID) && task.ID(b.TaskID) &&
		b.TaskEpoch != 0 && task.ID(b.ParticipantID) && task.ID(b.TurnID)
}

// Selection is an explicit trusted Root association. Parent's external thread/
// turn IDs are independent of Chat TaskID/TurnID; no equality is inferred. Root
// must establish that this original parent belongs to the actual retained facade.
type Selection struct {
	Parent  task.Parent
	Binding Binding
}

// The private contract seam permits labelled CPU doubles only. Public New takes
// the actual selected published facade, never a request-selected owner lookup.
type current interface {
	WithCurrent(context.Context, func(*chatct.TaskBinding) error) error
}

type Peer struct {
	current  current
	selected Selection
}

// New captures values without inspecting, activating or restoring an owner.
// This peer supplies only the parent part of Authority, not Resolve or Recheck.
func New(owner *chatct.Current, selected Selection) (*Peer, error) {
	if owner == nil {
		return nil, task.ErrUnavailable
	}
	return newPeer(owner, selected)
}

func newPeer(owner current, selected Selection) (*Peer, error) {
	if owner == nil {
		return nil, task.ErrUnavailable
	}
	if !task.ID(selected.Parent.ThreadID) || !task.ID(selected.Parent.TurnID) || !selected.Binding.valid() {
		return nil, task.ErrInvalid
	}
	return &Peer{current: owner, selected: selected}, nil
}

func classify(err error) error {
	var f *chatct.Failure
	if errors.As(err, &f) && f != nil {
		switch f.Code {
		case "CHAT_ADMISSION_MISMATCH":
			return task.ErrIdentity
		case "CHAT_ADMISSION_CANCELLED":
			return context.Canceled
		}
	}
	// Raw owner/storage diagnostics never escape the Task consumer vocabulary.
	return task.ErrUnavailable
}

// RecheckParent observes the same live owner once, on every call. The callback
// performs value checks only while Chat holds its gate: no IO, reentry or effects.
// Success is a current read, not a delivery permit across later awaited work.
func (p *Peer) RecheckParent(ctx context.Context, requested task.Parent) error {
	if ctx == nil {
		return task.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if p == nil || p.current == nil {
		return task.ErrUnavailable
	}
	if requested != p.selected.Parent {
		return task.ErrIdentity
	}
	calls := 0
	var rejected, broken error
	err := p.current.WithCurrent(ctx, func(b *chatct.TaskBinding) error {
		calls++
		if calls != 1 {
			broken = task.ErrUnavailable
			return broken
		}
		if err := ctx.Err(); err != nil {
			rejected = err
			return rejected
		}
		if b == nil {
			rejected = task.ErrState
			return rejected
		}
		// Explicit DTO mapping; no neighbor domain/app types or embedded aliases.
		actual := Binding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID,
			TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
		if !actual.valid() || actual != p.selected.Binding {
			rejected = task.ErrIdentity
		}
		return rejected
	})
	if err := ctx.Err(); err != nil {
		return err
	}
	if calls > 1 || broken != nil {
		return task.ErrUnavailable
	}
	// Preserve rejection even if a broken owner ignores its callback's error.
	if rejected != nil {
		return rejected
	}
	if err != nil {
		return classify(err)
	}
	if calls != 1 {
		return task.ErrUnavailable
	}
	return nil
}
