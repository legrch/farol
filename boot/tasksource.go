package boot

import (
	"context"

	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	parentpeer "github.com/legrch/farol/modules/task/infra/peer/parent"
)

// CurrentCodexTaskSource is trusted Root composition, not a renderer or wire
// grant. Its current reader must read the actual settings owner on every call;
// native startup still needs the qualified host witness and exclusive journal.
type CurrentCodexTaskSource struct {
	Authority  codexclient.SelectionAuthorityOptions
	Delivery   port.Delivery
	ChatHandle string
	Parent     controlct.Parent
}

// BeginCurrentCodex joins Task's immutable selection authority to the actual
// retained Chat parent. It uses the existing selector, owner and lazy client;
// no secondary Task engine, catalogue, account or execution policy is created.
func (s *TaskSelector) BeginCurrentCodex(ctx context.Context, input CurrentCodexTaskSource) (*wire.TaskHandle, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	selected, err := codexclient.NewSelectionAuthority(input.Authority)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	a := &codexTaskSourceAuthority{selection: selected, profile: s.surface.profile, original: input.Parent}
	a, err = a.selectParent(ctx, input.ChatHandle)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	return s.BeginCodex(ctx, CodexTaskSource{
		Selection: input.Authority.Selected.Selection,
		Followup:  input.Authority.Selected.Followup,
		Authority: a, Delivery: input.Delivery,
		ChatHandle: input.ChatHandle, Parent: input.Parent,
	})
}

// Each Task turn retains its own actual parent peer. Only the immutable
// selection authority is shared across follow-up; the original client's grant
// callback never needs rebinding. Parent IDs remain external lineage values.
type codexTaskSourceAuthority struct {
	selection *codexclient.SelectionAuthority
	profile   *TaskProfile
	original  controlct.Parent
	chat      conversation.Binding
	parent    *parentpeer.Peer
}

func (a *codexTaskSourceAuthority) selectParent(ctx context.Context, handle string) (*codexTaskSourceAuthority, error) {
	if a == nil || a.selection == nil || a.profile == nil {
		return nil, task.ErrUnavailable
	}
	if err := a.profile.available(ctx); err != nil {
		return nil, err
	}
	h, err := a.profile.chat.get(handle)
	if err != nil || (a.parent != nil && !taskSelectorSameChatTask(a.chat, h.binding)) {
		return nil, task.ErrIdentity
	}
	current, err := h.handle.Admission()
	if err != nil {
		return nil, task.ErrUnavailable
	}
	cb := h.binding
	peer, err := parentpeer.New(current, parentpeer.Selection{
		Parent: task.Parent{ThreadID: a.original.ThreadID, TurnID: a.original.TurnID},
		Binding: parentpeer.Binding{OwnerID: cb.OwnerID, SessionID: cb.SessionID,
			TaskID: cb.TaskID, TaskEpoch: cb.TaskEpoch, ParticipantID: cb.ParticipantID, TurnID: cb.TurnID},
	})
	if err != nil {
		return nil, err
	}
	next := *a
	next.chat, next.parent = cb, peer
	if err := next.RecheckParent(ctx, task.Parent{ThreadID: a.original.ThreadID, TurnID: a.original.TurnID}); err != nil {
		return nil, err
	}
	return &next, nil
}

func (a *codexTaskSourceAuthority) Resolve(ctx context.Context, s port.Selection) (task.Binding, error) {
	return a.selection.Resolve(ctx, s)
}
func (a *codexTaskSourceAuthority) Recheck(ctx context.Context, b task.Binding) error {
	return a.selection.Recheck(ctx, b)
}
func (a *codexTaskSourceAuthority) RecheckParent(ctx context.Context, parent task.Parent) error {
	if a == nil || a.profile == nil || a.parent == nil {
		return task.ErrUnavailable
	}
	if err := a.profile.available(ctx); err != nil {
		return err
	}
	if err := a.parent.RecheckParent(ctx, parent); err != nil {
		return err
	}
	return a.profile.available(ctx)
}

var _ port.Authority = (*codexTaskSourceAuthority)(nil)
